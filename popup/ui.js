document.addEventListener('DOMContentLoaded', async () => {
  const backendUrlInput = document.getElementById('backendUrl');
  const questionInput = document.getElementById('question');
  const answer = document.getElementById('answer');
  const connectionStatus = document.getElementById('connectionStatus');
  const defaultBackend = 'http://localhost:3000';

  const { backendUrl } = await chrome.storage.local.get('backendUrl');
  backendUrlInput.value = backendUrl || defaultBackend;

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

  document.getElementById('listen').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'voice.toggle' });
  });
});
