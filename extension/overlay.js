// Executed in Chrome's isolated world. Page content never supplies executable code.
function controlOverlay(action, data = {}) {
  const key = '__chromeControlOverlay';
  const previous = globalThis[key];
  // Replace an old status-bar overlay when this script is updated in-place.
  if (previous && previous.revision !== 3) {
    document.removeEventListener('keydown', previous.keydown, true);
    if (previous.resize) window.removeEventListener('resize', previous.resize);
    previous.motion?.cancel(); previous.pulseAnimation?.cancel();
    previous.host.remove();
    delete globalThis[key];
  }
  if (action === 'remove') {
    const state = globalThis[key];
    if (!state) return;
    document.removeEventListener('keydown', state.keydown, true);
    window.removeEventListener('resize', state.resize);
    state.motion?.cancel(); state.pulseAnimation?.cancel();
    state.host.remove();
    delete globalThis[key];
    return;
  }
  if (!globalThis[key]) {
    const host = document.createElement('div');
    host.id = 'chrome-control-overlay';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{color-scheme:dark;pointer-events:none}.box{position:fixed;display:none;border:2px solid #8b5cf6;background:#8b5cf61a;border-radius:6px;box-shadow:0 0 0 3px #8b5cf622;box-sizing:border-box;pointer-events:none}.pointer{position:fixed;left:0;top:0;display:block;will-change:transform;filter:drop-shadow(0 2px 3px #0006);pointer-events:none}.pulse{position:fixed;width:30px;height:30px;border:2px solid #8b5cf6;border-radius:50%;opacity:0;box-sizing:border-box;pointer-events:none;will-change:transform,opacity}
      </style><div class="box"></div><div class="pointer" aria-hidden="true"><svg width="24" height="30" viewBox="0 0 24 30"><path d="M2 2 L2 24 L8 18 L13 28 L18 25 L13 16 L22 15 Z" fill="#a78bfa" stroke="white" stroke-width="2"/></svg></div><div class="pulse"></div>`;
    document.documentElement.appendChild(host);
    const stop = () => { chrome.runtime.sendMessage({ type: 'stop' }).catch(() => {}); };
    const keydown = event => { if (event.isTrusted && event.key === 'Escape') stop(); };
    document.addEventListener('keydown', keydown, true);
    const state = { host, root, keydown, revision: 3, centered: true };
    const center = () => {
      if (state.centered) root.querySelector('.pointer').style.transform = `translate(${window.innerWidth / 2 - 2}px,${window.innerHeight / 2 - 2}px)`;
    };
    state.resize = center;
    window.addEventListener('resize', center);
    center();
    globalThis[key] = state;
  }
  const state = globalThis[key];
  if (!state.host.isConnected) document.documentElement.appendChild(state.host);
  // Status updates do not reset the pointer or display an on-page toolbar.
  if (data.rect) {
    state.centered = false;
    const { x, y, width, height } = data.rect;
    Object.assign(state.root.querySelector('.box').style, { display: 'block', left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    const pointer = state.root.querySelector('.pointer');
    const from = pointer.style.transform;
    const to = `translate(${x + width / 2 - 2}px,${y + height / 2 - 2}px)`;
    state.motion?.cancel(); pointer.style.transform = to;
    if (action === 'move' && from && from !== to) state.motion = pointer.animate?.([{ transform: from }, { transform: to }], { duration: 120, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  if (action === 'click' && data.rect) {
    const pulse = state.root.querySelector('.pulse');
    state.pulseAnimation?.cancel();
    Object.assign(pulse.style, { left: `${data.rect.x + data.rect.width / 2 - 15}px`, top: `${data.rect.y + data.rect.height / 2 - 15}px` });
    state.pulseAnimation = pulse.animate?.([{ transform: 'scale(.5)', opacity: .85 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: 220, easing: 'ease-out' });
  }
}
