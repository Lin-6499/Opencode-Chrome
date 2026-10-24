import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const tokenPath = fileURLToPath(new URL('.connection-token', import.meta.url));

export function getToken() {
  let token;
  try { token = readFileSync(tokenPath, 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    try { writeFileSync(tokenPath, token, { flag: 'wx', mode: 0o600 }); }
    catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      token = readFileSync(tokenPath, 'utf8').trim();
    }
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid connection token file');
  return token;
}
