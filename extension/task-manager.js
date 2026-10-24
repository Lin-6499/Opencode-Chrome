class BrowserTasks {
  constructor(notify = () => {}) {
    this.tasks = new Map(); this.tabs = new Map(); this.pausedOwners = new Set(); this.cancelledAt = new Map(); this.lifecycle = new Map();
    this.groups = new TemporaryGroups(); this.notify = notify; this.userPaused = false; this.lastError = '';
    this.ready = chrome.storage.session.get(['userPaused', 'pausedOwners', 'taskGroups', 'taskGroup']).then(async data => {
      this.userPaused = !!data.userPaused; this.pausedOwners = new Set(data.pausedOwners || []);
      try { await this.groups.recover(data.taskGroups, data.taskGroup); }
      catch (error) { this.lastError = `临时分组恢复失败，可重试：${error.message}`; }
    });
  }
  summary(text) { return [...String(text || '浏览器任务').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 40).join('') || '浏览器任务'; }
  async savePause() { await chrome.storage.session.set({ userPaused: this.userPaused, pausedOwners: [...this.pausedOwners] }); }
  isPaused(owner) { return this.userPaused || this.pausedOwners.has(owner); }
  assertTask(task) {
    if (this.isPaused(task.owner)) throw new Error('用户已停止并接管。请在扩展菜单中手动恢复；工具不能自行恢复。');
    if (this.tasks.get(task.owner) !== task) throw new Error('Task changed or stopped; do not blindly retry an issued action.');
  }
  assertTab(state, documentVersion) {
    this.assertTask(state.task);
    if (state.closing || this.tabs.get(state.tabId) !== state) throw new Error('Tab changed or stopped');
    if (documentVersion !== undefined && state.documentVersion !== documentVersion) throw new Error('Document changed; inspect again.');
  }
  normal(tab) { if (!/^https?:\/\//.test(tab?.url || '')) throw new Error('仅支持普通 HTTP/HTTPS 网页，不能控制 chrome:// 等浏览器内部页面。'); return tab; }
  info(tab) { const url = new URL(tab.url); return { tabId: tab.id, title: tab.title || '', url: `${url.origin}${url.pathname}`, active: !!tab.active, windowId: tab.windowId }; }
  create(owner, summary) {
    if (this.isPaused(owner)) throw new Error('用户已接管，请在扩展中手动恢复。');
    const task = { owner, token: crypto.randomUUID(), summary: this.summary(summary), startedAt: Date.now(), lastActivity: Date.now(), activeTab: undefined, tabs: new Map() };
    this.tasks.set(owner, task); return task;
  }
  async chooseTab(task, tabId) {
    this.assertTask(task);
    if (tabId === undefined) tabId = task.activeTab;
    if (tabId === undefined) {
      const list = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (list.length !== 1) throw new Error('请使用 list_tabs 指定目标标签页。');
      tabId = list[0].id;
    }
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tabId');
    const tab = this.normal(await chrome.tabs.get(tabId)); this.assertTask(task); return tab;
  }
  async acquire(task, tab) {
    this.assertTask(task);
    let state = this.tabs.get(tab.id);
    if (state?.closing) {
      await state.cleanup;
      if (this.tabs.get(tab.id) === state) throw new Error('前一个任务仍有已派发操作正在结束，此页暂不能重新接管。');
      state = this.tabs.get(tab.id);
    }
    this.assertTask(task);
    if (state && state.task !== task) throw new Error('This tab belongs to another OpenCode session. Other tabs may be controlled independently.');
    if (!state) {
      if (task.tabs.size >= 8) throw new Error('每个任务最多同时接管 8 个标签页，请先结束任务或减少目标。');
      state = { task, tabId: tab.id, attached: false, closing: false, documentVersion: 0, inFlight: 0, queue: Promise.resolve() };
      this.tabs.set(tab.id, state); task.tabs.set(tab.id, state);
      state.setup = (async () => {
        const previous = this.groups.records.get(tab.id);
        if (previous && previous.taskToken !== task.token) await this.groups.restore(tab.id, previous.taskToken);
        this.assertTab(state);
        await this.groups.attach(tab.id, task, () => this.assertTab(state));
        this.assertTab(state); await chrome.debugger.attach({ tabId: tab.id }, '1.3'); state.attached = true;
        this.assertTab(state); await showFrameOverlay(tab.id, 0, 'status', {}); this.assertTab(state);
      })();
    }
    try { await state.setup; this.assertTab(state); }
    catch (error) { await this.cleanTab(state); throw error; }
    task.activeTab = tab.id; return state;
  }
  cleanTab(state) {
    if (state.cleanup) return state.cleanup;
    state.closing = true; state.documentVersion++; clearPageReferences(state.tabId);
    state.cleanup = (async () => {
      await state.setup?.catch(() => {});
      if (state.attached) await chrome.debugger.detach({ tabId: state.tabId }).catch(() => {});
      await removeFrameOverlays(state.tabId);
      try { await this.groups.restore(state.tabId, state.task.token); }
      catch (error) { this.lastError = `临时分组恢复失败：${error.message}`; }
      const release = () => {
        if (this.tabs.get(state.tabId) === state) this.tabs.delete(state.tabId);
        state.task.tabs.delete(state.tabId);
        if (state.task.activeTab === state.tabId) state.task.activeTab = state.task.tabs.keys().next().value;
      };
      if (state.inFlight) {
        let timeout;
        await Promise.race([state.queue.catch(() => {}), new Promise(resolve => { timeout = setTimeout(resolve, 1500); })]);
        clearTimeout(timeout);
      }
      if (state.inFlight) { state.draining = true; void state.queue.finally(release).catch(() => {}); }
      else release();
    })();
    return state.cleanup;
  }
  async end(owner, expectedTask) {
    const task = this.tasks.get(owner);
    if (expectedTask && task !== expectedTask) return { released: true, taskEnded: true, groupRestored: true, paused: this.isPaused(owner) };
    if (!task) return { released: true, taskEnded: true, groupRestored: true, paused: this.isPaused(owner) };
    this.tasks.delete(owner); // Invalidate queued operations before awaiting Chrome.
    await Promise.all([...task.tabs.values()].map(state => this.cleanTab(state)));
    const restored = ![...this.groups.records.values()].some(record => record.taskToken === task.token);
    return { released: true, taskEnded: true, groupRestored: restored, paused: this.isPaused(owner) };
  }
  async cleanupOwner(owner, endedAt) {
    if (!Number.isFinite(endedAt)) throw new Error('Invalid cleanup cutoff');
    this.cancelledAt.set(owner, Math.max(this.cancelledAt.get(owner) || 0, endedAt));
    const task = this.tasks.get(owner);
    const matched = !!task && task.startedAt <= endedAt;
    const result = matched ? await this.end(owner) : { groupRestored: true };
    return { matched, cleaned: result.groupRestored, cutoffApplied: true };
  }
  async pauseOwner(owner, reason = 'User took over') {
    this.pausedOwners.add(owner); await this.savePause();
    const endedAt = Date.now(); this.cancelledAt.set(owner, endedAt);
    this.notify({ type: 'owner_stopped', owner, endedAt, reason }); return this.end(owner);
  }
  async pauseAll() {
    this.userPaused = true; await this.savePause();
    await Promise.all([...this.tasks.keys()].map(owner => this.pauseOwner(owner)));
  }
  async resume() { this.userPaused = false; this.pausedOwners.clear(); await this.savePause(); }
  status(owner) {
    const task = this.tasks.get(owner);
    return { paused: this.isPaused(owner), busy: false, taskCount: this.tasks.size, pageCount: [...this.tabs.values()].filter(state => !state.closing).length, targetTab: task?.activeTab ?? null, selectedTab: task?.activeTab ?? null, tabIds: task ? [...task.tabs.keys()] : [], taskSummary: task?.summary || '', groupId: task?.activeTab === undefined ? null : this.groups.records.get(task.activeTab)?.groupId ?? null, lockedTabs: [...this.tabs.values()].filter(state => state.task.owner !== owner).map(state => state.tabId), websitePermission: 'all-http-https', lastError: this.lastError };
  }
  async run(method, args, owner = 'legacy', created = Date.now(), inLifecycle = false) {
    await this.ready;
    if (typeof owner !== 'string' || !owner || owner.length > 300) throw new Error('Invalid task owner');
    if (!inLifecycle && ['begin_task','end_task','release'].includes(method)) {
      const next = (this.lifecycle.get(owner) || Promise.resolve()).then(() => this.run(method, args, owner, created, true));
      const tail = next.catch(() => {}); this.lifecycle.set(owner, tail);
      void tail.then(() => { if (this.lifecycle.get(owner) === tail) this.lifecycle.delete(owner); });
      return next;
    }
    if (method === 'get_status') return this.status(owner);
    if (method === 'list_tabs') return (await chrome.tabs.query({})).filter(tab => /^https?:\/\//.test(tab.url || '')).map(tab => this.info(tab));
    if (this.isPaused(owner) && !['end_task','release'].includes(method)) throw new Error('用户已停止并接管。请在扩展菜单中手动恢复；工具不能自行恢复。');
    if (created <= (this.cancelledAt.get(owner) || 0)) throw new Error('Task request was cancelled before execution');
    if (method === 'release' || method === 'end_task') return this.end(owner);
    if (method === 'begin_task') {
      if (typeof args.summary !== 'string' || !args.summary.trim()) throw new Error('Task summary is required');
      if (args.tabIds !== undefined && args.tabId !== undefined) throw new Error('Use tabId or tabIds, not both');
      const ids = args.tabIds || (args.tabId === undefined ? [] : [args.tabId]);
      if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => !Number.isInteger(id) || id < 0)) throw new Error('Invalid target tabs');
      const checked = await Promise.all([...new Set(ids)].map(async id => this.normal(await chrome.tabs.get(id))));
      await this.end(owner); const task = this.create(owner, args.summary);
      try {
        const targets = checked.length ? checked : [await this.chooseTab(task)];
        for (const tab of targets) await this.acquire(task, tab);
        return { tabId: task.activeTab, tabIds: [...task.tabs.keys()], summary: task.summary, groupId: this.groups.records.get(task.activeTab)?.groupId };
      } catch (error) { await this.end(owner, task); throw error; }
    }
    if (!['select_tab','inspect','highlight','click','type','scroll','wait_for'].includes(method)) throw new Error('Unknown operation');
    const refTab = args.ref ? referencedTab(args.ref) : undefined;
    if (args.ref && refTab === undefined) throw new Error('Unknown/stale ref. Inspect the page first.');
    if (args.ref && args.tabId !== undefined && args.tabId !== refTab) throw new Error('Reference belongs to a different tab');
    const task = this.tasks.get(owner) || this.create(owner, ({ inspect: '读取网页结构', highlight: '高亮网页元素', click: '网页点击操作', type: '网页文字输入', scroll: '浏览网页' })[method]);
    let state;
    try { state = await this.acquire(task, await this.chooseTab(task, args.tabId ?? refTab)); }
    catch (error) { if (!task.tabs.size && this.tasks.get(owner) === task) this.tasks.delete(owner); throw error; }
    if (method === 'select_tab') return { ...this.info(await chrome.tabs.get(state.tabId)), tabIds: [...task.tabs.keys()] };
    const job = state.queue.then(async () => {
      this.assertTab(state); state.inFlight++; task.lastActivity = Date.now();
      const version = state.documentVersion;
      const control = { check: () => this.assertTab(state, version), changed: () => state.documentVersion !== version, active: () => this.tasks.get(owner) === task && this.tabs.get(state.tabId) === state && !state.closing, isPaused: () => this.isPaused(owner) };
      try { return await executePageAction(method, args, state.tabId, control); }
      finally { state.inFlight--; task.lastActivity = Date.now(); }
    });
    state.queue = job.catch(() => {}); return job;
  }
  navigation(tabId) {
    const state = this.tabs.get(tabId); if (!state || state.closing) return;
    if (!state.loading) { state.loading = true; state.documentVersion++; clearPageReferences(tabId); }
  }
  async readyPage(tabId, complete = true) {
    const state = this.tabs.get(tabId); if (!state || state.closing || !state.attached) return;
    if (complete) state.loading = false;
    try { this.assertTab(state); await showFrameOverlay(tabId, 0, 'status', {}); } catch { /* Browser-protected document or task ended. */ }
  }
  async tabClosed(tabId) {
    const state = this.tabs.get(tabId); if (!state || state.closing) return;
    await this.cleanTab(state);
    if (!state.task.tabs.size && this.tasks.get(state.task.owner) === state.task) { this.tasks.delete(state.task.owner); this.pausedOwners.add(state.task.owner); await this.savePause(); }
  }
  async detached(tabId, reason) {
    const state = this.tabs.get(tabId); if (!state || state.closing) return;
    if (reason === 'target_closed') return this.tabClosed(tabId);
    return this.pauseOwner(state.task.owner, 'Chrome debugger detached');
  }
  async sweepIdle() {
    await this.ready;
    for (const task of [...this.tasks.values()]) if (Date.now() - task.lastActivity > 5 * 60 * 1000 && ![...task.tabs.values()].some(state => state.inFlight)) await this.end(task.owner);
  }
}
