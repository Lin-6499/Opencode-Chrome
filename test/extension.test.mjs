import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../extension/background-v2.js', import.meta.url), 'utf8');
function event() { return { listeners: [], addListener(callback) { this.listeners.push(callback); } }; }
async function harness({ paused = false, snapshot } = {}) {
  const store = { userPaused: paused, ...snapshot?.store };
  const attached = [];
  const commands = [];
  const sent = [];
  const tabs = new Map(snapshot?.tabs || [
    [1, { id: 1, windowId: 1, title: 'First', url: 'https://example.com/a?secret=hidden#fragment', active: true, groupId: -1 }],
    [2, { id: 2, windowId: 1, title: 'Second', url: 'https://another.example/b', active: false, groupId: -1 }],
    [3, { id: 3, windowId: 1, title: 'Extensions', url: 'chrome://extensions/', active: false, groupId: -1 }],
  ]);
  const groups = new Map(snapshot?.groups || []);
  let nextGroupId = 100;
  function deleteEmptyGroups() {
    for (const id of groups.keys()) if (![...tabs.values()].some(tab => tab.groupId === id)) groups.delete(id);
  }
  let active = 1;
  let nativeCalls = 0;
  const nativeRequests = [];
  const chrome = {
    runtime: {
      id: 'a'.repeat(32), onInstalled: event(), onStartup: event(), onMessage: event(), onConnect: event(),
      getURL: path => `chrome-extension://${'a'.repeat(32)}/${path}`,
      async sendNativeMessage(host, request) { nativeCalls++; nativeRequests.push({ host, request }); return request.action === 'chat' ? { sessions: [] } : { token: 'b'.repeat(64), endpoint: 'ws://127.0.0.1:17891' }; },
    },
    storage: { session: { async get() { return { ...store }; }, async set(data) { Object.assign(store, data); } } },
    alarms: { onAlarm: event(), async create() {} },
    webNavigation: { async getAllFrames() { return [{ frameId: 0, parentFrameId: -1 }]; } },
    tabs: {
      onRemoved: event(), onUpdated: event(),
      async get(id) { if (!tabs.has(id)) throw new Error('Tab closed'); return tabs.get(id); },
      async query(query) { return query.active ? [tabs.get(active)] : [...tabs.values()]; },
      async group({ tabIds, groupId }) {
        if (groupId === undefined) {
          while (groups.has(nextGroupId)) nextGroupId++;
          groupId = nextGroupId++;
          groups.set(groupId, { id: groupId, windowId: tabs.get(tabIds[0]).windowId, title: '', color: 'grey', collapsed: false });
        }
        if (!groups.has(groupId)) throw new Error('Group missing');
        for (const id of tabIds) tabs.get(id).groupId = groupId;
        deleteEmptyGroups();
        return groupId;
      },
      async ungroup(tabIds) { for (const id of tabIds) tabs.get(id).groupId = -1; deleteEmptyGroups(); },
    },
    tabGroups: {
      async get(id) { if (!groups.has(id)) throw new Error('Group missing'); return { ...groups.get(id) }; },
      async update(id, values) { if (!groups.has(id)) throw new Error('Group missing'); Object.assign(groups.get(id), values); return groups.get(id); },
    },
    debugger: {
      onDetach: event(), async attach(target) { attached.push(target.tabId); }, async detach() {},
      async sendCommand(target, method, params) { commands.push({ target, method, params }); },
    },
    scripting: {
      async executeScript(options) {
        if (options.func.name === 'controlOverlay') return [{}];
        const request = options.args?.[0];
        const state = { title: tabs.get(options.target.tabId).title, url: tabs.get(options.target.tabId).url.split('?')[0], readyState: 'complete' };
        const result = request?.op === 'inspect' ? { ...state, headings: [{ localRef: 'n1', role: 'heading', name: 'Demo' }], elements: [], text: '' } : request?.op === 'state' ? state : { x: 10, y: 200, width: 100, height: 30, matches: true, count: 1, visible: true, text: 'Demo' };
        return [{ result, frameId: 0, documentId: 'doc-0' }];
      },
    },
  };
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) {
      const data = JSON.parse(raw);
      sent.push(data);
      if (data.type === 'hello') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready', protocol: 4 }) }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = vm.createContext({
    chrome, WebSocket: FakeWebSocket, URL, console, crypto: webcrypto,
    importScripts(...names) { for (const name of names) vm.runInContext(readFileSync(new URL(`../extension/${name}`, import.meta.url), 'utf8'), context); },
    setTimeout: (fn, ms) => setTimeout(fn, ms === 600 ? 0 : ms), clearTimeout,
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(source, context);
  await vm.runInContext('connectBridge()', context);
  await new Promise(setImmediate);
  const run = expression => vm.runInContext(expression, context);
  const message = (data, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') }) => new Promise(resolve => {
    const handled = chrome.runtime.onMessage.listeners[0](data, sender, resolve);
    if (!handled) resolve(null);
  });
  return { attached, commands, sent, store, chrome, run, message, tabs, groups, nativeRequests, setActive: id => { active = id; }, nativeCalls: () => nativeCalls };
}

test('installation grants ordinary websites; startup pairs without attaching a tab', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.host_permissions.includes('https://*/*'), true);
  assert.equal(manifest.host_permissions.includes('http://*/*'), true);
  const h = await harness();
  assert.equal(h.nativeCalls(), 1);
  assert.equal(h.attached.length, 0);
  const status = await h.run('dispatch("get_status", {})');
  assert.equal(status.websitePermission, 'all-http-https');
  assert.equal(status.paused, false);
});
test('first read automatically attaches; later calls remain pinned even after active tab changes', async () => {
  const h = await harness();
  assert.equal((await h.run('dispatch("inspect", {})')).title, 'First');
  h.setActive(2);
  assert.equal((await h.run('dispatch("inspect", {})')).title, 'First');
  assert.deepEqual(h.attached, [1]);
  await h.run('dispatch("select_tab", {tabId: 2})');
  assert.equal((await h.run('dispatch("inspect", {})')).title, 'Second');
  const tabs = await h.run('dispatch("list_tabs", {})');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].url, 'https://example.com/a');
  assert.equal(h.commands.length, 0, 'Reads/selecting must not click or type');
});
test('takeover blocks automatic reattach; only trusted popup resume clears latch', async () => {
  const h = await harness();
  await h.run('dispatch("inspect", {})');
  await h.run('manager.pauseAll()');
  await assert.rejects(h.run('dispatch("inspect", {})'), /用户已.*接管/);
  await assert.rejects(h.run('dispatch("select_tab", {tabId: 2})'), /用户已.*接管/);
  await h.run('connectBridge()');
  assert.equal(h.store.userPaused, true);
  const denied = await h.message({ type: 'resume' }, { id: h.chrome.runtime.id, tab: { id: 1 }, url: 'https://example.com/' });
  assert.equal(denied, null);
  assert.equal(h.store.userPaused, true);
  assert.equal((await h.message({ type: 'resume' })).resumed, true);
  assert.equal((await h.run('dispatch("inspect", {})')).title, 'First');
});
test('takeover survives worker restart, and navigation keeps the original tab selected', async () => {
  const paused = await harness({ paused: true });
  await assert.rejects(paused.run('dispatch("inspect", {})'), /用户已.*接管/);
  const h = await harness();
  await h.run('dispatch("inspect", {})');
  h.setActive(2);
  h.chrome.tabs.onUpdated.listeners[0](1, { status: 'loading' });
  assert.equal((await h.run('dispatch("inspect", {})')).title, 'First');
  assert.equal(h.sent.some(message => message.type === 'navigation'), false, 'Navigation must not discard the result of an already issued click');
  assert.equal(h.store.userPaused, false);
  await h.run('dispatch("release", {})');
  assert.equal((await h.run('dispatch("inspect", {})')).title, 'Second');
});
test('internal browser pages do not attach', async () => {
  const h = await harness();
  h.setActive(3);
  await assert.rejects(h.run('dispatch("inspect", {})'), /HTTP\/HTTPS/);
  assert.equal(h.attached.length, 0);
});

test('task summary names a temporary group; ending restores an ungrouped tab', async () => {
  const h = await harness();
  const started = await h.run('dispatch("begin_task", {summary:"读取 Shopify 结构并高亮标题"})');
  assert.equal(h.groups.get(started.groupId).title, '读取 Shopify 结构并高亮标题');
  assert.equal(h.tabs.get(1).groupId, started.groupId);
  await h.run('dispatch("inspect", {})');
  assert.equal(h.groups.size, 1);
  const ended = await h.run('dispatch("end_task", {})');
  assert.equal(ended.groupRestored, true);
  assert.equal(h.groups.size, 0);
  assert.equal(h.tabs.get(1).groupId, -1);
  assert.equal((await h.run('dispatch("get_status", {})')).targetTab, null);
});
test('task restores an existing user group without changing its metadata', async () => {
  const h = await harness();
  h.groups.set(50, { id: 50, windowId: 1, title: '我的分组', color: 'blue', collapsed: true });
  h.tabs.get(1).groupId = 50;
  h.tabs.get(2).groupId = 50;
  await h.run('dispatch("begin_task", {summary:"检查页面"})');
  assert.notEqual(h.tabs.get(1).groupId, 50);
  await h.run('dispatch("end_task", {})');
  assert.equal(h.tabs.get(1).groupId, 50);
  assert.equal(h.groups.get(50).title, '我的分组');
  assert.equal(h.groups.get(50).collapsed, true);
});
test('a single-member user group is recreated with its title and color', async () => {
  const h = await harness();
  h.groups.set(50, { id: 50, windowId: 1, title: '工作页面', color: 'green', collapsed: false });
  h.tabs.get(1).groupId = 50;
  await h.run('dispatch("begin_task", {summary:"查看标题"})');
  assert.equal(h.groups.has(50), false);
  await h.run('dispatch("end_task", {})');
  const restored = h.groups.get(h.tabs.get(1).groupId);
  assert.equal(restored.title, '工作页面');
  assert.equal(restored.color, 'green');
});
test('navigation and selecting another page retain a shared multi-page task group', async () => {
  const h = await harness();
  const started = await h.run('dispatch("begin_task", {summary:"对比页面"})');
  h.chrome.tabs.onUpdated.listeners[0](1, { status: 'loading' });
  await h.run('dispatch("inspect", {})');
  assert.equal(h.tabs.get(1).groupId, started.groupId);
  await h.run('dispatch("select_tab", {tabId:2})');
  assert.equal(h.tabs.get(1).groupId, started.groupId);
  assert.equal(h.tabs.get(2).groupId, started.groupId);
  assert.equal(h.groups.get(h.tabs.get(2).groupId).title, '对比页面');
  await h.run('manager.pauseAll()');
  assert.equal(h.tabs.get(2).groupId, -1);
  assert.equal(h.groups.size, 0);
});
test('worker restart cleans up a persisted temporary group', async () => {
  const h = await harness();
  await h.run('dispatch("begin_task", {summary:"测试恢复"})');
  const restarted = await harness({ snapshot: { store: { ...h.store }, tabs: [...h.tabs], groups: [...h.groups] } });
  assert.equal(restarted.tabs.get(1).groupId, -1);
  assert.equal(restarted.groups.size, 0);
  assert.equal(restarted.store.taskGroup, null);
});
test('manual regrouping is preserved and attach failures roll back temporary groups', async () => {
  const h = await harness();
  await h.run('dispatch("begin_task", {summary:"读取页面"})');
  const manual = await h.chrome.tabs.group({ tabIds: [1] });
  await h.chrome.tabGroups.update(manual, { title: '用户重新整理' });
  await h.run('dispatch("end_task", {})');
  assert.equal(h.tabs.get(1).groupId, manual);
  const failed = await harness();
  failed.chrome.debugger.attach = async () => { throw new Error('Debugger busy'); };
  await assert.rejects(failed.run('dispatch("begin_task", {summary:"失败测试"})'), /Debugger busy/);
  assert.equal(failed.groups.size, 0);
  assert.equal(failed.tabs.get(1).groupId, -1);
});
test('pinned tabs are not silently unpinned for grouping', async () => {
  const h = await harness();
  h.tabs.get(1).pinned = true;
  await assert.rejects(h.run('dispatch("begin_task", {summary:"测试"})'), /固定标签页/);
  assert.equal(h.tabs.get(1).pinned, true);
  assert.equal(h.groups.size, 0);
});
test('idle fallback removes an abandoned task group without setting user takeover', async () => {
  const h = await harness();
  await h.run('dispatch("begin_task", {summary:"空闲任务"})');
  await h.run('manager.tasks.get("legacy").lastActivity = Date.now() - 6 * 60 * 1000');
  h.chrome.alarms.onAlarm.listeners[0]({ name: 'chrome-control-reconnect' });
  await new Promise(setImmediate);
  assert.equal(h.tabs.get(1).groupId, -1);
  assert.equal(h.groups.size, 0);
  assert.equal(h.store.userPaused, false);
});
test('different sessions may control different pages but not each other tabs', async () => {
  const h = await harness();
  await h.run('dispatch("begin_task", {summary:"会话A"}, "session:A")');
  for (const [method, args] of [['inspect', {tabId:1}], ['select_tab', { tabId: 1 }], ['click', {tabId:1, role: 'button', name: '设置' }]]) {
    await assert.rejects(h.run(`dispatch(${JSON.stringify(method)}, ${JSON.stringify(args)}, "session:B")`), /another OpenCode session/);
  }
  await h.run('dispatch("begin_task", {summary:"会话B",tabId:2}, "session:B")');
  assert.equal((await h.run('dispatch("get_status", {}, "session:B")')).taskCount, 2);
  const aGroup=h.tabs.get(1).groupId;
  await h.run('dispatch("end_task", {}, "session:B")');
  assert.equal(h.tabs.get(1).groupId,aGroup);
  assert.equal(h.tabs.get(2).groupId,-1);
});
test('lifecycle cleanup is owner-scoped and ignores events older than a new task', async () => {
  const h = await harness();
  await h.run('dispatch("begin_task", {summary:"会话A"}, "session:A")');
  await h.run('manager.tasks.get("session:A").startedAt = 2000');
  await h.run('socket.onmessage({data:JSON.stringify({type:"cleanup_owner",id:"old",owner:"session:A",endedAt:1000})})');
  await new Promise(setImmediate);
  assert.equal(h.groups.size, 1);
  await h.run('socket.onmessage({data:JSON.stringify({type:"cleanup_owner",id:"other",owner:"session:B",endedAt:3000})})');
  await new Promise(setImmediate);
  assert.equal(h.groups.size, 1);
  await h.run('socket.onmessage({data:JSON.stringify({type:"cleanup_owner",id:"done",owner:"session:A",endedAt:3000})})');
  await new Promise(setImmediate);
  assert.equal(h.groups.size, 0);
  assert.equal(h.store.userPaused, false);
  assert.equal(h.sent.find(message => message.type === 'owner_cleaned' && message.id === 'done').cleaned, true);
});
test('idle cleanup does not interrupt an in-flight browser operation', async () => {
  const h = await harness();
  await h.run('dispatch("begin_task", {summary:"等待页面"})');
  await h.run('manager.tasks.get("legacy").lastActivity=Date.now()-600000; manager.tabs.get(1).inFlight=1');
  h.chrome.alarms.onAlarm.listeners[0]({ name: 'chrome-control-reconnect' });
  await new Promise(setImmediate);
  assert.equal(h.groups.size, 1);
});
test('wait_for verifies read-only conditions and never dispatches input', async () => {
  const h = await harness();
  const result = await h.run('dispatch("wait_for", {role:"button",name:"设置",text:"Demo",timeoutMs:100})');
  assert.equal(result.matched, true);
  assert.equal(h.commands.length, 0);
});
test('wait timeout and input verification failure never replay a state-changing action', async () => {
  const h = await harness();
  const original = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async options => {
    const op = options.args?.[0]?.op;
    if (op === 'probe') return [{ result: { count: 0, visible: false, text: '' }, frameId: 0, documentId: 'doc-0' }];
    if (op === 'verify_text') return [{ result: { matches: false }, frameId: 0, documentId: 'doc-0' }];
    return original(options);
  };
  await assert.rejects(h.run('dispatch("wait_for", {selector:"#missing",timeoutMs:100})'), /No action was retried/);
  assert.equal(h.commands.length, 0);
  await assert.rejects(h.run('dispatch("type", {selector:"#name",text:"Hello"})'), /verification failed/);
  assert.equal(h.commands.filter(command => command.method === 'Input.insertText').length, 1);
});
test('click-triggered navigation reports a changed document without replaying the click', async () => {
  const h = await harness();
  let presses = 0;
  h.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
      presses++;
      h.chrome.tabs.onUpdated.listeners[0](target.tabId, { status: 'loading' });
    }
  };
  const result = await h.run('dispatch("click", {selector:"#settings"})');
  assert.equal(result.documentChanged, true);
  assert.equal(result.issued, true);
  assert.equal(presses, 1);
});
test('late results from a cancelled inspection cannot erase a newer task group', async () => {
  const h = await harness();
  await h.run('dispatch("begin_task", {summary:"旧任务"}, "session:A")');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript = async options => {
    if (options.args?.[0]?.op === 'inspect') await gate;
    return original(options);
  };
  const oldRead = h.run('dispatch("inspect", {}, "session:A")');
  const rejection = assert.rejects(oldRead, /changed|stopped|invalidated/i);
  await new Promise(setImmediate);
  await h.run('socket.onmessage({data:JSON.stringify({type:"cleanup_owner",id:"cancel",owner:"session:A",endedAt:Date.now()})})');
  await new Promise(setImmediate);
  const newer = await h.run('dispatch("begin_task", {summary:"新任务",tabId:2}, "session:B")');
  release();
  await rejection;
  assert.equal(h.groups.get(newer.groupId).title, '新任务');
});
test('native chat is callable only from the trusted side panel, never a webpage or old popup', async () => {
  const h = await harness();
  const count = h.nativeCalls();
  const request = { type: 'chat', request: { operation: 'list' } };
  assert.equal(await h.message(request, { id: h.chrome.runtime.id, tab: { id: 1 }, url: 'https://example.com/' }), null);
  assert.equal(await h.message(request), null, 'The legacy popup has no chat API access');
  assert.equal(h.nativeCalls(), count);
  const allowed = await h.message(request, { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('sidepanel.html') });
  assert.equal(allowed.sessions.length, 0);
  assert.equal(h.nativeRequests.at(-1).request.action, 'chat');
});
test('multi-page reads execute concurrently and inspecting one tab does not expire another refs', async () => {
  const h=await harness();
  await h.run('dispatch("begin_task",{summary:"并行检查",tabIds:[1,2]},"session:A")');
  let release; const gate=new Promise(resolve=>{release=resolve;});
  const original=h.chrome.scripting.executeScript;
  h.chrome.scripting.executeScript=async options=>{if(options.target.tabId===1&&options.args?.[0]?.op==='inspect')await gate;return original(options);};
  const first=h.run('dispatch("inspect",{tabId:1},"session:A")');
  await new Promise(setImmediate);
  let timeout;
  const second=await Promise.race([h.run('dispatch("inspect",{tabId:2},"session:A")'),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Other tab was globally blocked')),500);})]);
  clearTimeout(timeout); assert.equal(second.title,'Second');
  const secondRef=second.frames[0].headings[0].ref;
  release(); const firstResult=await first;
  const firstRef=firstResult.frames[0].headings[0].ref;
  assert.notEqual(firstRef,secondRef);
  const highlighted=await h.run(`dispatch("highlight",{ref:${JSON.stringify(secondRef)}},"session:A")`);
  assert.equal(highlighted.observed.title,'Second');
  await h.run('dispatch("end_task",{},"session:A")');
  assert.equal(h.groups.size,0);
});
test('input stays ordered within one page while other pages are independent', async () => {
  const h=await harness();
  await h.run('dispatch("begin_task",{summary:"顺序操作",tabId:1})');
  let release; const gate=new Promise(resolve=>{release=resolve;}); const order=[];
  h.chrome.debugger.sendCommand=async(target,method,params)=>{
    if(method!=='Input.dispatchMouseEvent')return;
    order.push(params.type); if(params.type==='mousePressed'&&order.length===2)await gate;
  };
  const first=h.run('dispatch("click",{tabId:1,selector:"#one"})'); await new Promise(setImmediate);
  const second=h.run('dispatch("click",{tabId:1,selector:"#two"})'); await new Promise(setImmediate);
  assert.equal(order.filter(type=>type==='mousePressed').length,1);
  release(); await Promise.all([first,second]);
  assert.deepEqual(order,['mouseMoved','mousePressed','mouseReleased','mouseMoved','mousePressed','mouseReleased']);
});
test('taking over one task does not pause an unrelated task on another tab', async () => {
  const h=await harness();
  await h.run('dispatch("begin_task",{summary:"A",tabId:1},"session:A")');
  await h.run('dispatch("begin_task",{summary:"B",tabId:2},"session:B")');
  await h.run('manager.pauseOwner("session:A")');
  await assert.rejects(h.run('dispatch("inspect",{tabId:1},"session:A")'),/用户已.*接管/);
  assert.equal((await h.run('dispatch("inspect",{tabId:2},"session:B")')).title,'Second');
  assert.equal(h.tabs.get(1).groupId,-1);
  assert.notEqual(h.tabs.get(2).groupId,-1);
});
test('multiple original group members restore together; tasks can span windows', async () => {
  const h=await harness();
  h.groups.set(50,{id:50,windowId:1,title:'用户分组',color:'blue',collapsed:false});
  h.tabs.get(1).groupId=50; h.tabs.get(2).groupId=50;
  await h.run('dispatch("begin_task",{summary:"两页",tabIds:[1,2]})');
  await h.run('dispatch("end_task",{})');
  assert.equal(h.tabs.get(1).groupId,h.tabs.get(2).groupId);
  assert.equal(h.groups.get(h.tabs.get(1).groupId).title,'用户分组');
  const other=await harness();other.tabs.get(2).windowId=2;
  await other.run('dispatch("begin_task",{summary:"跨窗口",tabIds:[1,2]})');
  assert.notEqual(other.tabs.get(1).groupId,other.tabs.get(2).groupId);
  await other.run('dispatch("end_task",{})');assert.equal(other.groups.size,0);
});
test('continuously moving targets are not clicked at a stale coordinate',async()=>{
  const h=await harness();const original=h.chrome.scripting.executeScript;let x=0;
  h.chrome.scripting.executeScript=async options=>{
    if(options.args?.[0]?.op==='locate')return[{result:{x:(x+=10),y:100,width:80,height:30},frameId:0,documentId:'doc-0'}];
    return original(options);
  };
  await assert.rejects(h.run('dispatch("click",{selector:"#animated"})'),/no input was issued/);
  assert.equal(h.commands.length,0);
});
