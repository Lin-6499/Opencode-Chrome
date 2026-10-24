// Event names/data fields verified against OpenCode 2.1.3 public event types.
const terminal = new Set(['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.deleted']);
export function cleanupEvent(event) {
  if (!terminal.has(event?.type) || typeof event.data?.sessionID !== 'string' || !Number.isFinite(event.created)) return null;
  return { owner: `session:${event.data.sessionID}`, endedAt: event.created };
}
export async function consumeLifecycle(events, cleanup, report = () => {}) {
  for await (const event of events) {
    const request = cleanupEvent(event);
    if (!request) continue;
    try {
      const result = await cleanup(request.owner, request.endedAt);
      if (result?.matched && !result.cleaned) report('Task ended but tab-group cleanup failed; inspect Chrome Control status.');
    } catch { report('Chrome Control lifecycle cleanup unavailable; manual end_task and idle cleanup remain available.'); }
  }
}
