#!/usr/bin/env node
"use strict";
/** Exact round7 typecheck, runnable through the unchanged isolation wrapper. */
const { spawn } = require("node:child_process");
const path = require("node:path");
const child = spawn("C:/Program Files/nodejs/node.exe", ["node_modules/typescript/lib/tsc.js", "-p", "tsconfig.next.json", "--noEmit"], {
  cwd: path.resolve(__dirname, ".."), stdio: "inherit", windowsHide: true,
});
child.on("error", error => { throw error; });
child.on("close", code => {
  if (code !== 0) throw new Error(`Exact round7 typecheck failed: ${code}`);
  console.log("PASS exact tsc -p tsconfig.next.json --noEmit");
});
