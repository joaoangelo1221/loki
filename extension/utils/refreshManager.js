import { TabManager } from './tabManager.js';

const JOBS_KEY = 'refreshJobs';

/**
 * Gerencia jobs de atualização com persistência e fila.
 */
export class RefreshManager {
  constructor({ onStateChanged, getSettings }) {
    this.jobs = {};
    this.tickTimer = null;
    this.pendingByTab = new Map();
    this.processingQueue = false;
    this.onStateChanged = onStateChanged;
    this.getSettings = getSettings;
  }

  async hydrate() {
    const { [JOBS_KEY]: persistedJobs = {} } = await chrome.storage.local.get(JOBS_KEY);
    this.jobs = persistedJobs;
    this.ensureTicking();
    await this.restoreAlarms();
  }

  async persist() {
    await chrome.storage.local.set({ [JOBS_KEY]: this.jobs });
  }

  listJobs() {
    return Object.values(this.jobs);
  }

  getJob(jobId) {
    return this.jobs[jobId] || null;
  }

  async startJob({ tabIds, intervalMs, randomize = false, randomMinMs = null, randomMaxMs = null, name }) {
    const normalizedTabIds = [...new Set((tabIds || []).map(Number).filter(Number.isInteger))];
    if (!normalizedTabIds.length) throw new Error('Nenhuma aba válida selecionada.');
    if (intervalMs < 1000 || intervalMs > 24 * 60 * 60 * 1000) {
      throw new Error('Intervalo fora dos limites (1s a 24h).');
    }

    const now = Date.now();
    const jobId = this.buildJobId(name || 'scope', normalizedTabIds);
    const nextInterval = this.resolveInterval(intervalMs, randomize, randomMinMs, randomMaxMs);

    this.jobs[jobId] = {
      id: jobId,
      name: name || `Job ${jobId.slice(-4)}`,
      tabIds: normalizedTabIds,
      intervalMs,
      randomize,
      randomMinMs,
      randomMaxMs,
      status: 'running',
      lastRunAt: null,
      nextRunAt: now + nextInterval
    };

    await this.persist();
    await this.scheduleAlarm(jobId, this.jobs[jobId].nextRunAt);
    this.ensureTicking();
    this.emitChange();

    return this.jobs[jobId];
  }

  async stopJob(jobId) {
    if (!this.jobs[jobId]) return;
    this.jobs[jobId].status = 'stopped';
    this.jobs[jobId].nextRunAt = null;
    await chrome.alarms.clear(this.alarmName(jobId));
    await this.persist();
    this.emitChange();
  }

  async removeJob(jobId) {
    delete this.jobs[jobId];
    await chrome.alarms.clear(this.alarmName(jobId));
    await this.persist();
    this.emitChange();
  }

  async restartJob(jobId) {
    const job = this.jobs[jobId];
    if (!job) return;
    job.status = 'running';
    job.nextRunAt = Date.now() + this.resolveInterval(job.intervalMs, job.randomize, job.randomMinMs, job.randomMaxMs);
    await this.scheduleAlarm(jobId, job.nextRunAt);
    await this.persist();
    this.emitChange();
  }

  async handleAlarm(alarm) {
    if (!alarm?.name?.startsWith('refresh:')) return;
    const jobId = alarm.name.replace('refresh:', '');
    await this.runJob(jobId);
  }

  async runJob(jobId) {
    const job = this.jobs[jobId];
    if (!job || job.status !== 'running') return;

    const tabs = await TabManager.listTabs({});
    const existingTabIds = new Set(tabs.filter((t) => !!t.id).map((t) => t.id));
    job.tabIds = job.tabIds.filter((tabId) => existingTabIds.has(tabId));

    if (!job.tabIds.length) {
      await this.removeJob(jobId);
      return;
    }

    const settings = this.getSettings();
    const progressiveDelayMs = Math.max(0, Number(settings.progressiveDelayMs) || 0);
    const pauseInBackground = !!settings.pauseBackgroundRefresh;

    for (let index = 0; index < job.tabIds.length; index += 1) {
      const tabId = job.tabIds[index];
      if (pauseInBackground) {
        try {
          const tab = await TabManager.getTab(tabId);
          if (!tab.active) continue;
        } catch {
          continue;
        }
      }

      await this.enqueueRefresh(tabId);
      if (progressiveDelayMs > 0 && index < job.tabIds.length - 1) {
        await this.sleep(progressiveDelayMs * (index + 1));
      }
    }

    job.lastRunAt = Date.now();
    const nextInterval = this.resolveInterval(job.intervalMs, job.randomize, job.randomMinMs, job.randomMaxMs);
    job.nextRunAt = job.lastRunAt + nextInterval;
    await this.persist();
    await this.scheduleAlarm(jobId, job.nextRunAt);
    this.emitChange();
  }

  async enqueueRefresh(tabId) {
    const queue = this.pendingByTab.get('global') || [];
    queue.push(tabId);
    this.pendingByTab.set('global', queue);
    if (!this.processingQueue) {
      this.processingQueue = true;
      while ((this.pendingByTab.get('global') || []).length) {
        const nextTabId = this.pendingByTab.get('global').shift();
        try {
          await chrome.tabs.reload(nextTabId, { bypassCache: false });
        } catch (error) {
          console.warn(`Falha no reload da aba ${nextTabId}:`, error);
        }
      }
      this.processingQueue = false;
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
      if (job.status !== 'running' || !job.nextRunAt) continue;
      if (job.nextRunAt <= Date.now()) {
        await this.runJob(job.id);
      } else {
        await this.scheduleAlarm(job.id, job.nextRunAt);
      }
    }
  }

  async scheduleAlarm(jobId, runAtMs) {
    const when = Math.max(runAtMs, Date.now() + 60 * 1000);
    await chrome.alarms.create(this.alarmName(jobId), { when });
  }

  alarmName(jobId) {
    return `refresh:${jobId}`;
  }

  resolveInterval(intervalMs, randomize, randomMinMs, randomMaxMs) {
    if (!randomize) return intervalMs;

    const min = Math.max(1000, Number(randomMinMs) || Math.floor(intervalMs * 0.7));
    const max = Math.min(24 * 60 * 60 * 1000, Number(randomMaxMs) || Math.ceil(intervalMs * 1.3));
    const lower = Math.min(min, max);
    const upper = Math.max(min, max);
    return Math.floor(Math.random() * (upper - lower + 1)) + lower;
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

  ensureTicking() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.emitChange(), 1000);
  }

  emitChange() {
    if (typeof this.onStateChanged === 'function') {
      this.onStateChanged(this.getCountdowns());
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
