// Insert recovery functions into index.ts
const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'src', 'index.ts');
const recoveryPath = path.join(__dirname, 'recovery-functions.ts');

let content = fs.readFileSync(indexPath, 'utf8');
const recoveryCode = fs.readFileSync(recoveryPath, 'utf8');

const insertionMarker = 'function toModelOverride(model?: string, provider?: string): RoleModelOverride | undefined {';

if (!content.includes(insertionMarker)) {
  console.error('ERROR: Could not find insertion point');
  process.exit(1);
}

const insertionPoint = content.indexOf(insertionMarker);
content = content.slice(0, insertionPoint) + '\n' + recoveryCode + '\n' + content.slice(insertionPoint);

fs.writeFileSync(indexPath, content);
console.log('Recovery functions inserted successfully at position', insertionPoint);
