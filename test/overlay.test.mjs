import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8');
function harness() {
  const documentEvents = new Map();
  const windowEvents = new Map();
  const messages = [];
  const hosts = [];
  const window = {
    innerWidth: 1200, innerHeight: 800,
    addEventListener(name, listener) { windowEvents.set(name, listener); },
    removeEventListener(name) { windowEvents.delete(name); },
  };
  const document = {
    documentElement: { appendChild(host) { host.isConnected = true; } },
    createElement() {
      const nodes = Object.fromEntries(['.box', '.pointer', '.pulse'].map(selector => [selector, { style: {}, offsetWidth: 32 }]));
      const root = { innerHTML: '', querySelector: selector => nodes[selector] || null };
      const host = { style: {}, isConnected: false, attachShadow: () => root, remove() { this.isConnected = false; }, root };
      hosts.push(host);
      return host;
    },
    addEventListener(name, listener) { documentEvents.set(name, listener); },
    removeEventListener(name) { documentEvents.delete(name); },
  };
  const context = vm.createContext({ document, window, chrome: { runtime: { async sendMessage(message) { messages.push(message); } } } });
  vm.runInContext(source, context);
  return {
    context, window, documentEvents, windowEvents, messages, hosts,
    run: (action, data = {}) => context.controlOverlay(action, data),
    state: () => context.__chromeControlOverlay,
  };
}
test('takeover displays pointer at viewport center without an on-page toolbar', () => {
  const h = harness();
  h.run('status', { status: 'Connected' });
  const state = h.state();
  assert.equal(state.root.querySelector('.pointer').style.transform, 'translate(598px,398px)');
  assert.equal(state.root.innerHTML.includes('class="bar"'), false);
  assert.equal(state.root.innerHTML.includes('<button'), false);
  assert.match(state.host.style.cssText, /pointer-events:none/);
  h.window.innerWidth = 1600;
  h.windowEvents.get('resize')();
  assert.equal(state.root.querySelector('.pointer').style.transform, 'translate(798px,398px)');
});
test('target actions move the pointer; idle status does not move it back to center', () => {
  const h = harness();
  h.run('status');
  h.run('move', { rect: { x: 100, y: 200, width: 80, height: 40 } });
  assert.equal(h.state().root.querySelector('.pointer').style.transform, 'translate(138px,218px)');
  h.run('status');
  h.windowEvents.get('resize')();
  assert.equal(h.state().root.querySelector('.pointer').style.transform, 'translate(138px,218px)');
});
test('Escape takeover remains available, and removal cleans up listeners', () => {
  const h = harness();
  h.run('remove');
  assert.equal(h.hosts.length, 0, 'Cleanup must not create a new overlay');
  h.run('status');
  const keydown = h.documentEvents.get('keydown');
  keydown({ key: 'Escape', isTrusted: false });
  assert.equal(h.messages.length, 0);
  keydown({ key: 'Escape', isTrusted: true });
  assert.equal(h.messages[0].type, 'stop');
  h.run('remove');
  assert.equal(h.documentEvents.size, 0);
  assert.equal(h.windowEvents.size, 0);
  assert.equal(h.state(), undefined);
});
test('click animation is compositor-only, nonblocking and does not force a layout read',()=>{
  const h=harness();h.run('status');
  const state=h.state();const pulse=state.root.querySelector('.pulse');let duration;
  Object.defineProperty(pulse,'offsetWidth',{get(){throw new Error('Forced layout read');}});
  pulse.animate=(_,options)=>{duration=options.duration;return{cancel(){},finished:new Promise(()=>{})};};
  const result=h.run('click',{rect:{x:10,y:20,width:100,height:40}});
  assert.equal(result,undefined);assert.equal(duration,220);
  assert.equal(state.root.querySelector('.pointer').style.transform,'translate(58px,38px)');
});
