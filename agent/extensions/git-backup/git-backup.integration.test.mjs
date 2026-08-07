import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { DEFAULT_CONFIG, configForRepository, normalizeConfig, pathMatchesDeny, runGitBackup } = await jiti.import("./core.ts");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

const root = mkdtempSync(join(tmpdir(), "pi-git-backup-test-"));
const remote = join(root, "remote.git");
const repo = join(root, "repo");
const runtime = join(root, "runtime");

try {
  mkdirSync(repo, { recursive: true });
  git(root, "init", "--bare", remote);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "tracked.txt"), "baseline\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "baseline");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");

  const sourceHead = git(repo, "rev-parse", "HEAD");
  const sourceIndex = git(repo, "write-tree");
  writeFileSync(join(repo, "tracked.txt"), "baseline\nchanged\n");
  writeFileSync(join(repo, "new-source.ts"), "export const answer = 42;\n");
  writeFileSync(join(repo, ".git", "info", "exclude"), "local-private.txt\n", { flag: "a" });
  writeFileSync(join(repo, "local-private.txt"), "must remain locally excluded\n");

  const config = normalizeConfig({
    ...DEFAULT_CONFIG,
    security: { ...DEFAULT_CONFIG.security, requireGitleaks: false },
    remote: { ...DEFAULT_CONFIG.remote, minIntervalMinutes: 0 },
  });
  const first = await runGitBackup(repo, {
    reason: "integration test",
    runtimeDir: runtime,
    pushRemote: true,
    config,
  });
  assert.equal(first.outcome, "remote-verified", JSON.stringify(first, null, 2));
  assert.equal(first.ok, true);
  assert.equal(first.remoteCommit, first.commit);
  assert.equal(git(repo, "rev-parse", "HEAD"), sourceHead, "working branch HEAD changed");
  assert.equal(git(repo, "write-tree"), sourceIndex, "real index changed");
  assert.equal(readFileSync(join(repo, "tracked.txt"), "utf8"), "baseline\nchanged\n");
  assert.equal(readFileSync(join(repo, "new-source.ts"), "utf8"), "export const answer = 42;\n");
  assert.equal(git(repo, "show", `${first.commit}:tracked.txt`), "baseline\nchanged");
  assert.equal(git(repo, "show", `${first.commit}:new-source.ts`), "export const answer = 42;");
  assert.throws(() => git(repo, "cat-file", "-e", `${first.commit}:local-private.txt`), "real repository .git/info/exclude was ignored by candidate staging");
  assert.equal(git(repo, "ls-remote", "--heads", "origin", first.remoteRef).split(/\s+/)[0], first.commit);

  const second = await runGitBackup(repo, {
    reason: "deduplication test",
    runtimeDir: runtime,
    pushRemote: true,
    config,
  });
  assert.equal(second.outcome, "no-change", JSON.stringify(second, null, 2));
  assert.equal(second.commit, first.commit);

  const objectsBeforeProtectedPath = git(repo, "count-objects", "-v");
  writeFileSync(join(repo, ".env"), "DO_NOT_BACK_UP=placeholder\n");
  const blocked = await runGitBackup(repo, {
    reason: "protected path test",
    runtimeDir: runtime,
    pushRemote: true,
    config,
  });
  assert.equal(blocked.outcome, "blocked", JSON.stringify(blocked, null, 2));
  assert.equal(blocked.error, "protected-paths");
  assert.ok(blocked.blockedPaths.includes(".env"));
  assert.equal(git(repo, "count-objects", "-v"), objectsBeforeProtectedPath, "protected-path candidate wrote into the real object database");
  assert.equal(git(repo, "ls-remote", "--heads", "origin", first.remoteRef).split(/\s+/)[0], first.commit, "blocked run changed remote");

  rmSync(join(repo, ".env"), { force: true });
  const syntheticSecret = randomBytes(32).toString("base64");
  writeFileSync(join(repo, "leak-fixture.txt"), `api_key = "${syntheticSecret}"\n`);
  const scanConfig = normalizeConfig({ ...config, security: { ...config.security, requireGitleaks: true } });
  const objectsBeforeSecretScan = git(repo, "count-objects", "-v");
  const leakBlocked = await runGitBackup(repo, {
    reason: "secret scanner test",
    runtimeDir: runtime,
    pushRemote: true,
    config: scanConfig,
  });
  assert.equal(leakBlocked.outcome, "blocked", JSON.stringify(leakBlocked, null, 2));
  assert.equal(leakBlocked.securityScan, "blocked");
  assert.equal(git(repo, "count-objects", "-v"), objectsBeforeSecretScan, "secret-scanner rejection wrote into the real object database");
  assert.equal(git(repo, "ls-remote", "--heads", "origin", first.remoteRef).split(/\s+/)[0], first.commit, "secret scan failure changed remote");

  const weakened = configForRepository(scanConfig, repo, {
    includeUntracked: false,
    remote: { ...config.remote, name: "attacker", branchPrefix: "main", minIntervalMinutes: 0 },
    security: { ...config.security, requireGitleaks: false, denyGlobs: [], maxChangedFiles: 999999, maxNewBlobBytes: 999999999, maxNewDataBytes: 999999999, maxObjectScanCount: 999999 },
  });
  assert.equal(weakened.includeUntracked, true);
  assert.equal(weakened.remote.name, "origin");
  assert.equal(weakened.remote.branchPrefix, "pi-backup");
  assert.equal(weakened.security.requireGitleaks, true, "project override weakened the scanner hard gate");
  assert.deepEqual(weakened.security.denyGlobs, scanConfig.security.denyGlobs);
  assert.equal(weakened.security.maxChangedFiles, scanConfig.security.maxChangedFiles);

  assert.equal(pathMatchesDeny("nested/.env.production", ["**/.env.*"]), true);
  assert.equal(pathMatchesDeny("src/tokenModel.ts", ["**/railway-token.json"]), false);
  console.log(JSON.stringify({ ok: true, first: first.outcome, second: second.outcome, protectedPath: blocked.outcome, secretScan: leakBlocked.outcome, commit: first.commit }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
