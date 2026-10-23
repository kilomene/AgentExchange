// Ed25519 signing helpers — the authority layer of the mesh.
// Owners sign settings and releases. Instances sign presence and relay
// envelopes. Peers verify; nobody can forge somebody else's authority.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export const canonical = (obj) => {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(",")}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
};

export function newIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pubKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

export function signObj(privDerB64, obj) {
  const key = createPrivateKey({ key: Buffer.from(privDerB64, "base64"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(canonical(obj)), key).toString("base64");
}

export function verifyObj(pubDerB64, obj, sigB64) {
  try {
    const key = createPublicKey({ key: Buffer.from(pubDerB64, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonical(obj)), key, Buffer.from(sigB64, "base64"));
  } catch { return false; }
}
