import { readFileSync } from 'node:fs';
import { getToken } from './credentials.mjs';
import { decodeMessage, encodeMessage } from './native-protocol.mjs';
import { handleChat } from './native-chat.mjs';
import { watchSession } from './native-stream.mjs';
import { once } from 'node:events';

// Native messaging is restricted by Chrome AND checked here. No webpage or
// content-script request is allowed to invoke this host via the extension.
try {
  const manifest = JSON.parse(readFileSync(new URL('native/host.json', import.meta.url), 'utf8'));
  if (!manifest.allowed_origins?.includes(process.argv[2])) throw new Error('Caller extension is not registered');
  let buffer = Buffer.alloc(0);
  let answered = false;
  let streaming = false;
  const controller = new AbortController();
  const emit = async value => { if (!process.stdout.write(encodeMessage(value))) await once(process.stdout, 'drain'); };
  process.stdout.on('error', () => { controller.abort(); process.exit(0); });
  const timer = setTimeout(() => process.exit(1), 10000);
  process.stdin.on('data', async chunk => {
    if (answered) return;
    let request;
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65540) throw new Error('Request too large');
      const message = decodeMessage(buffer);
      if (!message) return;
      request = message.value;
      answered = true;
      clearTimeout(timer);
      let response;
      if (message.value?.action === 'pair') response = { token: getToken(), endpoint: 'ws://127.0.0.1:17891' };
      else if (message.value?.action === 'chat') response = await handleChat(message.value);
      else if (message.value?.action === 'watch') {
        streaming = true;
        await watchSession(message.value.sessionID, emit, controller.signal);
        process.exit(0);
        return;
      }
      else throw new Error('Unsupported action');
      process.stdout.write(encodeMessage(response), () => process.exit(0));
    } catch (error) {
      if (controller.signal.aborted) { process.exit(0); return; }
      if (streaming) { await emit({ type: 'stream_error', error: error.publicMessage || '实时连接已断开，将改用只读刷新。' }); process.exit(1); return; }
      process.stdout.write(encodeMessage({ error: error.publicMessage || (request?.action === 'chat' ? '本机 OpenCode 请求失败，请检查服务。发送结果不确定时请先刷新会话确认，不要重复提交。' : 'Local pairing request failed') }), () => process.exit(1));
    }
  });
  process.stdin.on('end', () => { controller.abort(); if (streaming || !answered) process.exit(0); });
} catch (error) {
  console.error(`Chrome Control native pairing failed: ${error.message}`);
  process.exit(1);
}
