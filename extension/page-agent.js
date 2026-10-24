// This function is serialized into an extension isolated world in each document.
// Never evaluates page-provided code or model-provided JavaScript.
function pageAgent(request) {
  const key = '__chromeControlPageRefs';
  if (request.op === 'state') {
    const url = new URL(location.href);
    return { title: document.title.slice(0, 300), url: `${url.origin}${url.pathname}`.slice(0, 2048), readyState: document.readyState };
  }
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  // Chrome's native dom API accepts HTMLElement, not arbitrary Element/SVGElement.
  const shadow = el => el instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot?.(el) || el.shadowRoot : null;
  const roots = [document];
  const all = [];
  let truncated = false;
  for (let index = 0; index < roots.length && index < 200; index++) {
    for (const el of roots[index].querySelectorAll('*')) {
      if (el.id === 'chrome-control-overlay' || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
      if (all.length >= 12000) { truncated = true; break; }
      all.push(el);
      const root = shadow(el);
      if (root) roots.push(root);
    }
    if (truncated) break;
  }
  const visible = el => {
    if (!el.isConnected || !el.getClientRects().length) return false;
    let node = el;
    while (node) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      node = node.parentElement || node.getRootNode()?.host;
    }
    return true;
  };
  const label = el => {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const text = ids.split(/\s+/).map(id => el.getRootNode().getElementById?.(id)?.textContent || document.getElementById(id)?.textContent || '').join(' ');
      if (clean(text)) return clean(text).slice(0, 200);
    }
    return clean(el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('alt') || el.getAttribute('placeholder') || el.innerText || el.textContent).slice(0, 200);
  };
  const role = el => (el.getAttribute('role') || ({ A: el.hasAttribute('href') ? 'link' : '', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' })[el.tagName] || (el.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', range: 'slider' })[el.type] || 'textbox' : '')).slice(0, 50);
  const fingerprint = el => `${el.tagName}|${role(el)}|${el.getAttribute('type') || ''}|${label(el)}|${el.getAttribute('href') || ''}`;
  const safeUrl = () => { const url = new URL(location.href); return `${url.origin}${url.pathname}`.slice(0, 2048); };
  if (request.op === 'read_text') return { text: all.filter(el => visible(el) && ['P', 'H1', 'H2', 'H3', 'LABEL', 'BUTTON', 'OUTPUT'].includes(el.tagName)).map(el => clean(el.innerText || el.textContent)).join('\n').slice(0, 24000) };
  if (request.op === 'inspect') {
    const state = { snapshot: request.snapshot, nodes: new Map() };
    globalThis[key] = state;
    const ids = new Map();
    const describe = el => {
      if (!ids.has(el)) {
        const id = `n${ids.size + 1}`;
        ids.set(el, id);
        state.nodes.set(id, { el, fingerprint: fingerprint(el) });
      }
      return { localRef: ids.get(el), role: role(el), name: label(el), tag: el.localName.slice(0, 80), type: el.getAttribute('type')?.slice(0, 50), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' };
    };
    const shown = all.filter(visible);
    const headings = shown.filter(el => role(el) === 'heading').slice(0, 80).map(el => ({ ...describe(el), level: Number(el.getAttribute('aria-level') || el.tagName.slice(1)) || null }));
    const elements = shown.filter(el => role(el) && role(el) !== 'heading').slice(0, 240).map(describe);
    const parts = [document.body?.innerText || ''];
    // innerText on the main document does not reliably include shadow text.
    for (const root of roots.slice(1)) {
      const host = root.host;
      if (host && visible(host)) parts.push([...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,label,button,a,[role]')].filter(visible).map(el => clean(el.innerText || el.textContent)).join('\n'));
    }
    return { title: document.title.slice(0, 300), url: safeUrl(), readyState: document.readyState, headings, elements, text: parts.join('\n').slice(0, 9000), shadowRoots: roots.length - 1, truncated: truncated || shown.length > 240 };
  }
  const target = request.target || {};
  let matches;
  if (target.localRef) {
    const state = globalThis[key];
    const saved = state?.nodes.get(target.localRef);
    if (!saved || state.snapshot !== target.snapshot || !saved.el.isConnected || fingerprint(saved.el) !== saved.fingerprint) throw new Error('Stale element reference: inspect again; never substitute another element.');
    matches = [saved.el];
  } else if (target.selector) {
    matches = roots.flatMap(root => [...root.querySelectorAll(target.selector)]).filter(visible);
  } else if (target.role) {
    matches = all.filter(el => visible(el) && role(el) === target.role && label(el) === target.name);
  } else throw new Error('Provide ref, selector, or exact role/name');
  if (request.op === 'probe') return { count: matches.length, visible: matches.some(visible), text: matches.length === 1 ? clean(matches[0].innerText || matches[0].textContent).slice(0, 1000) : '' };
  if (matches.length !== 1) throw new Error(`Target must match exactly one visible element; found ${matches.length}`);
  const el = matches[0];
  if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Element is hidden or disabled');
  if (request.op === 'verify_text') return { matches: el.value === request.text };
  if (request.op === 'focus' || request.op === 'fill' || request.op === 'select') {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error('Typing requires an input or textarea');
    if (el instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel'].includes(el.type)) throw new Error('Unsupported or sensitive input type');
    if (el.readOnly || /password|cc-|credit|card|cvc|cvv/i.test(`${el.autocomplete} ${el.name} ${el.id}`)) throw new Error('Sensitive or read-only field blocked');
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  if (request.op === 'focus' || request.op === 'fill') el.focus({ preventScroll: true });
  if (!el.isConnected) throw new Error('Target was replaced during focus; inspect again.');
  const rect = el.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  // Follow hit-testing through open/closed roots to detect occlusion.
  let hit = document.elementFromPoint(x, y);
  for (let depth = 0; hit && depth < 100; depth++) {
    const next = shadow(hit)?.elementFromPoint?.(x, y);
    if (!next || next === hit) break;
    hit = next;
  }
  if (rect.width <= 0 || rect.height <= 0 || !hit || !(hit === el || el.contains(hit))) throw new Error('Element center is obscured or outside viewport');
  if (request.op === 'activate') el.click();
  if (request.op === 'fill') {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, request.text);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { matches: el.value === request.text };
  }
  if (request.op === 'select') el.select();
  let binding;
  if (!target.localRef && request.bindingSnapshot) {
    const state = globalThis[key] || { snapshot: request.bindingSnapshot, nodes: new Map() };
    globalThis[key] = state;
    const localRef = `a${state.nodes.size + 1}`;
    state.nodes.set(localRef, { el, fingerprint: fingerprint(el) });
    binding = { localRef, snapshot: state.snapshot };
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, binding };
}
