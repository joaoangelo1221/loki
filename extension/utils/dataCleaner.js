import { TabManager } from './tabManager.js';

/**
 * Camada de limpeza de dados com escopo.
 */
export class DataCleaner {
  static buildRemovalOptions(types) {
    return {
      cache: !!types.cache,
      cookies: !!types.cookies,
      localStorage: !!types.localStorage,
      sessionStorage: !!types.sessionStorage
    };
  }

  static async clean(scope, types = { cache: true, cookies: true, localStorage: true, sessionStorage: true }) {
    const dataToRemove = this.buildRemovalOptions(types);

    if (scope === 'all') {
      await chrome.browsingData.remove({ since: 0 }, dataToRemove);
      return { scope, success: true };
    }

    const currentTab = await TabManager.getCurrentTab();
    const originTypes = new Set();

    if (scope === 'current' && currentTab?.url) {
      const origin = this.extractOrigin(currentTab.url);
      if (origin) originTypes.add(origin);
    }

    if (scope === 'domain' && currentTab?.url) {
      const domain = TabManager.getDomainFromUrl(currentTab.url);
      if (domain) {
        const tabs = await TabManager.getTabsByDomain(domain);
        tabs.forEach((tab) => {
          const origin = this.extractOrigin(tab.url);
          if (origin) originTypes.add(origin);
        });
      }
    }

    if (!originTypes.size) {
      throw new Error('Não foi possível determinar origens para o escopo selecionado.');
    }

    await chrome.browsingData.remove({ origins: [...originTypes] }, dataToRemove);
    return { scope, success: true, origins: [...originTypes] };
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
}
