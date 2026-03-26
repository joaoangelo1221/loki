import { RefreshManager } from './utils/refreshManager.js';
import { TabManager } from './utils/tabManager.js';
import { DataCleaner } from './utils/dataCleaner.js';

const SETTINGS_KEY = 'globalSettings';
const TIMER_PREFIX = 'timer_';
const BADGE_TICK_MS = 1000;

const defaultSettings = {
  defaultIntervalMs: 30000,
  progressiveDelayMs: 250,
  pauseBackgroundRefresh: false
};

let settings = { ...defaultSettings };
const refreshManager = new RefreshManager({
  onStateChanged: (jobs) => broadcastState(jobs),
  getSettings: () => settings
});

async function init() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  settings = { ...defaultSettings, ...(stored[SETTINGS_KEY] || {}) };
  await refreshManager.hydrate();
}

async function saveSettings(nextSettings) {
  settings = { ...settings, ...nextSettings };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

function broadcastState(jobs = refreshManager.getCountdowns()) {
  chrome.runtime.sendMessage({
    type: 'REFRESH_STATE',
    jobs,
    settings
  }).catch(() => {});
}

function timerKey(tabId) {
  return `${TIMER_PREFIX}${tabId}`;
}

async function createRefreshAlarm(tabId, intervalSec) {
  await startRefresh(tabId, intervalSec);
}

async function scheduleNext(tabId, intervalSec) {
  const name = `refresh_${tabId}`;
  const safeIntervalSec = Math.max(1, Number(intervalSec) || 1);
  await chrome.alarms.create(name, {
    delayInMinutes: safeIntervalSec / 60
  });
}

async function startRefresh(tabId, intervalSec) {
  const safeIntervalSec = Math.max(1, Number(intervalSec) || 1);
  await chrome.storage.local.set({
    [timerKey(tabId)]: {
      interval: safeIntervalSec,
      nextExecution: Date.now() + safeIntervalSec * 1000
    }
  });
  await scheduleNext(tabId, safeIntervalSec);
}

async function removeRefreshTimer(tabId) {
  await stopRefresh(tabId);
}

async function stopRefresh(tabId) {
  await chrome.alarms.clear(`refresh_${tabId}`);
  await chrome.storage.local.remove(timerKey(tabId));
  await chrome.action.setBadgeText({ text: '', tabId });
  await updateBadgeForActiveTab();
}

async function syncTimersFromJobs() {
  const jobs = refreshManager.listJobs();
  const runningEntries = jobs
    .filter((job) => job.status === 'running')
    .flatMap((job) =>
      job.tabIds.map((tabId) => [
        timerKey(tabId),
        {
          interval: Math.max(1, Math.round(job.intervalMs / 1000)),
          nextExecution: job.nextRunAt || Date.now() + Math.max(1, Math.round(job.intervalMs / 1000)) * 1000
        }
      ])
    );

  const storageTimers = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(storageTimers).filter((key) => key.startsWith(TIMER_PREFIX));
  if (keysToRemove.length) {
    await chrome.storage.local.remove(keysToRemove);
  }

  if (runningEntries.length) {
    await chrome.storage.local.set(Object.fromEntries(runningEntries));
  }
}

async function restoreTimers() {
  const items = await chrome.storage.local.get(null);
  await Promise.all(
    Object.keys(items)
      .filter((key) => key.startsWith(TIMER_PREFIX))
      .map(async (key) => {
        const tabId = Number.parseInt(key.split('_')[1], 10);
        const data = items[key];
        if (!Number.isInteger(tabId) || !data?.interval) return;
        await scheduleNext(tabId, data.interval);
      })
  );
}

async function updateBadgeForActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return;

  const tabId = tabs[0]?.id;
  if (!Number.isInteger(tabId)) return;

  const data = await chrome.storage.local.get(timerKey(tabId));
  const timer = data[timerKey(tabId)];

  if (!timer) {
    await chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  const remaining = Math.max(0, Math.floor((timer.nextExecution - Date.now()) / 1000));
  await chrome.action.setBadgeText({
    text: remaining.toString(),
    tabId
  });
  await chrome.action.setBadgeBackgroundColor({
    color: '#FF0000',
    tabId
  });
}

chrome.runtime.onInstalled.addListener(() => {
  (async () => {
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      await init();
      await restoreTimers();
    } catch (error) {
      console.error('Erro no onInstalled:', error);
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    try {
      await init();
      await restoreTimers();
    } catch (error) {
      console.error('Erro no startup:', error);
    }
  })();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (!alarm.name.startsWith('refresh_')) return;
    const tabId = Number.parseInt(alarm.name.split('_')[1], 10);
    if (!Number.isInteger(tabId)) return;

    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) {
        await removeRefreshTimer(tabId);
        return;
      }
    } catch {
      await removeRefreshTimer(tabId);
      return;
    }

    await refreshManager.handleAlarm(alarm);

    const timerData = await chrome.storage.local.get(timerKey(tabId));
    const entry = timerData[timerKey(tabId)];
    if (entry?.interval) {
      await scheduleNext(tabId, entry.interval);
      entry.nextExecution = Date.now() + entry.interval * 1000;
      await chrome.storage.local.set({ [timerKey(tabId)]: entry });
    } else {
      await chrome.alarms.clear(alarm.name);
    }
  } catch (error) {
    console.error('Erro no processamento do alarme:', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.action === 'start_refresh') {
        const candidateTabIds = Array.isArray(message.tabIds) ? message.tabIds : [message.tabId];
        const tabIds = candidateTabIds.map(Number).filter(Number.isInteger);
        const intervalSec = Math.max(1, Number(message.interval) || 1);
        if (!tabIds.length) {
          throw new Error('Nenhuma aba válida selecionada.');
        }
        const job = await refreshManager.startJob({
          tabIds,
          intervalMs: intervalSec * 1000,
          name: message.name || 'current'
        });
        await Promise.all(tabIds.map((tabId) => createRefreshAlarm(tabId, intervalSec)));
        sendResponse({ ok: true, job });
        return;
      }

      const actionType = message?.type;
      switch (actionType) {
        case 'GET_STATE': {
          const currentTab = await TabManager.getCurrentTab();
          const allTabs = await TabManager.listTabs({ currentWindow: true });
          sendResponse({
            ok: true,
            jobs: refreshManager.getCountdowns(),
            settings,
            currentTab,
            tabs: allTabs
          });
          break;
        }
        case 'START_REFRESH': {
          const job = await refreshManager.startJob(message.payload);
          for (const tabId of job.tabIds) {
            await createRefreshAlarm(tabId, Math.max(1, Math.round(job.intervalMs / 1000)));
          }
          sendResponse({ ok: true, job });
          break;
        }
        case 'STOP_REFRESH': {
          await refreshManager.stopJob(message.payload.jobId);
          const job = refreshManager.jobs[message.payload.jobId];
          if (job?.tabIds?.length) {
            await Promise.all(job.tabIds.map((tabId) => removeRefreshTimer(tabId)));
          } else {
            await syncTimersFromJobs();
          }
          sendResponse({ ok: true });
          break;
        }
        case 'RESTART_REFRESH': {
          await refreshManager.restartJob(message.payload.jobId);
          await syncTimersFromJobs();
          sendResponse({ ok: true });
          break;
        }
        case 'REMOVE_REFRESH': {
          const job = refreshManager.jobs[message.payload.jobId];
          await refreshManager.removeJob(message.payload.jobId);
          if (job?.tabIds?.length) {
            await Promise.all(job.tabIds.map((tabId) => removeRefreshTimer(tabId)));
          } else {
            await syncTimersFromJobs();
          }
          sendResponse({ ok: true });
          break;
        }
        case 'GET_SCOPE_TABS': {
          const tabIds = await TabManager.resolveScopeTabs(message.payload.scope, message.payload.selectedTabIds);
          sendResponse({ ok: true, tabIds });
          break;
        }
        case 'CLEAN_DATA': {
          const result = await DataCleaner.clean(message.payload.scope, message.payload.types);
          sendResponse({ ok: true, result });
          break;
        }
        case 'SAVE_SETTINGS': {
          await saveSettings(message.payload);
          sendResponse({ ok: true, settings });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Ação não reconhecida.' });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});

init().catch((error) => console.error('Erro na inicialização:', error));
setInterval(() => {
  updateBadgeForActiveTab().catch((error) => console.warn('Falha ao atualizar badge:', error));
}, BADGE_TICK_MS);

chrome.tabs.onActivated.addListener(() => {
  updateBadgeForActiveTab().catch((error) => console.warn('Falha ao sincronizar badge ao ativar aba:', error));
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    updateBadgeForActiveTab().catch((error) => console.warn('Falha ao sincronizar badge ao atualizar aba:', error));
  }
});
