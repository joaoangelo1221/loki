const elements = {
  defaultInterval: document.getElementById('defaultInterval'),
  progressiveDelay: document.getElementById('progressiveDelay'),
  pauseBackgroundRefresh: document.getElementById('pauseBackgroundRefresh'),
  saveBtn: document.getElementById('saveBtn'),
  status: document.getElementById('status')
};

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.style.color = error ? '#ff9c9c' : '#8be9a8';
}

async function loadState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!response?.ok) throw new Error(response?.error || 'Falha ao carregar estado.');

    const settings = response.settings || {};
    elements.defaultInterval.value = Math.max(1, Math.round((settings.defaultIntervalMs || 30000) / 1000));
    elements.progressiveDelay.value = settings.progressiveDelayMs ?? 250;
    elements.pauseBackgroundRefresh.checked = !!settings.pauseBackgroundRefresh;
  } catch (error) {
    throw new Error(error?.message || 'Falha ao carregar estado.');
  }
}

async function saveSettings() {
  try {
    const payload = {
      defaultIntervalMs: Math.max(1, Number(elements.defaultInterval.value || 30)) * 1000,
      progressiveDelayMs: Math.max(0, Number(elements.progressiveDelay.value || 0)),
      pauseBackgroundRefresh: elements.pauseBackgroundRefresh.checked
    };

    const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload });
    if (!response?.ok) throw new Error(response?.error || 'Falha ao salvar configurações.');
  } catch (error) {
    throw new Error(error?.message || 'Falha ao salvar configurações.');
  }
}

elements.saveBtn.addEventListener('click', async () => {
  try {
    await saveSettings();
    setStatus('Configurações salvas com sucesso.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

loadState().catch((error) => setStatus(error.message, true));
