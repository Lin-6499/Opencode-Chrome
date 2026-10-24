async function executePageAction(method, args, tabId, control) {
  control.check();
  if (method === 'inspect') {
    await waitPageReady(tabId, () => control.check());
    const result = await inspectFrames(tabId, () => control.check());
    control.check();
    return result;
  }
  if (method === 'wait_for') {
    const deadline = Date.now() + Math.min(args.timeoutMs ?? 5000, 15000);
    if (!args.urlIncludes && !args.text && !args.ref && !args.selector && !args.role) throw new Error('Provide a URL, text, or element condition');
    do {
      control.check();
      const state = (await frameCall(tabId, args.frameId ?? 0, { op: 'state' })).data;
      let matches = !args.urlIncludes || state.url.includes(args.urlIncludes);
      if (args.ref || args.selector || args.role) {
        const probe = await targetCall(tabId, resolveTarget(tabId, args), 'probe');
        matches = matches && (args.state === 'hidden' ? !probe.visible : probe.count === 1 && probe.visible);
        if (args.text) matches = matches && probe.text.includes(args.text);
      } else if (args.text) {
        const text = (await frameCall(tabId, args.frameId ?? 0, { op: 'read_text' })).data.text;
        matches = matches && text.includes(args.text);
      }
      if (matches) return { matched: true, observed: state };
      await sleep(100);
    } while (Date.now() < deadline);
    throw new Error('Condition not observed before timeout. No action was retried.');
  }
  if (method === 'scroll') {
    if (!Number.isInteger(args.pixels) || Math.abs(args.pixels) > 2000) throw new Error('Invalid scroll distance');
    const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [args.frameId ?? 0] }, func: pixels => { window.scrollBy({ top: pixels, behavior: 'instant' }); return { x: window.scrollX, y: window.scrollY }; }, args: [args.pixels] });
    control.check();
    return { scrolled: args.pixels, position: result.result };
  }
  if (!['highlight', 'click', 'type'].includes(method)) throw new Error('Unknown operation');
  if (method === 'type' && (typeof args.text !== 'string' || args.text.length > 10000)) throw new Error('Invalid text');
  const target = resolveTarget(tabId, args);
  if (target.frameId !== 0) {
    const [visibility] = await chrome.scripting.executeScript({
      target: target.documentId ? { tabId, documentIds: [target.documentId] } : { tabId, frameIds: [target.frameId] },
      func: () => new Promise(resolve => {
        const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, 1000);
        const observer = new IntersectionObserver(entries => {
          clearTimeout(timer);
          observer.disconnect();
          resolve(entries.some(entry => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0));
        });
        observer.observe(document.documentElement);
      }),
    });
    control.check();
    if (!visibility?.result) throw new Error('Subframe is not visibly intersecting the page; scroll it into view before acting.');
  }
  const operation = method === 'type' ? 'focus' : 'locate';
  let rect = await targetCall(tabId, target, operation);
  control.check();
  await showFrameOverlay(tabId, target.frameId, 'move', { rect });
  // Rendering is fire-and-forget. No fixed preview delay blocks input or other tabs.
  control.check();
  let nextRect = await targetCall(tabId, target, operation);
  if (method !== 'highlight') {
    const moved = (a, b) => Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y),Math.abs(a.width-b.width),Math.abs(a.height-b.height)) > 2;
    for (let attempt = 0; moved(rect, nextRect) && attempt < 5; attempt++) {
      control.check(); rect = nextRect; await sleep(30); nextRect = await targetCall(tabId, target, operation);
    }
    if (moved(rect, nextRect)) throw new Error('Target is still moving; no input was issued. Inspect or wait for the UI to settle.');
  }
  rect = nextRect;
  control.check();
  let issued = false;
  if (method === 'click') {
    await showFrameOverlay(tabId, target.frameId, 'click', { rect });
    control.check();
    if (target.frameId === 0) {
      const coords = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      await debug(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...coords });
      control.check();
      try {
        await debug(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...coords });
        issued = true;
      } finally {
        await debug(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...coords }).catch(() => {});
      }
    } else {
      // Do not guess top-level coordinates for transformed/cross-origin frames.
      // DOM activation is explicit; sites requiring trusted input may reject it.
      await targetCall(tabId, target, 'activate');
      issued = true;
    }
  }
  if (method === 'type') {
    let result;
    if (target.frameId === 0) {
      await targetCall(tabId, target, 'select');
      control.check();
      if (args.text) await debug(tabId, 'Input.insertText', { text: args.text });
      else {
        await debug(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await debug(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }).catch(() => {});
      }
      issued = true;
      result = await targetCall(tabId, target, 'verify_text', { text: args.text });
    } else {
      result = await targetCall(tabId, target, 'fill', { text: args.text });
      issued = true;
    }
    if (!result.matches) throw new Error('Text was sent but value verification failed. Do not blindly retry.');
  }
  if (control.isPaused() || !control.active()) throw new Error('Task stopped. An issued action cannot be undone.');
  if (control.changed()) return { issued, documentChanged: true, verification: 'Inspect the new document; do not repeat the action blindly.' };
  control.check();
  // Page load waiting is a separate read-only tool; never hold up a click for it.
  const observed = await frameCall(tabId, target.frameId, { op: 'state' }, target.documentId).then(result => result.data).catch(() => ({ documentChanging: true }));
  return { completed: method, issued, inputMethod: target.frameId === 0 ? 'cdp' : 'dom', valueVerified: method === 'type' ? true : undefined, observed, verification: method === 'click' ? 'Input dispatched; use wait_for to verify the requested business outcome.' : 'completed' };
}
