document.addEventListener('DOMContentLoaded', async () => {
  const backendUrlInput = document.getElementById('backendUrl');
  const questionInput = document.getElementById('question');
  const answer = document.getElementById('answer');
  const connectionStatus = document.getElementById('connectionStatus');
  const voiceButton = document.getElementById('listen');
  const voiceStatus = document.getElementById('voiceStatus');
  const voiceState = document.getElementById('voiceState');
  const defaultBackend = 'http://localhost:3000';

  const { backendUrl, wakeWordEnabled = true } = await chrome.storage.local.get(['backendUrl', 'wakeWordEnabled']);
  backendUrlInput.value = backendUrl || defaultBackend;

  const renderVoiceState = enabled => {
    voiceButton.textContent = enabled ? 'Detener llamada' : 'Iniciar llamada';
    voiceButton.setAttribute('aria-pressed', String(enabled));
    voiceState.textContent = enabled ? 'Activo' : 'Inactivo';
    voiceStatus.textContent = enabled
      ? 'Comando "Navi" activo en la pestaña actual.'
      : 'El comando "Navi" está desactivado.';
  };

  const renderVoiceStatus = status => {
    if (!status?.ok) return;
    voiceButton.setAttribute('aria-pressed', String(status.enabled));
    voiceButton.textContent = status.enabled ? 'Detener llamada' : 'Iniciar llamada';
    voiceState.textContent = status.active ? 'Escuchando' : status.enabled ? 'Preparando' : 'Inactivo';
    voiceStatus.textContent = status.enabled
      ? status.active
        ? 'Micrófono activo. Di «Navi» para comenzar.'
        : 'Comando "Navi" activo en la pestaña actual.'
      : 'El comando "Navi" está desactivado.';
  };

  const sendWakeWordCommand = (tabId, enabled) => new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'voice.setWakeWord', enabled }, response => {
      resolve({ response, error: chrome.runtime.lastError });
    });
  });

  const getVoiceStatus = tabId => new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'voice.getStatus' }, response => {
      resolve({ response, error: chrome.runtime.lastError });
    });
  });

  const updateVoiceScript = async tabId => {
    try {
      const [{ result: hasAgent }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => typeof window.nrviAsk === 'function'
      });
      const files = hasAgent
        ? ['content/voice.js']
        : ['content/context.js', 'content/agent.js', 'content/voice.js'];
      await chrome.scripting.executeScript({ target: { tabId }, files });
      return true;
    } catch {
      return false;
    }
  };

  renderVoiceState(wakeWordEnabled);

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    const status = await getVoiceStatus(activeTab.id);
    if (!status.error) renderVoiceStatus(status.response);
  }

  document.getElementById('save').addEventListener('click', async () => {
    const value = backendUrlInput.value.trim().replace(/\/$/, '');
    await chrome.storage.local.set({ backendUrl: value || defaultBackend });
    connectionStatus.textContent = `Conexión guardada: ${value || defaultBackend}`;
  });

  document.getElementById('test').addEventListener('click', async () => {
    const url = backendUrlInput.value.trim().replace(/\/$/, '') || defaultBackend;
    connectionStatus.textContent = 'Probando conexión...';
    try {
      const response = await fetch(`${url}/health`);
      if (!response.ok) {
        throw new Error(`El backend respondió ${response.status}.`);
      }
      const health = await response.json();
      connectionStatus.textContent = `Backend ok | groq=${health.groq ? 'si' : 'no'} | elevenlabs=${health.elevenlabs ? 'si' : 'no'}`;
    } catch (error) {
      connectionStatus.textContent = error instanceof Error
        ? `No se pudo conectar: ${error.message}`
        : 'No se pudo conectar con el backend.';
    }
  });

  document.getElementById('ask').addEventListener('click', async () => {
    const question = questionInput.value.trim();
    if (!question) {
      answer.textContent = 'Escribe una pregunta.';
      return;
    }
    answer.textContent = 'NRVI está pensando...';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      answer.textContent = 'No encontré una pestaña activa.';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'agent.ask.fromPopup', question }, response => {
      if (chrome.runtime.lastError || !response?.ok) {
        answer.textContent = response?.error || 'Recarga la página para conectar NRVI.';
        return;
      }
      answer.textContent = response.text;
    });
  });

  voiceButton.addEventListener('click', async () => {
    const enabled = !voiceButton.getAttribute('aria-pressed') || voiceButton.getAttribute('aria-pressed') === 'false';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      voiceStatus.textContent = 'No encontré una pestaña activa.';
      return;
    }
    await chrome.storage.local.set({ wakeWordEnabled: enabled });
    let result = await sendWakeWordCommand(tab.id, enabled);
    if (result.error || !result.response?.ok) {
      const updated = await updateVoiceScript(tab.id);
      if (updated) result = await sendWakeWordCommand(tab.id, enabled);
    }
    if (result.error || !result.response?.ok) {
      voiceStatus.textContent = result.response?.error || 'No se pudo conectar con la pestaña actual.';
      return;
    }
    renderVoiceState(result.response.enabled);
    const status = await getVoiceStatus(tab.id);
    if (!status.error) renderVoiceStatus(status.response);
  });
});
