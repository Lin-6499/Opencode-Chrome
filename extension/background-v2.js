importScripts('overlay.js', 'page-agent.js', 'frame-driver.js', 'action-driver.js', 'group-manager.js', 'task-manager.js');
void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

let socket, heartbeat, connecting, pairing, lastError = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const debug = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
const send = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
const manager = new BrowserTasks(send);
// Kept as a small public adapter so tests and the wire use exactly the same path.
const dispatch = (method, args = {}, owner = 'legacy', created) => manager.run(method, args, owner, created);

async function autoPair() {
  if (pairing) return pairing;
  pairing = (async () => {
    let result;
    try { result = await chrome.runtime.sendNativeMessage('local.opencode.chrome_control', { action: 'pair' }); }
    catch { throw new Error('本机自动配对组件不可用，请检查本机组件注册。'); }
    if (!/^[a-f0-9]{64}$/.test(result?.token || '') || result.endpoint !== 'ws://127.0.0.1:17891') throw new Error('本机配对响应无效。');
    return result.token;
  })();
  try { return await pairing; } finally { pairing = undefined; }
}
async function connectBridge() {
  await manager.ready;
  if (connecting) return connecting;
  if (socket?.readyState === WebSocket.OPEN) return;
  connecting = (async () => {
    const token = await autoPair(); const ws = new WebSocket('ws://127.0.0.1:17891'); socket = ws;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('MCP 连接超时，将自动重试。')); }, 6000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, protocol: 4 }));
        ws.onerror = () => { clearTimeout(timer); reject(new Error('本机 MCP 尚未启动。')); };
        ws.onclose = () => { clearTimeout(timer); reject(new Error('MCP 拒绝连接，请同时重载扩展和 MCP。')); };
        ws.onmessage = event => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'ready') { clearTimeout(timer); data.protocol === 4 ? resolve() : reject(new Error('MCP 桥接版本过旧，请重启 chrome-control MCP。')); }
          } catch { /* Invalid handshake ignored until timeout. */ }
        };
      });
    } catch (error) { if (socket === ws) socket = undefined; ws.close(); throw error; }
    lastError = ''; clearInterval(heartbeat);
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = undefined; clearInterval(heartbeat);
      for (const owner of [...manager.tasks.keys()]) void manager.pauseOwner(owner, 'Bridge disconnected');
    };
    ws.onmessage = event => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'cleanup_owner') {
        void manager.cleanupOwner(data.owner, data.endedAt).then(result => send({ type: 'owner_cleaned', id: data.id, owner: data.owner, ...result })); return;
      }
      if (data.type === 'timeout_owner') { void manager.pauseOwner(data.owner, 'Browser operation timed out'); return; }
      if (data.type === 'stop') { void manager.pauseAll(); return; }
      if (!data.id) return;
      // No global action queue: BrowserTasks serializes by tab, not by browser.
      void dispatch(data.method, data.args || {}, data.owner, data.created).then(
        result => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: data.id, result })); },
        error => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: data.id, error: error.message })); },
      );
    };
    heartbeat = setInterval(() => send({ type: 'ping' }), 20000);
  })();
  try { await connecting; } finally { connecting = undefined; }
}
function beginBridge() { void connectBridge().catch(error => { lastError = error.message; }); }
chrome.runtime.onInstalled.addListener(beginBridge); chrome.runtime.onStartup.addListener(beginBridge);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'chrome-control-reconnect') { beginBridge(); void manager.sweepIdle(); } });
void chrome.alarms.create('chrome-control-reconnect', { periodInMinutes: 1 });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fromUI = !sender.tab && ['popup.html', 'sidepanel.html'].some(page => sender.url === chrome.runtime.getURL(page));
  const fromPanel = !sender.tab && sender.url === chrome.runtime.getURL('sidepanel.html');
  if (message.type === 'stop') {
    const state = sender.tab ? manager.tabs.get(sender.tab.id) : undefined;
    if (sender.tab && !state) return false;
    if (!sender.tab && !fromUI) return false;
    const work = state ? manager.pauseOwner(state.task.owner) : manager.pauseAll();
    void work.then(() => respond({ stopped: true })); return true;
  }
  if (message.type === 'chat' && fromPanel) {
    chrome.runtime.sendNativeMessage('local.opencode.chrome_control', { ...message.request, action: 'chat' })
      .then(respond).catch(() => respond({ error: '无法连接本机 OpenCode。发送结果不确定时请先刷新会话，不要盲目重复提交。' })); return true;
  }
  if (message.type === 'control_state' && fromUI) {
    void manager.ready.then(() => {
      const pageCount = [...manager.tabs.values()].filter(state => !state.closing).length;
      respond({ connected: socket?.readyState === WebSocket.OPEN, paused: manager.userPaused || manager.pausedOwners.size > 0, taskCount: manager.tasks.size, pageCount, taskSummary: manager.tasks.size ? `${manager.tasks.size} 个任务 · ${pageCount} 个页面` : '', tabId: manager.tabs.keys().next().value ?? null, error: lastError || manager.lastError });
    }); return true;
  }
  if (message.type === 'pair' && fromUI) { void connectBridge().then(() => respond({ paired: true, connected: manager.tabs.size > 0, paused: manager.userPaused || manager.pausedOwners.size > 0 })).catch(error => respond({ error: error.message })); return true; }
  if (message.type === 'resume' && fromUI) { void manager.ready.then(() => manager.resume()).then(() => connectBridge()).then(() => respond({ resumed: true })).catch(error => respond({ error: error.message })); return true; }
  return false;
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'opencode-events' || port.sender?.id !== chrome.runtime.id || port.sender?.tab || port.sender?.url !== chrome.runtime.getURL('sidepanel.html')) { port.disconnect(); return; }
  let native, closed = false;
  const post = value => { if (!closed) { try { port.postMessage(value); } catch { /* Panel closed. */ } } };
  port.onMessage.addListener(message => {
    if (native || message.type !== 'watch' || !/^ses_[a-zA-Z0-9_-]{1,100}$/.test(message.sessionID || '')) return;
    const connection = chrome.runtime.connectNative('local.opencode.chrome_control'); native = connection;
    connection.onMessage.addListener(post);
    connection.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (native === connection) native = undefined; post({ type: 'stream_error', error: '实时连接已断开，将使用只读刷新。' }); });
    connection.postMessage({ action: 'watch', sessionID: message.sessionID });
  });
  port.onDisconnect.addListener(() => { closed = true; try { native?.disconnect(); } catch { /* Already disconnected. */ } });
});
chrome.debugger.onDetach.addListener((source, reason) => { void manager.detached(source.tabId, reason); });
chrome.tabs.onRemoved.addListener(tabId => { void manager.tabClosed(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.url) manager.navigation(tabId);
  if (change.status === 'complete') void manager.readyPage(tabId);
});
chrome.webNavigation.onCommitted?.addListener(details => { if (details.frameId === 0) { manager.navigation(details.tabId); void manager.readyPage(details.tabId, false); } else clearPageReferences(details.tabId); });
chrome.webNavigation.onDOMContentLoaded?.addListener(details => { if (details.frameId === 0) void manager.readyPage(details.tabId); });
beginBridge();
