// THE VAULT — retentive memory and undeletable file storage for the runtime.
//
// Layout inside the vault directory:
//   journal.jsonl   append-only episodic memory: every event and action,
//                   fsynced. The daemon replays it to resume after any crash
//                   or reboot — it continues from exactly where it stopped.
//   state.json      working state (bids, contracts, delivered, cursors),
//                   written atomically (tmp + rename) and snapshotted.
//   memory.json     long-term memory: per-agent lifetime stats and notes.
//   objects/        content-addressed blobs (sha256). Every file the runtime
//                   produces — deliverables, state snapshots, relayed
//                   packages — is stored here by hash. Deleting a working
//                   file NEVER erases it: `restore` brings it back.
//   manifest.json   path -> hash index of vaulted files.
//   wake/           work queue for the agent's brain (awarded jobs to do).
//   work/           deliverables in progress / done markers.
//   relay/          store-and-forward envelopes held for offline peers.
//   heartbeat.json  written every heartbeat tick (3s): proof of life.
//
// Nothing in the vault is ever overwritten in place except the two atomic
// JSON files, and even those are snapshotted to objects/ on every change.
import { createHash } from "node:crypto";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, writeFileSync, copyFileSync, statSync,
} from "node:fs";
import { join, basename } from "node:path";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export class Vault {
  constructor(dir) {
    this.dir = dir;
    for (const sub of ["objects", "wake", "work", "relay"]) mkdirSync(join(dir, sub), { recursive: true });
    this.journalPath = join(dir, "journal.jsonl");
    if (!existsSync(this.journalPath)) writeFileSync(this.journalPath, "");
    this.manifest = this.#readJson("manifest.json", {});
    this.state = this.#readJson("state.json", { agents: {}, lastEventAt: 0, bootedAt: 0 });
    this.memory = this.#readJson("memory.json", { agents: {}, notes: [] });
  }

  #readJson(name, fallback) {
    const p = join(this.dir, name);
    if (!existsSync(p)) return structuredClone(fallback);
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return structuredClone(fallback); }
  }

  #writeJsonAtomic(name, obj) {
    const p = join(this.dir, name);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(obj, null, 1));
    renameSync(tmp, p);
  }

  // Episodic memory: one line per event/action, fsynced before returning.
  journal(kind, data = {}) {
    const line = JSON.stringify({ ts: Math.floor(Date.now() / 1000), kind, ...data }) + "\n";
    appendFileSync(this.journalPath, line);
    return line;
  }

  journalTail(n = 200) {
    const lines = readFileSync(this.journalPath, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  saveState() {
    this.#writeJsonAtomic("state.json", this.state);
    this.putBuffer(Buffer.from(JSON.stringify(this.state)), "state-snapshot.json", { quiet: true });
  }

  saveMemory() {
    this.#writeJsonAtomic("memory.json", this.memory);
    this.putBuffer(Buffer.from(JSON.stringify(this.memory)), "memory-snapshot.json", { quiet: true });
  }

  // Store content by hash; record the friendly path in the manifest.
  putBuffer(buf, name, opts = {}) {
    const hash = sha256(buf);
    const objPath = join(this.dir, "objects", hash);
    if (!existsSync(objPath)) writeFileSync(objPath, buf);
    if (name) {
      this.manifest[name] = { hash, size: buf.length, ts: Math.floor(Date.now() / 1000) };
      this.#writeJsonAtomic("manifest.json", this.manifest);
    }
    if (!opts.quiet) this.journal("vault_put", { name, hash, size: buf.length });
    return hash;
  }

  putFile(filePath, name) {
    const buf = readFileSync(filePath);
    return this.putBuffer(buf, name || basename(filePath));
  }

  hasObject(hash) { return existsSync(join(this.dir, "objects", hash)); }

  readObject(hash) { return readFileSync(join(this.dir, "objects", hash)); }

  // Bring a vaulted file back — even if the original was deleted.
  restore(name, destPath) {
    const entry = this.manifest[name];
    if (!entry) throw new Error(`not in vault manifest: ${name}`);
    copyFileSync(join(this.dir, "objects", entry.hash), destPath);
    this.journal("vault_restore", { name, hash: entry.hash, dest: destPath });
    return entry;
  }

  listManifest() { return { ...this.manifest }; }

  // ---- wake queue (work for the agent's brain) ----
  wakePath(jobId) { return join(this.dir, "wake", `job-${jobId}.json`); }

  enqueueWake(item) {
    const p = this.wakePath(item.job_id);
    if (!existsSync(p)) {
      writeFileSync(p, JSON.stringify(item, null, 1));
      this.journal("wake_enqueued", { job_id: item.job_id, agent: item.agent });
    }
    return p;
  }

  pendingWake() {
    return readdirSync(join(this.dir, "wake"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(readFileSync(join(this.dir, "wake", f), "utf8")); } catch { return null; } })
      .filter(Boolean);
  }

  clearWake(jobId) {
    const p = this.wakePath(jobId);
    if (existsSync(p)) { renameSync(p, p + ".done"); this.journal("wake_cleared", { job_id: jobId }); }
  }

  heartbeat(obj) {
    this.#writeJsonAtomic("heartbeat.json", { ...obj, ts: Math.floor(Date.now() / 1000) });
  }

  size() {
    let files = 0;
    try { files = readdirSync(join(this.dir, "objects")).length; } catch { /* new vault */ }
    let journalBytes = 0;
    try { journalBytes = statSync(this.journalPath).size; } catch { /* ignore */ }
    return { objects: files, journalBytes };
  }
}
