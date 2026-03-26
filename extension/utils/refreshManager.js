import { TabManager } from './tabManager.js';

const JOBS_KEY = 'refreshJobs';
const TIMERS_KEY = 'timers';

/**
 * Gerencia jobs de atualização com persistência via alarms.
 */
export class RefreshManager {
  constructor({ onStateChanged, getSettings }) {
    this.jobs = {};
    this.timerToJob = {};
    this.onStateChanged = onStateChanged;
    this.getSettings = getSettings;
  }

  async hydrate() {
    const stored = await chrome.storage.local.get([JOBS_KEY, TIMERS_KEY]);
    this.jobs = stored[JOBS_KEY] || {};
    this.timerToJob = stored[TIMERS_KEY] || {};
    await this.restoreAlarms();
    this.emitChange();
  }

  async persist() {
    await chrome.storage.local.set({ [JOBS_KEY]: this.jobs, [TIMERS_KEY]: this.timerToJob });
  }

  listJobs() {
    return Object.values(this.jobs);
  }

  async startJob({ tabIds, intervalMs, name }) {
    const normalizedTabIds = [...new Set((tabIds || []).map(Number).filter(Number.isInteger))];
    if (!normalizedTabIds.length) throw new Error('Nenhuma aba válida selecionada.');
    if (intervalMs < 1000 || intervalMs > 24 * 60 * 60 * 1000) {
      throw new Error('Intervalo fora dos limites (1s a 24h).');
    }

    const now = Date.now();
    const jobId = this.buildJobId(name || 'scope', normalizedTabIds);

    this.jobs[jobId] = {
      id: jobId,
      name: name || `Job ${jobId.slice(-4)}`,
      tabIds: normalizedTabIds,
      intervalMs,
      status: 'running',
      lastRunAt: null,
      nextRunAt: now + intervalMs
    };

    for (const tabId of normalizedTabIds) {
      this.timerToJob[String(tabId)] = {
        interval: intervalMs,
        scope: this.resolveScopeName(name),
        jobId
      };
      await this.createTabAlarm(tabId, intervalMs);
    }

    await this.persist();
    this.emitChange();
    return this.jobs[jobId];
  }

  async stopJob(jobId) {
    const job = this.jobs[jobId];
    if (!job) return;

    job.status = 'stopped';
    job.nextRunAt = null;
    for (const tabId of job.tabIds) {
      await chrome.alarms.clear(this.alarmName(tabId));
    }
    await this.persist();
    this.emitChange();
  }

  async removeJob(jobId) {
    const job = this.jobs[jobId];
    if (!job) return;

    for (const tabId of job.tabIds) {
      await chrome.alarms.clear(this.alarmName(tabId));
      delete this.timerToJob[String(tabId)];
    }

    delete this.jobs[jobId];
    await this.persist();
    this.emitChange();
  }

  async restartJob(jobId) {
    const job = this.jobs[jobId];
    if (!job) return;

    job.status = 'running';
    const nextInterval = job.intervalMs;
    job.nextRunAt = Date.now() + nextInterval;

    for (const tabId of job.tabIds) {
      await this.createTabAlarm(tabId, nextInterval);
    }

    await this.persist();
    this.emitChange();
  }

  async handleAlarm(alarm) {
    if (!alarm?.name?.startsWith('refresh_')) return;
    const tabId = Number.parseInt(alarm.name.split('_')[1], 10);
    if (!Number.isInteger(tabId)) return;
    await this.runTab(tabId);
  }

  async runTab(tabId) {
    const timerInfo = this.timerToJob[String(tabId)];
    if (!timerInfo?.jobId) return;

    const job = this.jobs[timerInfo.jobId];
    if (!job || job.status !== 'running') return;

    try {
      const tab = await TabManager.getTab(tabId);
      if (!tab?.id) return;

      const settings = this.getSettings();
      const pauseInBackground = !!settings.pauseBackgroundRefresh;
      if (pauseInBackground && !tab.active) return;

      await chrome.tabs.reload(tabId);
      job.lastRunAt = Date.now();
      const nextInterval = job.intervalMs;
      job.nextRunAt = job.lastRunAt + nextInterval;

      await this.persist();
      this.emitChange();
    } catch (error) {
      console.warn(`Falha no reload da aba ${tabId}:`, error);
    }
  }

  getCountdowns() {
    const now = Date.now();
    return this.listJobs().map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      tabIds: job.tabIds,
      lastRunAt: job.lastRunAt,
      nextRunAt: job.nextRunAt,
      secondsLeft: job.status === 'running' && job.nextRunAt ? Math.max(0, Math.ceil((job.nextRunAt - now) / 1000)) : null
    }));
  }

  async restoreAlarms() {
    for (const job of this.listJobs()) {
      if (job.status !== 'running') continue;
      for (const tabId of job.tabIds) {
        await this.createTabAlarm(tabId, job.intervalMs);
      }
    }
  }

  async createTabAlarm(tabId, intervalMs) {
    const intervalMinutes = Math.max(1, intervalMs / 1000) / 60;
    await chrome.alarms.create(this.alarmName(tabId), {
      delayInMinutes: intervalMinutes
    });
  }

  alarmName(tabId) {
    return `refresh_${tabId}`;
  }

  buildJobId(name, tabIds) {
    const raw = `${name}:${tabIds.sort((a, b) => a - b).join(',')}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i += 1) {
      hash = (hash << 5) - hash + raw.charCodeAt(i);
      hash |= 0;
    }
    return `job_${Math.abs(hash)}`;
  }

  resolveScopeName(name) {
    if (name === 'current' || name === 'domain' || name === 'all') return name;
    return 'tab';
  }

  emitChange() {
    if (typeof this.onStateChanged === 'function') {
      this.onStateChanged(this.getCountdowns());
    }
  }
}
