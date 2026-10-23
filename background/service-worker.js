const DEFAULT_BACKEND = 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 30000;

async function getBackendUrl() {
  const { backendUrl } = await chrome.storage.local.get('backendUrl');
  return (backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeError(error) {
  if (error.name === 'AbortError') return 'La respuesta tardó demasiado. Inténtalo de nuevo.';
  if (error instanceof TypeError) return 'No pude conectar con NRVI. Revisa que el backend esté activo.';
  return error.message || 'No pude conectar con NRVI.';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['agent.request', 'transcription.request'].includes(message.type)) return false;

  (async () => {
    try {
      const backendUrl = await getBackendUrl();
      if (message.type === 'transcription.request') {
        const form = new FormData();
        if (typeof message.audioBase64 !== 'string' || !message.audioBase64) {
          throw new Error('No se recibió audio para transcribir.');
        }
        const binary = atob(message.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        const audio = new Blob([bytes], { type: message.mimeType || 'audio/webm' });
        form.append('file', audio, message.fileName || 'nrvi.webm');
        const response = await fetchWithTimeout(`${backendUrl}/api/transcribe`, {
          method: 'POST',
          body: form
        }, REQUEST_TIMEOUT_MS);
        let data = {};
        try {
          data = await response.json();
        } catch {
          data = {};
        }
        if (!response.ok) throw new Error(data.error || `El backend respondió ${response.status}.`);
        sendResponse({ ok: true, ...data });
        return;
      }

      const response = await fetchWithTimeout(`${backendUrl}/api/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: message.question,
          context: message.context,
          history: message.history || [],
          audio: message.audio !== false
        })
      }, REQUEST_TIMEOUT_MS);

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) throw new Error(data.error || `El backend respondió ${response.status}.`);
      sendResponse({ ok: true, ...data });
    } catch (error) {
      sendResponse({ ok: false, error: describeError(error) });
    }
  })();

  return true;
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-listening') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'voice.toggle' }, () => {
    if (!chrome.runtime.lastError) return;
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/context.js', 'content/voice.js', 'content/agent.js', 'content/overlay.js']
    }).then(() => {
      chrome.tabs.sendMessage(tab.id, { type: 'voice.toggle' });
    }).catch(error => {
      console.warn('[NRVI] No se pudo activar la voz en esta pestaña:', error.message);
    });
  });
});
