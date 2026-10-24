export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > 1024 * 1024) throw new Error('Native message too large');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export function decodeMessage(buffer) {
  if (buffer.length < 4) return null;
  const size = buffer.readUInt32LE();
  if (size < 2 || size > 65536) throw new Error('Invalid native message size');
  if (buffer.length < size + 4) return null;
  return { value: JSON.parse(buffer.subarray(4, size + 4).toString('utf8')), bytes: size + 4 };
}
