import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const chatDirectory = fileURLToPath(new URL('../', import.meta.url));
export const validSessionID = value => typeof value === 'string' && /^ses_[a-zA-Z0-9_-]{1,100}$/.test(value);
export const belongsHere = session => path.resolve(session.location?.directory || '').toLowerCase() === path.resolve(chatDirectory).toLowerCase();
export function fail(message) { const error = new Error(message); error.publicMessage = message; throw error; }

export async function localConnection() {
  const { Service } = await import('@opencode/client/service');
  const endpoint = await Service.discover();
  if (!endpoint) fail('未发现本机 OpenCode 服务，请先打开 OpenCode。');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint.url).hostname)) fail('仅允许连接当前主机的 OpenCode 服务。');
  const headers = Service.headers(endpoint);
  const api = async (method, route, body) => {
    const response = await fetch(new URL(route, endpoint.url), {
      method, headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) fail(`OpenCode 请求失败（HTTP ${response.status}）。请检查本机服务和权限。`);
    if (response.status === 204) return {};
    return response.json();
  };
  return { endpoint, headers, api };
}

export function publicError(error) {
  if (!error) return undefined;
  const raw = typeof error === 'string' ? error : typeof error.message === 'string' ? error.message : '任务执行失败，请检查模型配置或工具权限。';
  return raw.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/sk-[a-zA-Z0-9_-]{8,}/g, '[redacted]').replace(/https?:\/\/[^\s"']+/g, '[URL]').slice(0, 500);
}
