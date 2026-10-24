import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../extension/page-agent.js', import.meta.url), 'utf8');
function fixture() {
  const dom = new JSDOM('<svg><path d="M0 0L10 10"></path></svg><h1>商店设置</h1><label for="search">搜索设置</label><input id="search"><input id="password" type="password"><div id="open"></div><div id="closed"></div>', { url: 'https://example.com/settings?token=hidden', runScripts: 'outside-only' });
  const w = dom.window;
  const closed = new WeakMap();
  w.chrome = { dom: { openOrClosedShadowRoot: el => {
    if (!(el instanceof w.HTMLElement)) throw new TypeError('Expected HTMLElement, received SVGElement');
    return closed.get(el) || el.shadowRoot;
  } } };
  w.Element.prototype.getClientRects = function () { return this.isConnected ? [{}] : []; };
  w.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 100, height: 40 });
  w.Element.prototype.scrollIntoView = () => {};
  let hit;
  w.document.elementFromPoint = () => hit;
  const open = w.document.querySelector('#open').attachShadow({ mode: 'open' });
  open.innerHTML = '<h2>主题预览</h2><button>保存预览</button>';
  const root = w.document.querySelector('#closed').attachShadow({ mode: 'closed' });
  closed.set(w.document.querySelector('#closed'), root);
  root.innerHTML = '<h2>封闭组件</h2><button aria-label="关闭预览">×</button>';
  vm.runInContext(source, dom.getInternalVMContext());
  return { w, open, root, run: request => w.pageAgent(request), hit: element => { hit = element; }, close: () => w.close() };
}
test('reads open and closed shadow roots with compact element identities', () => {
  const f = fixture();
  try {
    const result = f.run({ op: 'inspect', snapshot: 'one' });
    assert.equal(result.shadowRoots, 2);
    assert.equal(result.headings.some(h => h.name === '封闭组件'), true);
    assert.equal(result.elements.some(e => e.name === '关闭预览'), true);
    assert.equal(result.elements.find(e => e.name === '搜索设置').role, 'textbox');
    assert.equal(result.url, 'https://example.com/settings');
    assert.equal(JSON.stringify(result).includes('nth-of-type'), false);
  } finally { f.close(); }
});
test('reference does not silently retarget when an element is replaced or renamed', () => {
  const f = fixture();
  try {
    const result = f.run({ op: 'inspect', snapshot: 'one' });
    const element = result.elements.find(e => e.name === '保存预览');
    const button = f.open.querySelector('button');
    button.textContent = '删除全部';
    assert.throws(() => f.run({ op: 'locate', target: { localRef: element.localRef, snapshot: 'one' } }), /Stale/);
    button.replaceWith(button.cloneNode(true));
    assert.throws(() => f.run({ op: 'locate', target: { localRef: element.localRef, snapshot: 'one' } }), /Stale/);
  } finally { f.close(); }
});
test('exact semantic targeting works in shadow roots and ambiguity is rejected', () => {
  const f = fixture();
  try {
    const button = f.root.querySelector('button');
    f.hit(button);
    assert.equal(f.run({ op: 'locate', target: { role: 'button', name: '关闭预览' } }).width, 100);
    f.open.innerHTML += '<button aria-label="关闭预览">重复</button>';
    assert.throws(() => f.run({ op: 'locate', target: { role: 'button', name: '关闭预览' } }), /found 2/);
  } finally { f.close(); }
});
test('typing verifies value, emits input events, and rejects sensitive fields', () => {
  const f = fixture();
  try {
    const input = f.w.document.querySelector('#search');
    f.hit(input);
    let events = 0;
    input.addEventListener('input', () => events++);
    assert.equal(f.run({ op: 'fill', target: { selector: '#search' }, text: '测试' }).matches, true);
    assert.equal(input.value, '测试');
    assert.equal(events, 1);
    assert.equal(f.run({ op: 'verify_text', target: { selector: '#search' }, text: '测试' }).matches, true);
    f.hit(f.w.document.querySelector('#password'));
    assert.throws(() => f.run({ op: 'fill', target: { selector: '#password' }, text: 'secret' }), /sensitive/);
  } finally { f.close(); }
});
test('occlusion is detected instead of clicking the covering element', () => {
  const f = fixture();
  try {
    f.hit(f.w.document.body);
    assert.throws(() => f.run({ op: 'activate', target: { selector: '#search' } }), /obscured/);
  } finally { f.close(); }
});
