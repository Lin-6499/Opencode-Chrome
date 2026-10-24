import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Chrome uses the side panel, with correctly sized OpenCode PNG icons', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'OpenCode Chrome');
  assert.equal(manifest.permissions.includes('sidePanel'), true);
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  for (const [size, path] of Object.entries(manifest.icons)) {
    const bytes = readFileSync(new URL(`../extension/${path}`, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), Number(size));
    assert.equal(bytes.readUInt32BE(20), Number(size));
  }
});
