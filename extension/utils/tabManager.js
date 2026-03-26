/**
 * Utilitários de gerenciamento e filtro de abas.
 */
export class TabManager {
  static async listTabs(query = {}) {
    return chrome.tabs.query(query);
  }

  static async getTab(tabId) {
    return chrome.tabs.get(tabId);
  }

  static getDomainFromUrl(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'chrome:' || parsed.protocol === 'edge:' || parsed.protocol === 'about:') {
        return null;
      }
      return parsed.hostname;
    } catch {
      return null;
    }
  }

  static async getCurrentTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  static async getTabsByDomain(domain) {
    if (!domain) return [];
    const allTabs = await this.listTabs({});
    return allTabs.filter((tab) => this.getDomainFromUrl(tab.url) === domain);
  }

  static async groupTabsByDomain(tabIds) {
    const groups = new Map();
    for (const tabId of tabIds) {
      try {
        const tab = await this.getTab(tabId);
        const domain = this.getDomainFromUrl(tab.url);
        if (!domain) continue;
        if (!groups.has(domain)) groups.set(domain, []);
        groups.get(domain).push(tab.id);
      } catch (error) {
        console.warn(`Falha ao agrupar aba ${tabId}:`, error);
      }
    }
    return groups;
  }

  static async resolveScopeTabs(scope, selectedTabIds = []) {
    if (scope === 'selected') {
      return [...new Set(selectedTabIds.map(Number).filter(Number.isInteger))];
    }

    if (scope === 'all') {
      const allTabs = await this.listTabs({});
      return allTabs.filter((t) => !!t.id).map((t) => t.id);
    }

    const current = await this.getCurrentTab();
    if (!current?.id) return [];

    if (scope === 'current') {
      return [current.id];
    }

    if (scope === 'domain') {
      const domain = this.getDomainFromUrl(current.url);
      if (!domain) return [current.id];
      const sameDomainTabs = await this.getTabsByDomain(domain);
      return sameDomainTabs.filter((t) => !!t.id).map((t) => t.id);
    }

    return [current.id];
  }

  static async batchExecute(tabIds, action) {
    const results = [];
    for (const tabId of tabIds) {
      try {
        const result = await action(tabId);
        results.push({ tabId, ok: true, result });
      } catch (error) {
        console.warn(`Erro ao executar ação na aba ${tabId}:`, error);
        results.push({ tabId, ok: false, error: error?.message || String(error) });
      }
    }
    return results;
  }
}
