import { belongsHere, fail, localConnection, publicError, validSessionID } from './native-api.mjs';

export function projectEvent(event, sessionID) {
  const data = event.type === 'form.created' ? { sessionID: event.data?.form?.sessionID } : event.data;
  if (data?.sessionID !== sessionID) return null;
  const base = { eventID: event.id, sessionID, created: event.created, messageID: data.assistantMessageID };
  if (event.type === 'session.text.started') return { ...base, kind: 'text_start', ordinal: data.ordinal };
  if (event.type === 'session.text.delta') {
    if (typeof data.delta !== 'string' || data.delta.length > 16000) return { ...base, kind: 'refresh' };
    return { ...base, kind: 'text_delta', ordinal: data.ordinal, delta: data.delta };
  }
  if (event.type === 'session.text.ended') return { ...base, kind: 'text_end', ordinal: data.ordinal, text: String(data.text || '').slice(0, 32000) };
  if (event.type === 'session.tool.input.started') return { ...base, kind: 'tool', id: data.id, name: String(data.name || '').slice(0, 100), status: 'running' };
  if (event.type === 'session.tool.progress') return { ...base, kind: 'tool', id: data.id, status: 'running', title: typeof data.metadata?.title === 'string' ? data.metadata.title.slice(0, 160) : undefined };
  if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') return { ...base, kind: 'tool', id: data.id, status: event.type.endsWith('failed') ? 'error' : 'completed', error: publicError(data.error) };
  if (event.type === 'session.execution.started') return { ...base, kind: 'busy', busy: true };
  if (['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(event.type)) return { ...base, kind: 'refresh', terminal: true, error: publicError(data.error) };
  if (['session.step.ended', 'session.step.failed', 'session.model.selected', 'session.agent.selected', 'session.renamed', 'permission.asked', 'permission.replied', 'form.created', 'form.replied', 'form.cancelled'].includes(event.type)) return { ...base, kind: 'refresh' };
  return null; // Never expose reasoning, tool input deltas, raw tool results, or native payloads.
}

export async function watchSession(sessionID, emit, signal, injected) {
  if (!validSessionID(sessionID)) fail('无效的会话编号。');
  const connection = injected || await localConnection();
  const session = (await connection.api('GET', `/api/session/${encodeURIComponent(sessionID)}`)).data;
  if (!belongsHere(session)) fail('不能订阅其他项目的会话。');
  let client = connection.client;
  if (!client) {
    const { OpenCode } = await import('@opencode/client');
    client = OpenCode.make({ baseUrl: connection.endpoint.url, headers: connection.headers });
  }
  for await (const event of client.event.subscribe({ signal })) {
    if (signal.aborted) break;
    if (event.type === 'server.connected') { await emit({ type: 'stream_ready', sessionID }); continue; }
    if (event.data?.sessionID === sessionID && event.location?.directory && !belongsHere({ location: event.location })) fail('会话已移至其他项目，实时订阅已停止。');
    if (event.type === 'session.moved' && event.data?.sessionID === sessionID) {
      const current = (await connection.api('GET', `/api/session/${encodeURIComponent(sessionID)}`)).data;
      if (!belongsHere(current)) fail('会话已移至其他项目，实时订阅已停止。');
    }
    const projected = projectEvent(event, sessionID);
    if (projected) await emit({ type: 'event', event: projected });
  }
}
