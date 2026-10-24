import { renderMarkdown, applyStreamEvent, mergeStreaming } from './ui-runtime.js';

const $ = selector => document.querySelector(selector);
const conversation = $('#conversation');
const welcome = $('#welcome');
let sessionID, currentTab, windowID, timer, renderTimer, refreshTimer, streamPort;
let disposed = false, busy = false, submitting = false, settingsBusy = false, loading = false, refreshAgain = false;
let pendingDraft, awaitingSince = 0, currentModel = null, currentAgent = '';
let available = { models: [], agents: [], defaultModel: null };
let baseline = [], streamConnected = false, streamVersion = 0, nextWatchAt = 0, autoScroll = true;
let formsSignature = '';
const streamRecords = new Map(), eventIDs = new Set(), views = new Map();

function notice(text = '') { if (disposed || !$('#notice')) return; $('#notice').textContent = text; $('#notice').hidden = !text; }
async function api(operation, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type: 'chat', request: { operation, sessionID, ...extra } });
  if (!result || result.error) throw new Error(result?.error || '未收到本机 OpenCode 响应。');
  return result;
}
function dialog(id, open) {
  const node = $(id);
  if (open) { if (!node.open) typeof node.showModal === 'function' ? node.showModal() : node.setAttribute('open', ''); }
  else typeof node.close === 'function' ? node.close() : node.removeAttribute('open');
}
function updateControls() {
  if (disposed) return;
  $('#send').hidden = busy && !$('#prompt').value.trim(); $('#interrupt').hidden = !busy;
  $('#send').title = busy ? '发送引导指令' : '发送';
  for (const id of ['#send', '#prompt', '#new-chat', '#history-toggle']) $(id).disabled = submitting;
  for (const id of ['#model-button', '#agent-select', '#variant-select']) $(id).disabled = submitting || settingsBusy;
  $('#rename-session').disabled = !sessionID || submitting || settingsBusy;
  $('#archive-session').disabled = !sessionID || busy || submitting || settingsBusy;
  $('#run-state').textContent = busy ? '执行中' : '就绪'; $('#run-state').classList.toggle('running', busy);
}
function setBusy(value) { busy = !!value; updateControls(); }
const effectiveModel = () => currentModel || available.defaultModel;
function modelName(model) { return model ? available.models.find(item => item.id === model.id && item.providerID === model.providerID)?.name || `${model.providerID}/${model.id}` : '选择模型'; }
function renderConfiguration() {
  if (disposed) return;
  const model = effectiveModel();
  $('#model-label').textContent = modelName(model);
  $('#model-button').title = model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}` : '选择模型';
  const agent = $('#agent-select'); agent.replaceChildren();
  const fallback = document.createElement('option'); fallback.value = ''; fallback.textContent = '默认 Agent'; fallback.disabled = !!sessionID; agent.append(fallback);
  for (const item of available.agents) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; agent.append(option); }
  agent.value = currentAgent;
  const variants = available.models.find(item => item.id === model?.id && item.providerID === model?.providerID)?.variants || [];
  const select = $('#variant-select'); select.replaceChildren();
  const defaultVariant = document.createElement('option'); defaultVariant.value = ''; defaultVariant.textContent = '默认强度'; select.append(defaultVariant);
  for (const id of variants) { const option = document.createElement('option'); option.value = id; option.textContent = id; select.append(option); }
  select.value = model?.variant || ''; select.hidden = !variants.length;
  updateControls();
}
async function loadCatalog() {
  const result = await api('catalog');
  if (disposed) return;
  available = { models: result.models || [], agents: result.agents || [], defaultModel: result.defaultModel || null };
  renderConfiguration(); renderModelList();
  if (!available.models.length) notice('此项目暂无可用模型。请在桌面端连接提供商后刷新模型列表。');
}
function renderModelList() {
  const query = $('#model-search').value.trim().toLowerCase();
  const list = $('#models-list'); list.replaceChildren();
  const groups = new Map();
  for (const model of available.models) {
    if (query && !`${model.name} ${model.id} ${model.providerID}`.toLowerCase().includes(query)) continue;
    if (!groups.has(model.providerID)) groups.set(model.providerID, []);
    groups.get(model.providerID).push(model);
  }
  for (const [provider, models] of groups) {
    const heading = document.createElement('div'); heading.className = 'provider-heading'; heading.textContent = provider; list.append(heading);
    for (const model of models) {
      const button = document.createElement('button'); button.className = 'model-option'; button.setAttribute('role', 'option');
      const selected = effectiveModel()?.id === model.id && effectiveModel()?.providerID === model.providerID;
      button.classList.toggle('selected', selected); button.setAttribute('aria-selected', String(selected));
      const name = document.createElement('strong'); name.textContent = model.name;
      const detail = document.createElement('span'); detail.textContent = `${model.providerID}/${model.id}${model.context ? ` · ${Math.round(model.context / 1000)}k 上下文` : ''}`;
      button.append(name, detail); button.disabled = settingsBusy;
      button.onclick = () => { void changeModel({ id: model.id, providerID: model.providerID }).catch(error => notice(error.message)); };
      list.append(button);
    }
  }
  if (!groups.size) { const empty = document.createElement('p'); empty.className = 'muted small'; empty.textContent = query ? '没有匹配的模型。' : '暂无可用模型，可在桌面端连接提供商。'; list.append(empty); }
}
async function changeModel(model) {
  if (submitting || settingsBusy) return;
  settingsBusy = true; updateControls();
  const selectedSession = sessionID;
  try {
    if (sessionID) await api('model', { model });
    if (selectedSession !== sessionID) return;
    currentModel = model;
    await chrome.storage.session.set({ 'sidepanel-model-preference': model });
    renderConfiguration(); dialog('#models-dialog', false); notice();
    if (sessionID) await refresh();
  } finally { settingsBusy = false; renderConfiguration(); }
}
async function saveDraft() { if (windowID !== undefined) await chrome.storage.session.set({ [`sidepanel-draft-${windowID}-${sessionID || 'new'}`]: $('#prompt').value }); }
async function restoreDraft() {
  const key = `sidepanel-draft-${windowID}-${sessionID || 'new'}`;
  $('#prompt').value = (await chrome.storage.session.get(key))[key] || '';
  resizeComposer();
}
function resizeComposer() { if (disposed) return; $('#prompt').style.height = 'auto'; $('#prompt').style.height = `${Math.min(200, Math.max(52, $('#prompt').scrollHeight))}px`; }

function renderMessages() {
  if (disposed) return;
  const messages = mergeStreaming(baseline, streamRecords).filter(message => message.type !== 'idle');
  const keepBottom = autoScroll || conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80;
  if (!messages.length) { views.clear(); conversation.replaceChildren(welcome); return; }
  welcome.remove();
  const wanted = new Set(messages.map(message => message.id));
  for (const [id, view] of views) if (!wanted.has(id)) { view.article.remove(); views.delete(id); }
  messages.forEach((message, index) => {
    let view = views.get(message.id);
    if (!view) {
      const article = document.createElement('article'); article.className = `message ${message.type}`;
      const header = document.createElement('div'); header.className = 'message-header';
      const label = document.createElement('span'); header.append(label);
      const copy = document.createElement('button'); copy.className = 'copy-message'; copy.textContent = '复制'; copy.type = 'button'; header.append(copy);
      const body = document.createElement('div'); body.className = 'body';
      const tools = document.createElement('div'); const error = document.createElement('div'); error.className = 'message-error'; error.hidden = true;
      const truncated = document.createElement('div'); truncated.className = 'truncated-note'; truncated.textContent = '内容较长，侧栏已截断；完整内容请在桌面端查看。'; truncated.hidden = true;
      article.append(header, body, tools, error, truncated);
      view = { article, label, body, tools, error, truncated, text: null, toolSignature: '', message }; views.set(message.id, view);
      copy.onclick = async () => { try { await navigator.clipboard.writeText(view.message.text || ''); copy.textContent = '已复制'; } catch { notice('复制失败，请手动选择文字复制。'); } };
    }
    view.message = message;
    view.label.textContent = message.type === 'user' ? '你' : `OpenCode${message.model ? ` · ${modelName(message.model)}` : ''}`;
    const text = message.text || (message.type === 'assistant' && !message.error ? '正在处理…' : '');
    if (view.text !== text) { view.text = text; if (message.type === 'user') view.body.textContent = text; else view.body.replaceChildren(renderMarkdown(document, text)); }
    const toolSignature = JSON.stringify(message.tools || []);
    if (view.toolSignature !== toolSignature) {
      view.toolSignature = toolSignature;
      const opened = new Set([...view.tools.querySelectorAll('details[open]')].map(node => node.dataset.id));
      view.tools.replaceChildren();
      for (const tool of message.tools || []) {
        const details = document.createElement('details'); details.className = `tool-card ${['running','completed','error'].includes(tool.status) ? tool.status : ''}`; details.dataset.id = tool.id || tool.name; details.open = opened.has(details.dataset.id);
        const summary = document.createElement('summary'); const status = document.createElement('span'); status.className = 'tool-status';
        status.textContent = ({ running: '运行中', streaming: '准备中', completed: '已完成', error: '失败' })[tool.status] || '等待中';
        const name = document.createElement('span'); name.textContent = tool.name || '工具调用'; summary.append(status, name);
        const detail = document.createElement('div'); detail.className = 'tool-detail'; detail.textContent = tool.error || tool.title || '工具参数和原始结果默认不在侧栏展示。';
        details.append(summary, detail); view.tools.append(details);
      }
    }
    view.error.hidden = !message.error; view.error.textContent = message.error || '';
    view.truncated.hidden = !message.truncated;
    if (conversation.children[index] !== view.article) conversation.insertBefore(view.article, conversation.children[index] || null);
  });
  if (keepBottom) { autoScroll = true; conversation.scrollTop = conversation.scrollHeight; }
  $('#jump-latest').hidden = keepBottom;
}
function scheduleRender() { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = undefined; renderMessages(); }, 40); }
function renderPermissions(permissions) {
  const box = $('#permissions'); box.replaceChildren(); box.hidden = !permissions.length;
  for (const permission of permissions) {
    const label = document.createElement('div'); label.textContent = `需要确认：${permission.action} ${permission.resources.join('、')}`;
    const actions = document.createElement('div'); actions.className = 'permission-actions';
    for (const [reply, text] of [['once', '允许一次'], ['reject', '拒绝']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
      button.onclick = async () => { button.disabled = true; try { await api('permission', { permissionID: permission.id, reply }); await refresh(); } catch (error) { notice(error.message); button.disabled = false; } };
      actions.append(button);
    }
    box.append(label, actions);
  }
}
function renderForms(forms) {
  const signature = `${sessionID}:${JSON.stringify(forms)}`;
  if (signature === formsSignature) return;
  formsSignature = signature;
  const box = $('#forms'); box.replaceChildren(); box.hidden = !forms.length;
  for (const item of forms) {
    const form = document.createElement('form'); form.className = 'question-form';
    const title = document.createElement('strong'); title.textContent = item.title; form.append(title);
    if (item.requiresDesktop) { const hint = document.createElement('p'); hint.textContent = '此交互包含复杂或外部授权字段，请在 OpenCode 桌面端处理。'; form.append(hint); box.append(form); continue; }
    const inputs = new Map();
    for (const field of item.fields) {
      const label = document.createElement('label'); label.className = 'question-field';
      const name = document.createElement('span'); name.textContent = field.title || field.key; label.append(name);
      let input;
      if (field.type === 'multiselect' || (field.type === 'string' && field.options?.length && !field.custom)) {
        input = document.createElement('select'); input.multiple = field.type === 'multiselect';
        if (!input.multiple) { const blank = document.createElement('option'); blank.value = ''; blank.textContent = '请选择…'; input.append(blank); }
        for (const option of field.options || []) { const node = document.createElement('option'); node.value = option.value; node.textContent = option.label; node.selected = input.multiple ? (field.default || []).includes(option.value) : field.default === option.value; input.append(node); }
      } else {
        input = document.createElement('input'); input.type = field.type === 'boolean' ? 'checkbox' : ['integer','number'].includes(field.type) ? 'number' : 'text';
        if (input.type === 'checkbox') input.checked = field.default === true;
        else if (field.default !== undefined) input.value = String(field.default);
        if (input.type === 'number') { input.step = field.type === 'integer' ? '1' : 'any'; if (typeof field.minimum === 'number') input.min = String(field.minimum); if (typeof field.maximum === 'number') input.max = String(field.maximum); }
        if (field.type === 'string' && field.custom && field.options?.length) {
          const data = document.createElement('datalist'); data.id = `choices-${crypto.randomUUID()}`; input.setAttribute('list', data.id);
          for (const option of field.options) { const node = document.createElement('option'); node.value = option.value; node.label = option.label; data.append(node); } label.append(data);
        }
      }
      if (field.type !== 'boolean') input.required = !!field.required && !(field.type === 'multiselect' && field.custom);
      if (input.type === 'text') { input.maxLength = Math.min(field.maxLength ?? 8000, 16000); input.minLength = field.minLength ?? 0; input.placeholder = field.placeholder || ''; }
      label.append(input);
      let custom;
      if (field.type === 'multiselect' && field.custom) { custom = document.createElement('input'); custom.type = 'text'; custom.placeholder = '其他回答（可选）'; custom.maxLength = 8000; label.append(custom); }
      inputs.set(field.key, { input, field, custom });
      if (field.description) { const description = document.createElement('small'); description.textContent = field.description; label.append(description); }
      form.append(label);
    }
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '提交回答'; form.append(submit);
    form.onsubmit = async event => {
      event.preventDefault(); const answer = Object.create(null);
      for (const [key, { input, field, custom }] of inputs) {
        if (field.type === 'boolean') answer[key] = input.checked;
        else if (field.type === 'multiselect') answer[key] = [...input.selectedOptions].map(option => option.value).concat(custom?.value.trim() ? [custom.value.trim()] : []);
        else if (input.value !== '') answer[key] = ['integer','number'].includes(field.type) ? Number(input.value) : input.value;
      }
      submit.disabled = true;
      try { await api('form_reply', { formID: item.id, answer }); formsSignature = ''; await refresh(); }
      catch (error) { notice(error.message); submit.disabled = false; }
    };
    box.append(form);
  }
}
function scheduleRefresh() { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 150); }
async function refresh() {
  if (!sessionID || disposed) return;
  if (loading) { refreshAgain = true; return; }
  loading = true; const requested = sessionID;
  try {
    const result = await api('read');
    if (disposed || requested !== sessionID) return;
    baseline = result.messages; renderPermissions(result.permissions); renderForms(result.forms || []);
    currentModel = result.session.model || null; currentAgent = result.session.agent || '';
    $('#session-title').textContent = result.session.title;
    if (pendingDraft && baseline.some(message => message.id === pendingDraft.messageID)) {
      awaitingSince = baseline.find(message => message.id === pendingDraft.messageID).created || Date.now();
      if ($('#prompt').value.trim() === pendingDraft.text) { $('#prompt').value = ''; void saveDraft(); }
      pendingDraft = undefined;
    }
    if (awaitingSince && baseline.some(message => message.type === 'idle' && message.created >= awaitingSince)) awaitingSince = 0;
    setBusy(result.busy || !!awaitingSince);
    if (!busy) streamRecords.clear();
    renderConfiguration(); renderMessages();
    const tokens = result.session.tokens;
    $('#usage-label').textContent = tokens ? `↑${tokens.input || 0} ↓${tokens.output || 0}${result.session.cost ? ` · $${Number(result.session.cost).toFixed(4)}` : ''}` : '';
    if (baseline.at(-1)?.error) notice(baseline.at(-1).error);
  } catch (error) { notice(error.message); }
  finally { loading = false; if (refreshAgain) { refreshAgain = false; scheduleRefresh(); } }
}

function closeWatch() { streamVersion++; streamConnected = false; const old = streamPort; streamPort = undefined; old?.disconnect(); $('#stream-label').textContent = '自动刷新'; }
async function startWatch(id) {
  if (disposed) return false;
  closeWatch(); streamRecords.clear(); eventIDs.clear(); nextWatchAt = Date.now() + 10000;
  if (typeof chrome.runtime.connect !== 'function') return false;
  const version = streamVersion;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timeout); resolve(value); } };
    const timeout = setTimeout(() => finish(false), 3000);
    const port = chrome.runtime.connect({ name: 'opencode-events' }); streamPort = port;
    port.onMessage.addListener(message => {
      if (disposed || version !== streamVersion || sessionID !== id) return;
      if (message.type === 'stream_ready') { streamConnected = true; $('#stream-label').textContent = '实时连接'; finish(true); scheduleRefresh(); return; }
      if (message.type === 'stream_error') { streamConnected = false; $('#stream-label').textContent = '自动刷新'; finish(false); return; }
      const event = message.event;
      if (!event || event.sessionID !== id || eventIDs.has(event.eventID)) return;
      eventIDs.add(event.eventID); if (eventIDs.size > 2000) eventIDs.delete(eventIDs.values().next().value);
      if (event.kind === 'busy') setBusy(true);
      else if (event.kind === 'refresh') { if (event.terminal) { awaitingSince = 0; if (event.error) notice(event.error); } scheduleRefresh(); }
      else { if (!applyStreamEvent(streamRecords, event, baseline)) scheduleRefresh(); scheduleRender(); }
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (version === streamVersion) { streamConnected = false; streamPort = undefined; $('#stream-label').textContent = '自动刷新'; } finish(false); });
    port.postMessage({ type: 'watch', sessionID: id });
  });
}
async function updateTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId: windowID });
  currentTab = tab && /^https?:\/\//.test(tab.url || '') ? { tabId: tab.id, title: tab.title || '', url: tab.url } : undefined;
  $('#page-label').textContent = currentTab ? currentTab.title || '当前网页' : '此页不支持网页上下文';
  $('#page-label').title = currentTab?.title || ''; $('#attach-tab').disabled = !currentTab;
}
async function selectSession(id, fromSubmit = false) {
  if ((submitting && !fromSubmit) || settingsBusy) return;
  await saveDraft(); closeWatch();
  sessionID = id; pendingDraft = undefined; awaitingSince = 0; baseline = []; streamRecords.clear(); views.clear(); autoScroll = true;
  conversation.replaceChildren(welcome); $('#permissions').hidden = true; $('#forms').hidden = true; formsSignature = ''; notice(); $('#history').hidden = true;
  await chrome.storage.session.set({ [`sidepanel-session-${windowID}`]: id });
  await restoreDraft();
  await startWatch(id); await refresh();
}
async function newChat() {
  if (submitting || settingsBusy) return;
  await saveDraft(); closeWatch(); sessionID = undefined; pendingDraft = undefined; awaitingSince = 0;
  baseline = []; streamRecords.clear(); views.clear(); setBusy(false); autoScroll = true; notice();
  $('#permissions').hidden = true; $('#forms').hidden = true; formsSignature = ''; $('#history').hidden = true; $('#session-title').textContent = '新会话'; $('#usage-label').textContent = '';
  conversation.replaceChildren(welcome); $('#prompt').value = ''; resizeComposer();
  await chrome.storage.session.remove(`sidepanel-session-${windowID}`); await saveDraft(); $('#prompt').focus();
}
async function listSessions() {
  const result = await api('list'); const list = $('#session-list'); list.replaceChildren();
  if (!result.sessions.length) { const text = document.createElement('p'); text.className = 'muted small'; text.textContent = '还没有会话，发送消息即可开始。'; list.append(text); }
  for (const session of result.sessions) {
    const button = document.createElement('button'); button.className = 'session-item'; button.classList.toggle('selected', session.id === sessionID); button.textContent = session.title; button.title = session.title;
    button.onclick = () => { void selectSession(session.id).catch(error => notice(error.message)); }; list.append(button);
  }
}
$('#composer').onsubmit = async event => {
  event.preventDefault(); const text = $('#prompt').value.trim();
  if (text === '/models') { $('#prompt').value = ''; void saveDraft(); resizeComposer(); void openModels(); return; }
  if (text === '/new') { $('#prompt').value = ''; void newChat(); return; }
  if (!text || submitting || settingsBusy) return;
  submitting = true; updateControls(); notice();
  try {
    if (!sessionID) {
      const created = await api('create', { title: text.slice(0, 40), model: effectiveModel() || undefined, agent: currentAgent || undefined });
      await selectSession(created.session.id, true);
    }
    if (!pendingDraft || pendingDraft.text !== text) pendingDraft = { text, messageID: `msg_${crypto.randomUUID().replaceAll('-', '')}`, tab: $('#attach-tab').checked ? currentTab : undefined };
    const receipt = await api('send', pendingDraft); awaitingSince = receipt.acceptedAt || Date.now();
    pendingDraft = undefined; $('#prompt').value = ''; await saveDraft(); resizeComposer(); setBusy(true); await refresh();
  } catch (error) { notice(`${error.message} 发送结果不确定时先刷新会话确认，不会自动重发。`); }
  finally { submitting = false; updateControls(); }
};
$('#prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); } };
$('#prompt').oninput = () => { resizeComposer(); updateControls(); void saveDraft(); };
$('#interrupt').onclick = async () => { try { const result = await api('interrupt'); if (!result.interrupted) notice('没有发现正在执行的生成；已排队的消息可能仍等待处理。'); await refresh(); } catch (error) { notice(error.message); } };
$('#new-chat').onclick = () => { void newChat(); };
$('#history-toggle').onclick = () => { $('#history').hidden = !$('#history').hidden; if (!$('#history').hidden) void listSessions().catch(error => notice(error.message)); };
$('#history-refresh').onclick = () => { void listSessions().catch(error => notice(error.message)); };
async function openModels() { if (submitting || settingsBusy) return; dialog('#models-dialog', true); $('#model-search').value = ''; renderModelList(); $('#model-search').focus(); try { await loadCatalog(); } catch (error) { notice(error.message); } }
$('#model-button').onclick = () => { void openModels(); }; $('#models-close').onclick = () => dialog('#models-dialog', false); $('#model-search').oninput = renderModelList;
$('#model-search').onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); $('#models-list .model-option')?.focus(); } else if (event.key === 'Enter') { event.preventDefault(); $('#models-list .model-option')?.click(); } };
$('#models-list').onkeydown = event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const items = [...$('#models-list').querySelectorAll('.model-option:not(:disabled)')];
  if (!items.length) return;
  event.preventDefault(); const index = items.indexOf(document.activeElement); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
};
$('#variant-select').onchange = () => { const model = effectiveModel(); if (model) void changeModel({ id: model.id, providerID: model.providerID, ...($('#variant-select').value ? { variant: $('#variant-select').value } : {}) }).catch(error => notice(error.message)); };
$('#agent-select').onchange = async () => {
  if (submitting || settingsBusy) return;
  const agent = $('#agent-select').value; if (!agent && sessionID) { renderConfiguration(); return; }
  settingsBusy = true; updateControls();
  try { if (sessionID) await api('agent', { agent }); currentAgent = agent; await chrome.storage.session.set({ 'sidepanel-agent-preference': agent }); if (sessionID) await refresh(); }
  catch (error) { notice(error.message); }
  finally { settingsBusy = false; renderConfiguration(); }
};
$('#menu-toggle').onclick = () => { $('#control-menu').hidden = !$('#control-menu').hidden; $('#menu-toggle').setAttribute('aria-expanded', String(!$('#control-menu').hidden)); void controlState(); };
document.addEventListener('click', event => { if (!$('#control-menu').contains(event.target) && !$('#menu-toggle').contains(event.target)) { $('#control-menu').hidden = true; $('#menu-toggle').setAttribute('aria-expanded', 'false'); } });
$('#rename-session').onclick = () => { if (!sessionID) return; $('#rename-input').value = $('#session-title').textContent; dialog('#rename-dialog', true); $('#rename-input').focus(); };
$('#rename-form').onsubmit = async event => { event.preventDefault(); try { await api('rename', { title: $('#rename-input').value }); dialog('#rename-dialog', false); await refresh(); } catch (error) { notice(error.message); } };
$('#rename-cancel').onclick = () => dialog('#rename-dialog', false);
$('#archive-session').onclick = () => { if (sessionID && !busy) dialog('#archive-dialog', true); };
$('#archive-cancel').onclick = () => dialog('#archive-dialog', false);
$('#archive-confirm').onclick = async () => { try { await api('archive'); dialog('#archive-dialog', false); await newChat(); } catch (error) { notice(error.message); } };
$('#refresh-models').onclick = () => { void loadCatalog().catch(error => notice(error.message)); };
$('#refresh-session').onclick = () => { void refresh(); };
async function controlState() {
  const state = await chrome.runtime.sendMessage({ type: 'control_state' });
  if (disposed) return;
  $('#control-connection').textContent = state.connected ? '浏览器桥接已连接' : state.error || '正在等待本机 MCP';
  $('#control-task').textContent = state.taskSummary || '暂无浏览器任务';
  $('#takeover').textContent = state.pageCount > 1 ? '停止所有网页并接管' : '停止并接管';
  $('#control-status').textContent = state.paused ? '已停止，等待手动恢复' : state.tabId !== null ? '任务控制中' : '就绪，按任务自动连接'; $('#resume').hidden = !state.paused;
}
$('#takeover').onclick = async () => { await chrome.runtime.sendMessage({ type: 'stop' }); await controlState(); };
$('#resume').onclick = async () => { const result = await chrome.runtime.sendMessage({ type: 'resume' }); if (result.error) notice(result.error); await controlState(); };
$('#reconnect').onclick = async () => { const result = await chrome.runtime.sendMessage({ type: 'pair' }); notice(result.error || ''); await controlState(); };
$('#jump-latest').onclick = () => { autoScroll = true; conversation.scrollTop = conversation.scrollHeight; $('#jump-latest').hidden = true; };
conversation.addEventListener('scroll', () => { autoScroll = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 80; $('#jump-latest').hidden = autoScroll; });
for (const button of document.querySelectorAll('.suggestions button')) button.onclick = () => { $('#prompt').value = button.textContent; resizeComposer(); void saveDraft(); $('#prompt').focus(); };
chrome.tabs.onActivated.addListener(() => { void updateTab(); });
chrome.tabs.onUpdated.addListener((id, info) => { if (id === currentTab?.tabId && (info.url || info.title)) void updateTab(); });
window.addEventListener('unload', () => { disposed = true; clearTimeout(timer); clearTimeout(renderTimer); clearTimeout(refreshTimer); closeWatch(); });
async function tick() {
  if (disposed) return;
  await Promise.allSettled([refresh(), controlState()]);
  if (sessionID && !streamConnected && Date.now() >= nextWatchAt) void startWatch(sessionID);
  if (!disposed) timer = setTimeout(tick, streamConnected ? 8000 : 2500);
}
async function init() {
  windowID = (await chrome.windows.getCurrent()).id; await updateTab();
  const prefs = await chrome.storage.session.get(['sidepanel-model-preference', 'sidepanel-agent-preference', `sidepanel-session-${windowID}`]);
  currentModel = prefs['sidepanel-model-preference'] || null; currentAgent = prefs['sidepanel-agent-preference'] || ''; sessionID = prefs[`sidepanel-session-${windowID}`];
  await restoreDraft(); updateControls();
  try { await loadCatalog(); await listSessions(); if (sessionID) { await startWatch(sessionID); await refresh(); } }
  catch (error) { notice(error.message); }
  void chrome.runtime.sendMessage({ type: 'pair' }).catch(() => {}); void tick();
}
void init().catch(error => notice(error.message));
