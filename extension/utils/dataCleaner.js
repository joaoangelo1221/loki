import { TabManager } from './tabManager.js';

/**
 * Camada de limpeza de dados com escopo.
 */
export class DataCleaner {
  static buildRemovalOptions(types) {
    return {
      cache: !!types.cache,
      cookies: !!types.cookies,
      localStorage: !!types.localStorage
    };
  }

  static async clean(scope, types = { cache: true, cookies: true, localStorage: true, sessionStorage: true }) {
    const dataToRemove = this.buildRemovalOptions(types);
    const targetTabs = await this.resolveTargetTabs(scope);
    const targetOrigins = this.collectOrigins(targetTabs);

    if (scope === 'all') {
      await chrome.browsingData.remove({ since: 0 }, dataToRemove);
      if (types.sessionStorage) {
        await this.clearSessionStorageForTabs(targetTabs);
      }
      return { scope, success: true };
    }

    if (!targetOrigins.length) {
      throw new Error('Não foi possível determinar origens para o escopo selecionado.');
    }

    await chrome.browsingData.remove({ origins: targetOrigins }, dataToRemove);
    if (types.sessionStorage) {
      await this.clearSessionStorageForTabs(targetTabs);
    }
    return { scope, success: true, origins: targetOrigins };
  }

  static extractOrigin(url) {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }

  static async resolveTargetTabs(scope) {
    if (scope === 'all') return TabManager.listTabs({});

    const currentTab = await TabManager.getCurrentTab();
    if (!currentTab?.id) return [];

    if (scope === 'current') return [currentTab];

    if (scope === 'domain') {
      const domain = TabManager.getDomainFromUrl(currentTab.url);
      if (!domain) return [currentTab];
      return TabManager.getTabsByDomain(domain);
    }

    return [currentTab];
  }

  static collectOrigins(tabs = []) {
    const origins = new Set();
    tabs.forEach((tab) => {
      const origin = this.extractOrigin(tab.url);
      if (origin) origins.add(origin);
    });
    return [...origins];
  }

  static async clearSessionStorageForTabs(tabs = []) {
    const clearableTabs = tabs.filter((tab) => Number.isInteger(tab?.id) && /^https?:/.test(tab.url || ''));
    await Promise.all(
      clearableTabs.map(async (tab) => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => sessionStorage.clear()
          });
        } catch (error) {
          console.warn(`Falha ao limpar sessionStorage na aba ${tab.id}:`, error);
        }
      })
    );
  }
}
