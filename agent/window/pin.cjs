'use strict';
// Windows keeps its current-directory handle open without FILE_SHARE_DELETE.
// One holder at the checked leaf also prevents ancestor rename/deletion on
// Windows. Do not multiply holders by path depth. Stdin EOF releases the cwd
// naturally, including when the owning runtime closes its pipe on shutdown.
const fs = require('node:fs');
const path = require('node:path');
if (process.platform !== 'win32') throw Error('Directory pinning requires Windows');
const cwd = fs.realpathSync(process.cwd());
process.stdout.write(JSON.stringify({ cwd, ino: String(fs.statSync(cwd, { bigint: true }).ino) }) + '\n');
process.stdin.resume();
process.stdin.on('end', () => { process.chdir(path.parse(cwd).root); });
