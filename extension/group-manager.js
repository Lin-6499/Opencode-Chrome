class TemporaryGroups {
  constructor() { this.records = new Map(); this.queue = Promise.resolve(); this.restored = new Map(); }
  job(work) { const run = this.queue.then(work); this.queue = run.catch(() => {}); return run; }
  async save() { await chrome.storage.session.set({ taskGroups: [...this.records.values()], taskGroup: null }); }
  async recover(saved, legacy) {
    for (const record of [...(saved || []), ...(legacy ? [legacy] : [])]) this.records.set(record.tabId, record);
    for (const record of [...this.records.values()]) await this.restore(record.tabId, record.taskToken);
  }
  attach(tabId, task, check) {
    return this.job(async () => {
      check();
      if (this.records.has(tabId)) return this.records.get(tabId);
      const tab = await chrome.tabs.get(tabId);
      if (tab.pinned) throw new Error('固定标签页不能临时分组，请先取消固定；工具不会擅自取消固定。');
      let originalGroup;
      if (tab.groupId >= 0) originalGroup = await chrome.tabGroups.get(tab.groupId);
      if (originalGroup) {
        for (const record of this.records.values()) if (record.windowId === tab.windowId && record.originalGroup?.id === originalGroup.id) {
          record.originalGroup = { id: originalGroup.id, title: originalGroup.title || '', color: originalGroup.color, collapsed: originalGroup.collapsed };
        }
      }
      check();
      let groupId;
      const sibling = [...this.records.values()].find(record => record.taskToken === task.token && record.windowId === tab.windowId);
      if (sibling) { try { await chrome.tabGroups.get(sibling.groupId); groupId = sibling.groupId; } catch { /* Group was manually changed. */ } }
      groupId = await chrome.tabs.group({ tabIds: [tabId], ...(groupId === undefined ? {} : { groupId }) });
      const record = { tabId, groupId, taskToken: task.token, windowId: tab.windowId, originalGroup: originalGroup ? { id: originalGroup.id, title: originalGroup.title || '', color: originalGroup.color, collapsed: originalGroup.collapsed } : null };
      this.records.set(tabId, record); await this.save(); check();
      await chrome.tabGroups.update(groupId, { title: task.summary, color: 'purple', collapsed: false });
      return record;
    });
  }
  restore(tabId, taskToken) {
    return this.job(async () => {
      const record = this.records.get(tabId);
      if (!record || (taskToken !== undefined && record.taskToken !== taskToken)) return;
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch { /* Tab was closed. */ }
      if (tab && tab.groupId === record.groupId) {
        if (record.originalGroup && tab.windowId === record.windowId) {
          const key = `${tab.windowId}:${record.originalGroup.id}`;
          let old;
          for (const id of [record.originalGroup.id, this.restored.get(key)]) {
            if (id === undefined) continue;
            try { const found = await chrome.tabGroups.get(id); if (found.windowId === tab.windowId) { old = found; break; } } catch { /* Original group may have lost its last member. */ }
          }
          if (old) await chrome.tabs.group({ tabIds: [tabId], groupId: old.id });
          else {
            const id = await chrome.tabs.group({ tabIds: [tabId] });
            await chrome.tabGroups.update(id, { title: record.originalGroup.title, color: record.originalGroup.color, collapsed: record.originalGroup.collapsed });
            this.restored.set(key, id);
          }
        } else await chrome.tabs.ungroup([tabId]);
      }
      // Preserve a user's manual move into another group.
      this.records.delete(tabId); await this.save();
    });
  }
}
