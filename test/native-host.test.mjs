import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { encodeMessage, decodeMessage } from '../native-protocol.mjs';

const manifestPath = new URL('../native/host.json', import.meta.url);
const installed = process.platform === 'win32' && existsSync(manifestPath);

function invoke(origin, request) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${manifest.path}" "${origin}""`], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    input: encodeMessage(request),
    timeout: 5000,
  });
}
test('installed Windows launcher provides pairing only to a registered origin', { skip: !installed }, () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const result = invoke(manifest.allowed_origins[0], { action: 'pair' });
  assert.equal(result.status, 0, result.stderr?.toString());
  const response = decodeMessage(result.stdout);
  assert.equal(typeof response?.value.token === 'string' && /^[a-f0-9]{64}$/.test(response.value.token), true, 'Expected a valid token (redacted)');
  assert.equal(response.value.endpoint, 'ws://127.0.0.1:17891');
  const denied = invoke('https://example.com/', { action: 'pair' });
  assert.notEqual(denied.status, 0);
  assert.equal(denied.stdout.length, 0);
  const unsupported = invoke(manifest.allowed_origins[0], { action: 'read_file', path: 'anything' });
  assert.notEqual(unsupported.status, 0);
  assert.equal(decodeMessage(unsupported.stdout)?.value.error, 'Local pairing request failed');
});
