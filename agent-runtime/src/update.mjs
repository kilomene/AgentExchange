// AUTO-UPDATE — the moment the owner ships a release, every agent updates
// itself. A release is a manifest {version, sha256, notes} + package,
// signed with the OWNER's key (charter.mjs). Peers host releases for each
// other, so an update reaches an agent from ANY live server in the mesh.
// An unsigned or badly-signed package is never installed — the signature
// is checked before a single byte is swapped, and the old version is kept
// for rollback. State lives in the vault, outside the app directory, so an
// update never touches the agent's memory, queue, or files.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWNER_PUBKEY_B64, RUNTIME_VERSION } from "./charter.mjs";
import { verifyObj } from "./sign.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export class Updater {
  constructor({ vault, config, appDir, log }) {
    this.vault = vault;
    this.config = config;   // { updateSources: [baseUrl...] } — peers or canonical hosts
    this.appDir = appDir;   // the installed app directory (swapped atomically)
    this.log = log || (() => {});
    this.checking = false;
  }

  async #fetchManifest(source) {
    try {
      if (source.startsWith("file://")) {
        const p = source.replace("file://", "");
        return { manifest: JSON.parse(readFileSync(join(p, "manifest.json"), "utf8")), base: p, isFile: true };
      }
      const res = await fetch(`${source}/release/manifest.json`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return { manifest: await res.json(), base: source, isFile: false };
    } catch { return null; }
  }

  async #fetchPackage(source, isFile) {
    if (isFile) return readFileSync(join(source, "package.tgz"));
    const res = await fetch(`${source}/release/package`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`package fetch ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Returns true if an update was applied (caller should restart).
  async checkAndApply() {
    if (this.checking) return false;
    this.checking = true;
    try {
      for (const source of this.config.updateSources || []) {
        const got = await this.#fetchManifest(source);
        if (!got) continue;
        const { sig, ...manifest } = got.manifest;
        if (!verifyObj(OWNER_PUBKEY_B64, manifest, sig || "")) {
          this.log(`update: manifest from ${source} NOT owner-signed — ignored`);
          this.vault.journal("update_rejected", { source, reason: "bad signature" });
          continue;
        }
        if (!(manifest.version > RUNTIME_VERSION)) continue;
        this.log(`update: owner release v${manifest.version} found at ${source} (running v${RUNTIME_VERSION})`);
        const pkg = await this.#fetchPackage(got.base, got.isFile);
        if (sha256(pkg) !== manifest.sha256) {
          this.vault.journal("update_rejected", { source, reason: "sha256 mismatch" });
          this.log("update: package sha256 mismatch — NOT installing");
          return false;
        }
        // Stage, verify, swap. The vault (memory/state) is never in appDir.
        const stage = `${this.appDir}.new-${manifest.version}`;
        rmSync(stage, { recursive: true, force: true });
        mkdirSync(stage, { recursive: true });
        const tmpPkg = join(this.vault.dir, `update-${manifest.version}.tgz`);
        writeFileSync(tmpPkg, pkg);
        this.vault.putBuffer(pkg, `release-${manifest.version}.tgz`);
        execFileSync("tar", ["--no-same-owner", "-xzf", tmpPkg, "-C", stage]);
        if (!existsSync(join(stage, "src", "daemon.mjs"))) throw new Error("package missing src/daemon.mjs");
        const prev = `${this.appDir}.prev-${RUNTIME_VERSION}`;
        rmSync(prev, { recursive: true, force: true });
        renameSync(this.appDir, prev);
        try {
          renameSync(stage, this.appDir);
        } catch (e) {
          renameSync(prev, this.appDir);   // rollback
          throw e;
        }
        this.vault.journal("updated", { from: RUNTIME_VERSION, to: manifest.version, source });
        this.log(`update: v${manifest.version} installed — restarting into the new version`);
        return true;
      }
      return false;
    } catch (e) {
      this.log(`update: check failed: ${e.message}`);
      this.vault.journal("update_error", { error: e.message });
      return false;
    } finally {
      this.checking = false;
    }
  }
}
