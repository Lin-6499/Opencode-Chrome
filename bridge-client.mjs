import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { getToken } from './credentials.mjs';

export async function requestBridge(method, args, owner, { signal, port = Number(process.env.CHROME_CONTROL_PORT || 17891) } = {}) {
  if (signal?.aborted) throw new Error('Lifecycle request aborted');
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-control://local' });
  const id = randomUUID();
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(new Error('Lifecycle request aborted'));
      const timer = setTimeout(() => finish(new Error('Lifecycle bridge request timed out')), 12000);
      signal?.addEventListener('abort', abort, { once: true });
      ws.on('open', () => {
        try { ws.send(JSON.stringify({ type: 'hello', role: 'mcp', token: getToken() })); }
        catch { finish(new Error('Local pairing credentials unavailable')); }
      });
      ws.on('error', () => finish(new Error('Chrome Control bridge unavailable')));
      ws.on('close', () => finish(new Error('Chrome Control bridge disconnected')));
      ws.on('message', raw => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'ready') {
            if (data.protocol !== 4) { finish(new Error('Chrome Control bridge needs restart')); return; }
            ws.send(JSON.stringify({ id, method, args, owner }));
          } else if (data.id === id) finish(data.error ? new Error(data.error) : undefined, data.result);
        } catch { finish(new Error('Invalid bridge response')); }
      });
    });
  } finally { ws.close(); }
}
