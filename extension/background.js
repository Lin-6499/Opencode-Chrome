importScripts('overlay.js', 'page-agent.js', 'frame-driver.js', 'action-driver.js');
void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

let socket;
let targetTab;
let generation = 0;
let heartbeat;
let operationQueue = Promise.resolve();
let pairing;
let bridgeConnecting;
let selectedTab;
let userPaused = false;
let navigationTask = Promise.resolve();
let lastError = '';
let taskSummary = '';
let activeOwner = null;
let taskStartedAt = 0;
let inFlight = 0;
let taskGroup;
let groupQueue = Promise.resolve();
let lastActivity = Date.now();
const stateReady = chrome.storage.session.get(['userPaused', 'taskGroup']).then(async data => {
  userPaused = !!data.userPaused;
  taskGroup = data.taskGroup || undefined;
  // A worker restart does not inherit an in-flight browser task.
  await restoreTaskGroup();
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function groupJob(job) {
  const result = groupQueue.then(job);
  groupQueue = result.catch(() => {});
  return result;
}
function shortSummary(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, 40).join('') || '网页任务';
}
function restoreTaskGroup(expectedGeneration) {
  return groupJob(async () => {
    const record = taskGroup;
    if (!record || (expectedGeneration !== undefined && record.generation !== expectedGeneration)) return;
    let tab;
    try { tab = await chrome.tabs.get(record.tabId); } catch { /* Tab closed. */ }
    if (tab && tab.groupId === record.groupId) {
      if (record.originalGroup && tab.windowId === record.windowId) {
        let original;
        try { original = await chrome.tabGroups.get(record.originalGroup.id); } catch { /* Last original member moved away. */ }
        if (original && original.windowId === tab.windowId) {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: original.id });
        } else {
          const id = await chrome.tabs.group({ tabIds: [tab.id] });
          await chrome.tabGroups.update(id, { title: record.originalGroup.title, color: record.originalGroup.color, collapsed: record.originalGroup.collapsed });
        }
      } else await chrome.tabs.ungroup([tab.id]);
    }
    // If the user moved the tab to another group, preserve their newer choice.
    taskGroup = undefined;
    await chrome.storage.session.set({ taskGroup: null });
  });
}
function createTaskGroup(tabId, version) {
  return groupJob(async () => {
    if (generation !== version || userPaused) throw new Error('Task stopped before grouping');
    if (taskGroup?.tabId === tabId) return;
    const tab = await chrome.tabs.get(tabId);
    if (tab.pinned) throw new Error('固定标签页不能临时分组，请先取消固定；工具不会擅自取消固定。');
    let originalGroup;
    if (Number.isInteger(tab.groupId) && tab.groupId >= 0) originalGroup = await chrome.tabGroups.get(tab.groupId);
    if (generation !== version || userPaused) throw new Error('Task stopped before grouping');
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    taskGroup = { tabId, groupId, generation: version, windowId: tab.windowId, originalGroup: originalGroup ? { id: originalGroup.id, title: originalGroup.title || '', color: originalGroup.color, collapsed: originalGroup.collapsed } : null };
    await chrome.storage.session.set({ taskGroup });
    if (generation !== version || userPaused) throw new Error('Task stopped while grouping');
    await chrome.tabGroups.update(groupId, { title: shortSummary(taskSummary), color: 'purple', collapsed: false });
  });
}

async function autoPair() {
  if (pairing) return pairing;
  pairing = (async () => {
    let result;
    try { result = await chrome.runtime.sendNativeMessage('local.opencode.chrome_control', { action: 'pair' }); }
    catch {
      throw new Error('本机自动配对组件未安装或未注册此扩展。请在项目目录运行 npm.cmd run install-native，再重新加载扩展。');
    }
    if (result?.error || !/^[a-f0-9]{64}$/.test(result?.token || '') || result?.endpoint !== 'ws://127.0.0.1:17891') throw new Error('本机配对响应无效，请重新安装配对组件。');
    await chrome.storage.session.set({ token: result.token, paired: true });
    return result.token;
  })();
  try { return await pairing; }
  finally { pairing = undefined; }
}
// Pairing only retrieves local credentials; it never attaches to a tab.
function beginBridge() { void connectBridge().catch(error => { lastError = error.message; }); }
chrome.runtime.onInstalled.addListener(beginBridge);
chrome.runtime.onStartup.addListener(beginBridge);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'chrome-control-reconnect') return;
  beginBridge();
  // Fallback cleanup if a model/client forgets to end its task explicitly.
  if (taskGroup && inFlight === 0 && Date.now() - lastActivity > 5 * 60 * 1000) void stop('Task idle timeout', false, userPaused);
});
void chrome.alarms.create('chrome-control-reconnect', { periodInMinutes: 1 });

async function overlay(tabId, action, data) {
  if (action === 'remove') return removeFrameOverlays(tabId);
  return showFrameOverlay(tabId, 0, action, data);
}
function send(data) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }
async function stop(reason = 'User took over', notify = true, pause = true, clearSelection = true, keepGroup = false) {
  generation++;
  clearPageReferences();
  // Internal cleanup must never clear a user takeover that raced with it.
  if (pause) userPaused = true;
  const oldTab = targetTab;
  targetTab = undefined;
  if (clearSelection) { selectedTab = undefined; taskSummary = ''; activeOwner = null; taskStartedAt = 0; }
  if (notify) send({ type: 'takeover', reason });
  await chrome.storage.session.set({ userPaused });
  if (oldTab !== undefined) {
    await chrome.debugger.detach({ tabId: oldTab }).catch(() => {});
    await overlay(oldTab, 'remove').catch(() => {});
  }
  if (!keepGroup) {
    try { await restoreTaskGroup(); }
    catch (error) { lastError = `临时分组恢复失败：${error.message}`; }
  }
}
function ensure(tabId, version) {
  if (targetTab !== tabId || generation !== version) throw new Error('Session changed or stopped. Read current status before continuing; do not blindly retry an action.');
}
async function debug(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function connectBridge() {
  await stateReady;
  if (socket?.readyState === WebSocket.OPEN) return;
  if (bridgeConnecting) return bridgeConnecting;
  bridgeConnecting = (async () => {
    const token = await autoPair();
    const ws = new WebSocket('ws://127.0.0.1:17891');
    socket = ws;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.close(); reject(new Error('MCP 连接超时，请检查 OpenCode 中的 chrome-control 是否启用。')); }, 6000);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, protocol: 3 }));
        ws.onerror = () => { clearTimeout(timer); reject(new Error('本机 MCP 尚未启动，将自动重试。')); };
        ws.onclose = () => { clearTimeout(timer); reject(new Error('连接被拒绝，请检查是否有另一份扩展正在连接。')); };
        ws.onmessage = event => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'ready') {
              clearTimeout(timer);
              if (data.protocol !== 3) { reject(new Error('MCP 桥接版本过旧，请重新启动 chrome-control MCP。')); return; }
              resolve();
            }
          } catch { /* Ignore malformed handshake data. */ }
        };
      });
    } catch (error) { if (socket === ws) socket = undefined; ws.close(); throw error; }
    lastError = '';
    clearInterval(heartbeat);
    ws.onclose = () => {
      if (socket === ws) {
        socket = undefined;
        clearInterval(heartbeat);
        void stop('Connection lost', false, userPaused);
      }
    };
    ws.onmessage = event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'stop') { void stop('Server stopped session'); return; }
      if (data.type === 'cleanup_owner') {
        const matched = activeOwner === data.owner && taskStartedAt <= data.endedAt;
        const cleanup = matched ? stop('OpenCode session completed/cancelled', false, userPaused) : Promise.resolve();
        void cleanup.then(() => send({ type: 'owner_cleaned', id: data.id, owner: data.owner, matched, cleaned: !matched || !taskGroup }));
        return;
      }
      if (!data.id) return;
      const version = generation;
      operationQueue = operationQueue.catch(() => {}).then(async () => {
        try {
          if (version !== generation) throw new Error('Operation cancelled after session changed');
          inFlight++;
          const result = await dispatch(data.method, data.args || {}, data.owner);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: data.id, result }));
        } catch (error) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: data.id, error: error.message })); }
        finally { inFlight = Math.max(0, inFlight - 1); lastActivity = Date.now(); }
      });
    };
    heartbeat = setInterval(() => send({ type: 'ping' }), 20000);
  })();
  try { await bridgeConnecting; }
  finally { bridgeConnecting = undefined; }
}

function normalPage(tab) {
  if (!/^https?:\/\//.test(tab?.url || '')) throw new Error('仅支持普通 HTTP/HTTPS 网页，不能控制 chrome:// 等浏览器内部页面。');
  return tab;
}
function tabInfo(tab) {
  const url = new URL(tab.url);
  // Listing tabs does not expose query strings, fragments, or URL credentials.
  return { tabId: tab.id, title: tab.title || '', url: `${url.origin}${url.pathname}`, active: !!tab.active, windowId: tab.windowId };
}
async function ensureTarget() {
  await stateReady;
  await navigationTask;
  if (userPaused) throw new Error('用户已停止并接管。请在扩展中点击“恢复自动控制”；工具不能自行恢复。');
  if (targetTab !== undefined) return targetTab;
  let tab;
  if (selectedTab !== undefined) tab = normalPage(await chrome.tabs.get(selectedTab));
  else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length !== 1) throw new Error('无法确定活动网页，请使用 list_tabs 和 select_tab 指定目标。');
    tab = normalPage(tabs[0]);
  }
  const version = generation;
  try {
    await createTaskGroup(tab.id, version);
    if (userPaused || generation !== version) throw new Error('Task stopped while grouping');
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  } catch (error) { await restoreTaskGroup(version); throw error; }
  if (userPaused || version !== generation) {
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    await restoreTaskGroup(version);
    throw new Error('Control cancelled while attaching');
  }
  selectedTab = tab.id;
  targetTab = tab.id;
  try {
    await overlay(tab.id, 'status', { status: '已自动连接 · 所有普通网站默认可用 · Esc 停止' });
    ensure(tab.id, version);
  } catch (error) {
    if (generation === version) await stop('Could not attach page', false, false, false);
    else await restoreTaskGroup(version);
    throw error;
  }
  return tab.id;
}
async function dispatch(method, args, owner = 'legacy') {
  await stateReady;
  if (method === 'get_status') return { bridgeConnected: socket?.readyState === WebSocket.OPEN, paused: userPaused, targetTab: targetTab ?? null, selectedTab: selectedTab ?? null, taskSummary, groupId: taskGroup?.groupId ?? null, busy: activeOwner !== null && activeOwner !== owner, websitePermission: 'all-http-https', lastError };
  if (method === 'list_tabs') return (await chrome.tabs.query({})).filter(tab => /^https?:\/\//.test(tab.url || '')).map(tabInfo);
  if (typeof owner !== 'string' || !owner || owner.length > 300) throw new Error('Invalid task owner');
  if (activeOwner !== null && activeOwner !== owner) throw new Error('Browser is busy with another OpenCode session. Do not switch or end its task.');
  lastActivity = Date.now();
  if (method === 'release' || method === 'end_task') { await stop('Task completed', false, userPaused); return { released: true, taskEnded: true, paused: userPaused, groupRestored: !taskGroup }; }
  if (method === 'begin_task') {
    if (userPaused) throw new Error('用户已接管，请在扩展中手动恢复。');
    if (typeof args.summary !== 'string' || !args.summary.trim()) throw new Error('Task summary is required');
    if (args.tabId !== undefined && (!Number.isInteger(args.tabId) || args.tabId < 0)) throw new Error('Invalid tabId');
    const requestedTab = args.tabId === undefined ? undefined : normalPage(await chrome.tabs.get(args.tabId));
    await stop('Starting new task', false, false);
    if (userPaused) throw new Error('用户已接管，请在扩展中手动恢复。');
    activeOwner = owner;
    taskStartedAt = Date.now();
    taskSummary = shortSummary(args.summary);
    if (requestedTab) selectedTab = requestedTab.id;
    let tabId;
    try { tabId = await ensureTarget(); }
    catch (error) { if (!taskGroup && targetTab === undefined) { activeOwner = null; taskStartedAt = 0; } throw error; }
    return { tabId, summary: taskSummary, groupId: taskGroup?.groupId };
  }
  if (method === 'select_tab') {
    if (userPaused) throw new Error('用户已接管，请在扩展中手动恢复。');
    if (!Number.isInteger(args.tabId) || args.tabId < 0) throw new Error('Invalid tabId');
    const version = generation;
    const tab = normalPage(await chrome.tabs.get(args.tabId));
    if (version !== generation || userPaused) throw new Error('选择目标期间会话已停止或变化。');
    // Do not focus the tab or silently navigate; only change this task's target.
    await stop('Switching task target', false, false, false);
    if (!activeOwner) { activeOwner = owner; taskStartedAt = Date.now(); }
    selectedTab = tab.id;
    await ensureTarget();
    return tabInfo(tab);
  }
  if (!['inspect', 'highlight', 'click', 'type', 'scroll', 'wait_for'].includes(method)) throw new Error('Unknown operation');
  if (!activeOwner) { activeOwner = owner; taskStartedAt = Date.now(); }
  if (!taskSummary) taskSummary = ({ inspect: '读取网页结构', highlight: '高亮网页元素', click: '网页点击操作', type: '网页文字输入', scroll: '浏览网页' })[method];
  let tabId;
  try { tabId = await ensureTarget(); }
  catch (error) { if (!taskGroup && targetTab === undefined) { activeOwner = null; taskStartedAt = 0; } throw error; }
  return executePageAction(method, args, tabId, generation);
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message.type === 'stop') {
    if (sender.tab && sender.tab.id !== targetTab) return false;
    stop().then(() => respond({ stopped: true })); return true;
  }
  const fromUI = !sender.tab && ['popup.html', 'sidepanel.html'].some(page => sender.url === chrome.runtime.getURL(page));
  const fromPanel = !sender.tab && sender.url === chrome.runtime.getURL('sidepanel.html');
  if (message.type === 'chat' && fromPanel) {
    chrome.runtime.sendNativeMessage('local.opencode.chrome_control', { ...message.request, action: 'chat' })
      .then(respond).catch(() => respond({ error: '无法连接本机会话组件。请确认 OpenCode 已启动，并检查本机配对组件。发送失败时请先刷新会话确认结果，不要盲目重复发送。' }));
    return true;
  }
  if (message.type === 'control_state' && fromUI) {
    stateReady.then(() => respond({ connected: socket?.readyState === WebSocket.OPEN, paused: userPaused, taskSummary, tabId: targetTab ?? null, error: lastError }));
    return true;
  }
  if (message.type === 'pair' && fromUI) {
    connectBridge().then(() => respond({ paired: true, connected: targetTab !== undefined, paused: userPaused })).catch(error => respond({ error: error.message }));
    return true;
  }
  if (message.type === 'resume' && fromUI) {
    // Only the trusted extension UI can clear the user takeover latch.
    stateReady.then(async () => {
      generation++;
      userPaused = false;
      await chrome.storage.session.set({ userPaused: false });
      await connectBridge();
      respond({ resumed: true });
    }).catch(error => respond({ error: error.message }));
    return true;
  }
  return false;
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'opencode-events' || port.sender?.id !== chrome.runtime.id || port.sender?.tab || port.sender?.url !== chrome.runtime.getURL('sidepanel.html')) { port.disconnect(); return; }
  let native;
  let closed = false;
  const post = value => { if (!closed) { try { port.postMessage(value); } catch { /* Panel closed. */ } } };
  port.onMessage.addListener(message => {
    if (native || message.type !== 'watch' || !/^ses_[a-zA-Z0-9_-]{1,100}$/.test(message.sessionID || '')) return;
    const connection = chrome.runtime.connectNative('local.opencode.chrome_control');
    native = connection;
    connection.onMessage.addListener(post);
    connection.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (native === connection) native = undefined; post({ type: 'stream_error', error: '实时连接已断开，将使用只读刷新。' }); });
    connection.postMessage({ action: 'watch', sessionID: message.sessionID });
  });
  port.onDisconnect.addListener(() => { closed = true; try { native?.disconnect(); } catch { /* Native host already closed. */ } });
});
chrome.debugger.onDetach.addListener(source => { if (source.tabId === targetTab) void stop('Debugger detached'); });
chrome.tabs.onRemoved.addListener(tabId => { if (tabId === targetTab || tabId === taskGroup?.tabId) void stop('Tab closed'); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === targetTab && change.status === 'loading') {
    // Cancel old-document actions, but keep this tab selected for the next call.
    // Invalidate old-document refs; an already dispatched click is not replayed.
    navigationTask = stop('Page navigated', false, userPaused, false, true);
  }
});
beginBridge();
