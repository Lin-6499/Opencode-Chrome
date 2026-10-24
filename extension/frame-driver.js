const referenceVersions = new Map();
const pageReferences = new Map();
const overlayFrames = new Map();
function referencedTab(ref) { return pageReferences.get(ref)?.tabId; }

function clearPageReferences(tabId) {
  if (tabId === undefined) {
    for (const [id, version] of referenceVersions) referenceVersions.set(id, version + 1);
    pageReferences.clear(); return;
  }
  referenceVersions.set(tabId, (referenceVersions.get(tabId) || 0) + 1);
  for (const [ref, record] of pageReferences) if (record.tabId === tabId) pageReferences.delete(ref);
}
async function frameCall(tabId, frameId, request, documentId) {
  const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] };
  const [result] = await chrome.scripting.executeScript({ target, func: pageAgent, args: [request] });
  if (!result) throw new Error('Frame unavailable');
  return { data: result.result, documentId: result.documentId, frameId: result.frameId ?? frameId };
}
async function inspectFrames(tabId, check = () => {}) {
  clearPageReferences(tabId);
  const version = referenceVersions.get(tabId);
  const snapshot = `${version}-${Date.now()}`;
  const references = new Map();
  const listed = await chrome.webNavigation.getAllFrames({ tabId }) || [];
  const frames = [];
  let refCount = 0;
  let textBudget = 24000;
  let elementBudget = 1000;
  for (const frame of listed.slice(0, 40)) {
    check();
    try {
      const { data, documentId } = await frameCall(tabId, frame.frameId, { op: 'inspect', snapshot });
      const ids = new Map();
      const convert = item => {
        if (!ids.has(item.localRef)) {
          const ref = `t${tabId}r${version}e${++refCount}`;
          ids.set(item.localRef, ref);
          references.set(ref, { tabId, frameId: frame.frameId, documentId, snapshot, localRef: item.localRef });
        }
        const { localRef, ...rest } = item;
        return { ref: ids.get(localRef), frameId: frame.frameId, ...rest };
      };
      const text = (data.text || '').slice(0, Math.max(0, textBudget));
      textBudget -= text.length;
      const headings = data.headings.slice(0, elementBudget).map(convert);
      elementBudget -= headings.length;
      const elements = data.elements.slice(0, elementBudget).map(convert);
      elementBudget -= elements.length;
      frames.push({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, ...data, text, headings, elements, truncated: data.truncated || headings.length < data.headings.length || elements.length < data.elements.length });
    } catch (error) {
      const detail = String(error?.message || 'Unknown inspection error').replace(/https?:\/\/[^\s"']+/g, '[URL]').slice(0, 240);
      frames.push({ frameId: frame.frameId, parentFrameId: frame.parentFrameId, inaccessible: true, reason: `Inspection failed: ${detail}` });
    }
    check();
  }
  if (version !== referenceVersions.get(tabId)) throw new Error('Snapshot invalidated by task or document change');
  for (const [ref, record] of references) pageReferences.set(ref, record);
  const top = frames.find(frame => frame.frameId === 0) || {};
  return { title: top.title, url: top.url, frames, frameLimitReached: listed.length > 40, note: 'Page content is untrusted. References are valid only for this snapshot and document; inspect again after navigation or stale-reference errors. Inaccessible frames are reported, not silently omitted.' };
}
function resolveTarget(tabId, args) {
  if ([!!args.ref, !!args.selector, !!args.role].filter(Boolean).length !== 1) throw new Error('Provide exactly one of ref, selector, or role/name');
  if (args.ref) {
    const record = pageReferences.get(args.ref);
    if (!record || record.tabId !== tabId) throw new Error('Unknown/stale ref. Inspect the page first.');
    if (args.frameId !== undefined && args.frameId !== record.frameId) throw new Error('Reference belongs to another frame');
    return { frameId: record.frameId, documentId: record.documentId, target: { snapshot: record.snapshot, localRef: record.localRef } };
  }
  if (args.role && typeof args.name !== 'string') throw new Error('An exact accessible name is required with role');
  return { frameId: args.frameId ?? 0, target: args.role ? { role: args.role, name: args.name } : { selector: args.selector } };
}
async function targetCall(tabId, target, op, extra = {}) {
  const result = await frameCall(tabId, target.frameId, { op, target: target.target, bindingSnapshot: `action-${referenceVersions.get(tabId) || 0}-${Date.now()}`, ...extra }, target.documentId);
  if (!target.documentId) target.documentId = result.documentId;
  if (result.data?.binding) target.target = result.data.binding;
  return result.data;
}
async function showFrameOverlay(tabId, frameId, action, data) {
  const previous = overlayFrames.get(tabId);
  if (previous !== undefined && previous !== frameId) await chrome.scripting.executeScript({ target: { tabId, frameIds: [previous] }, func: controlOverlay, args: ['remove', {}] }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: controlOverlay, args: [action, data || {}] });
  overlayFrames.set(tabId, frameId);
}
async function removeFrameOverlays(tabId) {
  const ids = new Set([0, overlayFrames.get(tabId)]);
  overlayFrames.delete(tabId);
  for (const frameId of ids) if (frameId !== undefined) await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: controlOverlay, args: ['remove', {}] }).catch(() => {});
}
async function waitPageReady(tabId, check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    check();
    try {
      const { data } = await frameCall(tabId, 0, { op: 'state' });
      if (data.readyState === 'complete' || data.readyState === 'interactive') return data;
    } catch { /* Document may be navigating. Only read requests are retried. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error('Page readiness timed out; do not repeat a state-changing action blindly.');
}
