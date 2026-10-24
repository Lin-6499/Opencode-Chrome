export function applyStreamEvent(records, event, baseline) {
  if (!event.messageID || !['text_start', 'text_delta', 'text_end', 'tool'].includes(event.kind)) return false;
  let record = records.get(event.messageID);
  if (!record) {
    record = { id: event.messageID, created: event.created, prefix: baseline.find(message => message.id === event.messageID)?.text || '', parts: new Map(), tools: new Map(), complete: true };
    records.set(event.messageID, record);
  }
  if (event.kind === 'tool') {
    const old = record.tools.get(event.id) || {};
    record.tools.set(event.id, { ...old, ...Object.fromEntries(Object.entries(event).filter(([key, value]) => ['id', 'name', 'title', 'status', 'error'].includes(key) && value !== undefined)) });
    return true;
  }
  if (event.kind === 'text_start') record.parts.set(event.ordinal, '');
  if (event.kind === 'text_delta') {
    if (!record.parts.has(event.ordinal)) { record.complete = false; return false; }
    record.parts.set(event.ordinal, (record.parts.get(event.ordinal) + event.delta).slice(0, 32000));
  }
  if (event.kind === 'text_end') record.parts.set(event.ordinal, event.text);
  return record.complete;
}

export function mergeStreaming(baseline, records) {
  const messages = baseline.map(message => ({ ...message }));
  for (const record of records.values()) {
    let message = messages.find(item => item.id === record.id);
    if (!message) { message = { id: record.id, type: 'assistant', created: record.created, text: '', tools: [] }; messages.push(message); }
    const current = message.text || '';
    const parts = [...record.parts].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('\n');
    const streamed = [record.prefix, parts].filter(Boolean).join('\n');
    // Prefix checks prevent canonical refreshes and live deltas duplicating text.
    if (record.complete && streamed.startsWith(current)) message.text = streamed;
    const tools = new Map((message.tools || []).map(tool => [tool.id, tool]));
    for (const [id, tool] of record.tools) tools.set(id, { ...tools.get(id), ...tool });
    message.tools = [...tools.values()];
  }
  return messages.sort((a, b) => (a.created || 0) - (b.created || 0));
}
