#!/usr/bin/env python3
"""Apply a .sql file to the live Exchange Supabase database.

Direct PG connections from this VM are intercepted by the egress proxy
(fake-IP DNS + SSL interception), so this tunnels through the HTTP proxy
with CONNECT and forwards a local port to db.<ref>.supabase.co:5432 for
psycopg2. Usage: python3 scripts/apply_sql.py <file.sql> [more.sql ...]
Credentials come from .env (never printed).
"""
import os, socket, threading, base64, urllib.parse, sys, psycopg2

env = {}
for line in open(os.path.join(os.path.dirname(__file__), "..", ".env")):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
ref = env["PROJECT_REF"]
target = (f"db.{ref}.supabase.co", 5432)
proxy = urllib.parse.urlparse(os.environ["https_proxy"])
pauth = base64.b64encode(
    f"{urllib.parse.unquote(proxy.username)}:{urllib.parse.unquote(proxy.password)}".encode()
).decode()


def tunnel_sock():
    s = socket.create_connection((proxy.hostname, proxy.port), timeout=20)
    req = (
        f"CONNECT {target[0]}:{target[1]} HTTP/1.1\r\nHost: {target[0]}:{target[1]}\r\n"
        f"Proxy-Authorization: Basic {pauth}\r\nProxy-Connection: keep-alive\r\n\r\n"
    )
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            raise RuntimeError("proxy closed during CONNECT")
        buf += chunk
    status = buf.split(b"\r\n")[0].decode()
    if "200" not in status:
        raise RuntimeError("CONNECT failed: " + status)
    return s


listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", 15434))
listener.listen(4)


def serve():
    while True:
        c, _ = listener.accept()
        try:
            up = tunnel_sock()
        except Exception as e:
            print("tunnel fail:", e)
            c.close()
            continue

        def pump(a, b):
            try:
                while True:
                    d = a.recv(65536)
                    if not d:
                        break
                    b.sendall(d)
            except Exception:
                pass
            try:
                b.shutdown(socket.SHUT_WR)
            except Exception:
                pass

        threading.Thread(target=pump, args=(c, up), daemon=True).start()
        threading.Thread(target=pump, args=(up, c), daemon=True).start()


threading.Thread(target=serve, daemon=True).start()

conn = psycopg2.connect(
    host="127.0.0.1", port=15434, dbname="postgres", user="postgres",
    password=env["SUPABASE_DB_PASSWORD"], sslmode="prefer", connect_timeout=25,
)
conn.autocommit = True
cur = conn.cursor()
for path in sys.argv[1:]:
    cur.execute(open(path).read())
    print("APPLIED", path)
conn.close()
listener.close()
