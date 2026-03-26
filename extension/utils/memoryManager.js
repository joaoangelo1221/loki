import { TabManager } from './tabManager.js';

/**
 * Gerenciamento de memória com descarte de abas inativas.
 */
export class MemoryManager {
  constructor() {
    this.lastActiveByTab = {};
  }

  hydrate(lastActiveByTab = {}) {
    this.lastActiveByTab = { ...lastActiveByTab };
  }

  exportState() {
    return { ...this.lastActiveByTab };
  }

  markTabActive(tabId, timestamp = Date.now()) {
    this.lastActiveByTab[String(tabId)] = timestamp;
  }

  removeTab(tabId) {
    delete this.lastActiveByTab[String(tabId)];
  }

  async discardInactiveTabs(inactiveMinutes, { includePinned = false } = {}) {
    const now = Date.now();
    const threshold = now - inactiveMinutes * 60 * 1000;
    const tabs = await TabManager.listTabs({});
    const discarded = [];

    for (const tab of tabs) {
      if (!tab.id || tab.active || tab.discarded) continue;
      if (!includePinned && tab.pinned) continue;
      if (!/^https?:/.test(tab.url || '')) continue;

      const lastActive = this.lastActiveByTab[String(tab.id)] || tab.lastAccessed || now;
      if (lastActive > threshold) continue;

      try {
        await chrome.tabs.discard(tab.id);
        discarded.push(tab.id);
      } catch (error) {
        console.warn(`Falha ao descartar aba ${tab.id}:`, error);
      }
    }

    return discarded;
  }
}
