const $ = selector => document.querySelector(selector);
const chat = $('#chat-view');
const control = $('#control-view');
const conversation = $('#conversation');
const welcome = $('#welcome');
let sessionID;
let currentTab;
let windowID;
let timer;
let busy = false;
let loading = false;
let pendingDraft;
let disposed = false;
let lastTimeline = '';
let awaitingSince = 0;
let submitting = false;

function notice(text = '') { $('#notice').textContent = text; $('#notice').hidden = !text; }
async function api(operation, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type: 'chat', request: { operation, sessionID, ...extra } });
  if (!result || result.error) throw new Error(result?.error || '未收到本机 OpenCode 响应。');
  return result;
}
function setBusy(value) {
  busy = value;
  $('#send').hidden = value;
  $('#interrupt').hidden = !value;
}
function renderMessages(messages) {
  const signature = JSON.stringify(messages);
  if (signature === lastTimeline) return;
  lastTimeline = signature;
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
  conversation.replaceChildren();
  const visible = messages.filter(message => message.type !== 'idle');
  if (!visible.length) { conversation.append(welcome); return; }
  for (const message of visible) {
    const article = document.createElement('article');
    article.className = `message ${message.type}`;
    const role = document.createElement('div');
    role.className = 'role'; role.textContent = message.type === 'user' ? '你' : 'OpenCode';
    const body = document.createElement('div'); body.className = 'body';
    body.textContent = message.text || message.error || (message.type === 'assistant' ? '正在处理…' : '');
    article.append(role, body);
    if (message.tools?.length) {
      const tools = document.createElement('div'); tools.className = 'tools';
      tools.textContent = message.tools.map(tool => tool.name).join(' · ');
      article.append(tools);
    }
    conversation.append(article);
  }
  if (nearBottom) conversation.scrollTop = conversation.scrollHeight;
}
function renderPermissions(permissions) {
  const box = $('#permissions'); box.replaceChildren(); box.hidden = !permissions.length;
  for (const permission of permissions) {
    const label = document.createElement('div'); label.textContent = `需要确认：${permission.action} ${permission.resources.join('、')}`;
    const actions = document.createElement('div'); actions.className = 'permission-actions';
    for (const [reply, text] of [['once', '允许一次'], ['reject', '拒绝']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
      button.onclick = async () => {
        button.disabled = true;
        try { await api('permission', { permissionID: permission.id, reply }); await refresh(); }
        catch (error) { notice(error.message); button.disabled = false; }
      };
      actions.append(button);
    }
    box.append(label, actions);
  }
}
async function refresh() {
  if (!sessionID || loading) return;
  loading = true;
  const requested = sessionID;
  try {
    const result = await api('read');
    if (requested !== sessionID) return;
    renderMessages(result.messages);
    renderPermissions(result.permissions);
    const model = result.session.model;
    $('#model-label').textContent = model ? `${model.providerID} / ${model.id}` : '本机 OpenCode · 默认模型';
    if (pendingDraft && result.messages.some(message => message.id === pendingDraft.messageID)) {
      awaitingSince = result.messages.find(message => message.id === pendingDraft.messageID).created || Date.now();
      if ($('#prompt').value.trim() === pendingDraft.text) $('#prompt').value = '';
      pendingDraft = undefined;
    }
    if (awaitingSince && result.messages.some(message => message.type === 'idle' && message.created >= awaitingSince)) awaitingSince = 0;
    setBusy(result.busy || !!awaitingSince);
    const failed = result.messages.at(-1);
    if (failed?.type === 'idle' && failed.error) notice(failed.error);
  } catch (error) { notice(error.message); }
  finally { loading = false; }
}
async function updateTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId: windowID });
  currentTab = tab && /^https?:\/\//.test(tab.url || '') ? { tabId: tab.id, title: tab.title || '', url: tab.url } : undefined;
  $('#page-label').textContent = currentTab ? currentTab.title || '当前网页' : '此页不支持网页上下文';
  $('#page-label').title = currentTab?.title || '';
  $('#attach-tab').disabled = !currentTab;
}
async function selectSession(id, fromSubmit = false) {
  if (submitting && !fromSubmit) return;
  sessionID = id; pendingDraft = undefined; lastTimeline = ''; awaitingSince = 0;
  $('#permissions').hidden = true; notice();
  await chrome.storage.session.set({ [`sidepanel-session-${windowID}`]: id });
  $('#history').hidden = true;
  await refresh();
}
async function listSessions() {
  const result = await api('list');
  const list = $('#session-list'); list.replaceChildren();
  if (!result.sessions.length) { const text = document.createElement('p'); text.className = 'muted small'; text.textContent = '还没有会话，发送消息即可开始。'; list.append(text); }
  for (const session of result.sessions) {
    const button = document.createElement('button'); button.className = 'session-item'; button.textContent = session.title; button.title = session.title;
    button.onclick = () => { void selectSession(session.id).catch(error => notice(error.message)); };
    list.append(button);
  }
  return result.sessions;
}
$('#composer').onsubmit = async event => {
  event.preventDefault();
  const text = $('#prompt').value.trim();
  if (!text || busy || submitting) return;
  submitting = true;
  for (const selector of ['#send', '#prompt', '#new-chat', '#history-toggle']) $(selector).disabled = true;
  notice();
  try {
    if (!sessionID) {
      const created = await api('create', { title: text.slice(0, 40) });
      await selectSession(created.session.id, true);
    }
    if (!pendingDraft || pendingDraft.text !== text) pendingDraft = { text, messageID: `msg_${crypto.randomUUID().replaceAll('-', '')}`, tab: $('#attach-tab').checked ? currentTab : undefined };
    const receipt = await api('send', pendingDraft);
    awaitingSince = receipt.acceptedAt || Date.now();
    pendingDraft = undefined; $('#prompt').value = '';
    setBusy(true);
    await refresh();
  } catch (error) { notice(`${error.message} 若发送结果不确定，请先刷新会话确认；不会自动重发。`); }
  finally {
    submitting = false;
    for (const selector of ['#send', '#prompt', '#new-chat', '#history-toggle']) $(selector).disabled = false;
  }
};
$('#prompt').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); }
};
$('#interrupt').onclick = async () => {
  try { await api('interrupt'); await refresh(); }
  catch (error) { notice(error.message); }
};
$('#new-chat').onclick = async () => {
  if (submitting) return;
  sessionID = undefined; pendingDraft = undefined; lastTimeline = ''; awaitingSince = 0;
  setBusy(false); notice(); $('#permissions').hidden = true; $('#history').hidden = true;
  conversation.replaceChildren(welcome); $('#prompt').value = '';
  await chrome.storage.session.remove(`sidepanel-session-${windowID}`);
  $('#prompt').focus();
};
$('#history-toggle').onclick = () => {
  $('#history').hidden = !$('#history').hidden;
  if (!$('#history').hidden) void listSessions().catch(error => notice(error.message));
};
$('#history-refresh').onclick = () => { void listSessions().catch(error => notice(error.message)); };
function mode(controlMode) {
  chat.hidden = controlMode; control.hidden = !controlMode;
  $('#chat-tab').classList.toggle('selected', !controlMode); $('#control-tab').classList.toggle('selected', controlMode);
  $('#chat-tab').setAttribute('aria-selected', String(!controlMode)); $('#control-tab').setAttribute('aria-selected', String(controlMode));
}
$('#chat-tab').onclick = () => mode(false);
$('#control-tab').onclick = () => { mode(true); void controlState(); };
async function controlState() {
  const state = await chrome.runtime.sendMessage({ type: 'control_state' });
  $('#control-connection').textContent = state.connected ? '已自动配对并连接' : state.error || '正在等待本机 MCP';
  $('#control-task').textContent = state.taskSummary || '暂无任务';
  $('#control-status').textContent = state.paused ? '已停止，等待手动恢复' : state.tabId !== null ? '任务控制中' : '就绪，按任务自动连接';
  $('#resume').hidden = !state.paused;
}
$('#takeover').onclick = async () => { await chrome.runtime.sendMessage({ type: 'stop' }); await controlState(); };
$('#resume').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: 'resume' });
  if (result.error) notice(result.error);
  await controlState();
};
$('#reconnect').onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: 'pair' });
  if (result.error) notice(result.error); else notice();
  await controlState();
};
for (const button of document.querySelectorAll('.suggestions button')) button.onclick = () => { $('#prompt').value = button.textContent; $('#prompt').focus(); };
chrome.tabs.onActivated.addListener(() => { void updateTab(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (id === currentTab?.tabId && (info.url || info.title)) void updateTab(); });
window.addEventListener('unload', () => { disposed = true; clearTimeout(timer); });
async function tick() {
  if (disposed) return;
  await Promise.allSettled([refresh(), controlState()]);
  if (!disposed) timer = setTimeout(tick, 2500);
}
async function init() {
  windowID = (await chrome.windows.getCurrent()).id;
  await updateTab();
  const key = `sidepanel-session-${windowID}`;
  sessionID = (await chrome.storage.session.get(key))[key];
  try { await listSessions(); await refresh(); }
  catch (error) { notice(error.message); }
  void chrome.runtime.sendMessage({ type: 'pair' }).catch(() => {});
  void tick();
}
void init().catch(error => notice(error.message));
