document.addEventListener('DOMContentLoaded', async () => {
  const backendUrlInput = document.getElementById('backendUrl');
  const questionInput = document.getElementById('question');
  const answer = document.getElementById('answer');
  const connectionStatus = document.getElementById('connectionStatus');
  const voiceButton = document.getElementById('listen');
  const voiceStatus = document.getElementById('voiceStatus');
  const defaultBackend = 'http://localhost:3000';

  const { backendUrl, wakeWordEnabled = true } = await chrome.storage.local.get(['backendUrl', 'wakeWordEnabled']);
  backendUrlInput.value = backendUrl || defaultBackend;

  const renderVoiceState = enabled => {
    voiceButton.textContent = enabled ? 'Desactivar comando "Navi"' : 'Activar comando "Navi"';
    voiceButton.setAttribute('aria-pressed', String(enabled));
    voiceStatus.textContent = enabled
      ? 'Comando "Navi" activo en la pestaña actual.'
      : 'El comando "Navi" está desactivado.';
  };

  const sendWakeWordCommand = (tabId, enabled) => new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, { type: 'voice.setWakeWord', enabled }, response => {
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

  document.getElementById('save').addEventListener('click', async () => {
    const value = backendUrlInput.value.trim().replace(/\/$/, '');
    await chrome.storage.local.set({ backendUrl: value || defaultBackend });
    connectionStatus.textContent = `Conexión guardada: ${value || defaultBackend}`;
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
  });
});
