import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, decodeMessage } from '../native-protocol.mjs';

test('native framing uses UTF-8 byte lengths and handles split messages', () => {
  const payload = { action: 'pair', text: '本机自动配对' };
  const frame = encodeMessage(payload);
  assert.equal(frame.readUInt32LE(), Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(decodeMessage(frame.subarray(0, 3)), null);
  assert.equal(decodeMessage(frame.subarray(0, 6)), null);
  assert.deepEqual(decodeMessage(frame), { value: payload, bytes: frame.length });
});
test('native framing rejects invalid lengths and malformed JSON', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(65537);
  assert.throws(() => decodeMessage(header));
  header.writeUInt32LE(0);
  assert.throws(() => decodeMessage(header));
  header.writeUInt32LE(2);
  assert.throws(() => decodeMessage(Buffer.concat([header, Buffer.from('xx')])));
});
