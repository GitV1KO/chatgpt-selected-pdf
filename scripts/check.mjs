import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
assert.equal(manifest.host_permissions, undefined);
for (const file of await readdir(new URL('../extension/', import.meta.url))) {
  if (!file.endsWith('.js')) continue;
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(`../extension/${file}`, import.meta.url))], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}
console.log('Manifest scope and JavaScript syntax OK.');
