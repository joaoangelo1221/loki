const elements = {
  intervalValue: document.getElementById('intervalValue'),
  intervalUnit: document.getElementById('intervalUnit'),
  scopeSelect: document.getElementById('scopeSelect'),
  selectedTabsContainer: document.getElementById('selectedTabsContainer'),
  startBtn: document.getElementById('startBtn'),
  stopAllBtn: document.getElementById('stopAllBtn'),
  advancedToggle: document.getElementById('advancedToggle'),
  advancedPanel: document.getElementById('advancedPanel'),
  randomizeCheck: document.getElementById('randomizeCheck'),
  randomMin: document.getElementById('randomMin'),
  randomMax: document.getElementById('randomMax'),
  cleanCache: document.getElementById('cleanCache'),
  cleanCookies: document.getElementById('cleanCookies'),
  cleanLocalStorage: document.getElementById('cleanLocalStorage'),
  cleanSessionStorage: document.getElementById('cleanSessionStorage'),
  cleanCurrent: document.getElementById('cleanCurrent'),
  cleanDomain: document.getElementById('cleanDomain'),
  cleanAll: document.getElementById('cleanAll'),
  memoryBtn: document.getElementById('memoryBtn'),
  status: document.getElementById('status'),
  jobs: document.getElementById('jobs')
};

let currentState = { jobs: [], tabs: [] };

function toMs(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (unit === 'hours') return number * 3600 * 1000;
  if (unit === 'minutes') return number * 60 * 1000;
  return number * 1000;
}

function setStatus(message, error = false) {
  elements.status.textContent = message;
  elements.status.style.color = error ? '#ff8787' : '#8be9a8';
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) throw new Error(response?.error || 'Erro desconhecido');
  return response;
}

function renderTabsSelection(tabs) {
  if (elements.scopeSelect.value !== 'selected') {
    elements.selectedTabsContainer.style.display = 'none';
    elements.selectedTabsContainer.innerHTML = '';
    return;
  }

  elements.selectedTabsContainer.style.display = 'block';
  elements.selectedTabsContainer.innerHTML = tabs
    .filter((tab) => !!tab.id)
    .map(
      (tab) =>
        `<label><input type="checkbox" value="${tab.id}" /> ${tab.title?.slice(0, 40) || 'Sem título'}</label>`
    )
    .join('');
}

function getSelectedTabIds() {
  return [...elements.selectedTabsContainer.querySelectorAll('input[type="checkbox"]:checked')].map((el) =>
    Number(el.value)
  );
}

function renderJobs(jobs) {
  if (!jobs.length) {
    elements.jobs.innerHTML = '<div class="muted">Nenhum timer ativo.</div>';
    return;
  }

  elements.jobs.innerHTML = jobs
    .map(
      (job) => `
      <div class="job">
        <div><strong>${job.name}</strong></div>
        <div class="muted">Abas: ${job.tabIds.length} | Status: ${job.status}</div>
        <div>Próxima execução: ${job.secondsLeft !== null ? `${job.secondsLeft}s` : '-'}</div>
        <div class="row" style="margin-top:6px">
          <button class="small" data-action="restart" data-id="${job.id}">Iniciar</button>
          <button class="small danger" data-action="stop" data-id="${job.id}">Parar</button>
          <button class="small" data-action="remove" data-id="${job.id}">Remover</button>
        </div>
      </div>`
    )
    .join('');

  elements.jobs.querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      const jobId = button.dataset.id;
      try {
        if (action === 'restart') await sendMessage('RESTART_REFRESH', { jobId });
        if (action === 'stop') await sendMessage('STOP_REFRESH', { jobId });
        if (action === 'remove') await sendMessage('REMOVE_REFRESH', { jobId });
        await refreshState();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
}

async function refreshState() {
  try {
    const state = await sendMessage('GET_STATE');
    currentState = state;
    renderTabsSelection(state.tabs || []);
    renderJobs(state.jobs || []);

    if (state.settings?.defaultIntervalMs) {
      const totalSeconds = Math.round(state.settings.defaultIntervalMs / 1000);
      if (totalSeconds % 3600 === 0) {
        elements.intervalUnit.value = 'hours';
        elements.intervalValue.value = totalSeconds / 3600;
      } else if (totalSeconds % 60 === 0) {
        elements.intervalUnit.value = 'minutes';
        elements.intervalValue.value = totalSeconds / 60;
      } else {
        elements.intervalUnit.value = 'seconds';
        elements.intervalValue.value = totalSeconds;
      }
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

elements.scopeSelect.addEventListener('change', () => renderTabsSelection(currentState.tabs || []));

elements.startBtn.addEventListener('click', async () => {
  try {
    const intervalMs = toMs(elements.intervalValue.value, elements.intervalUnit.value);
    if (intervalMs < 1000 || intervalMs > 24 * 60 * 60 * 1000) {
      throw new Error('Intervalo inválido. Use entre 1 segundo e 24 horas.');
    }

    const scope = elements.scopeSelect.value;
    const selectedTabIds = scope === 'selected' ? getSelectedTabIds() : [];
    const scopeTabsRes = await sendMessage('GET_SCOPE_TABS', { scope, selectedTabIds });

    await sendMessage('START_REFRESH', {
      tabIds: scopeTabsRes.tabIds,
      intervalMs,
      randomize: elements.randomizeCheck.checked,
      randomMinMs: Number(elements.randomMin.value || 0) * 1000,
      randomMaxMs: Number(elements.randomMax.value || 0) * 1000,
      name: scope
    });

    setStatus('Auto-refresh iniciado.');
    await refreshState();
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.stopAllBtn.addEventListener('click', async () => {
  try {
    const jobs = currentState.jobs || [];
    await Promise.all(jobs.map((job) => sendMessage('STOP_REFRESH', { jobId: job.id })));
    setStatus('Todos os timers foram pausados.');
    await refreshState();
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.advancedToggle.addEventListener('click', () => {
  elements.advancedPanel.classList.toggle('open');
});

async function runClean(scope) {
  const types = {
    cache: elements.cleanCache.checked,
    cookies: elements.cleanCookies.checked,
    localStorage: elements.cleanLocalStorage.checked,
    sessionStorage: elements.cleanSessionStorage.checked
  };
  await sendMessage('CLEAN_DATA', { scope, types });
  setStatus(`Limpeza concluída no escopo: ${scope}.`);
}

elements.cleanCurrent.addEventListener('click', () => runClean('current').catch((e) => setStatus(e.message, true)));
elements.cleanDomain.addEventListener('click', () => runClean('domain').catch((e) => setStatus(e.message, true)));
elements.cleanAll.addEventListener('click', () => runClean('all').catch((e) => setStatus(e.message, true)));

elements.memoryBtn.addEventListener('click', async () => {
  try {
    const res = await sendMessage('RUN_MEMORY_CLEANUP');
    setStatus(`Memória liberada. Abas descartadas: ${res.discardedTabIds.length}`);
  } catch (error) {
    setStatus(error.message, true);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'REFRESH_STATE' && message.jobs) {
    currentState.jobs = message.jobs;
    renderJobs(message.jobs);
  }
  if (message?.type === 'MEMORY_CLEANUP_DONE') {
    setStatus(`Auto limpeza de memória: ${message.discardedTabIds.length} aba(s).`);
  }
});

refreshState();
setInterval(refreshState, 5000);
