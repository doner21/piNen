#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

function resolvePackageFile(request) {
  try {
    return require.resolve(request);
  } catch {
    return undefined;
  }
}

const projectRoot = path.resolve(__dirname, "..");
const tsconfigPath = path.join(projectRoot, "tsconfig.next.json");
const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
const includes = Array.isArray(tsconfig.include) ? tsconfig.include : [];
for (const required of [
  "src/next/**/*.ts",
  "src/action-evidence.ts",
  "src/executor-recovery/budget-estimator.ts",
  "src/worker-execution-constraints.ts",
  "src/worker-no-output-monitor.ts",
  "src/worker-monitor-bootstrap.ts",
  "src/substrate.ts",
  "src/index.ts",
]) {
  if (!includes.includes(required)) {
    console.error(`typecheck-next: tsconfig.next.json must include ${required}`);
    process.exit(1);
  }
}

const tsc = resolvePackageFile("typescript/lib/tsc.js");
if (!tsc) {
  console.error("typecheck-next: TypeScript is unavailable; run npm install in pi-orchestrator-extension");
  process.exit(2);
}

let nodeTypes = resolvePackageFile("@types/node/package.json");
if (!nodeTypes) {
  // Pi package development check: peer dependencies may live beneath the
  // globally installed Pi package rather than this extension checkout.
  try {
    let globalRoot;
    if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
      globalRoot = execFileSync(process.execPath, [process.env.npm_execpath, "root", "-g"], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    } else if (process.platform === "win32" && process.env.APPDATA) {
      globalRoot = path.join(process.env.APPDATA, "npm", "node_modules");
    } else {
      globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
    }
    const candidate = path.join(
      globalRoot,
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "@types",
      "node",
      "package.json",
    );
    if (fs.existsSync(candidate)) nodeTypes = candidate;
  } catch {
    // The explicit error below explains the required setup.
  }
}
if (!nodeTypes) {
  console.error("typecheck-next: @types/node is unavailable; run npm install in pi-orchestrator-extension");
  process.exit(2);
}

const typeRoot = path.dirname(path.dirname(nodeTypes));
const result = spawnSync(process.execPath, [
  tsc,
  "-p",
  tsconfigPath,
  "--typeRoots",
  typeRoot,
], {
  cwd: projectRoot,
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);
