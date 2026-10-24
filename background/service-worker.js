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
  if (!['agent.request', 'transcription.request', 'session.end', 'navigation.prepare', 'navigation.consume'].includes(message.type)) return false;

  (async () => {
    try {
      if (message.type === 'navigation.prepare') {
        const tabId = sender.tab?.id;
        if (!tabId || !message.sessionId) throw new Error('No se pudo asociar la navegación con la sesión.');
        await chrome.storage.session.set({
          [`nrvi-navigation-${tabId}`]: {
            sessionId: message.sessionId,
            response: {
              text: message.response?.text || '',
              audioMimeType: message.response?.audioMimeType || null
            },
            history: message.history || [],
            createdAt: Date.now()
          }
        });
        sendResponse({ ok: true });
        return;
      }
      if (message.type === 'navigation.consume') {
        const tabId = sender.tab?.id;
        const key = tabId ? `nrvi-navigation-${tabId}` : '';
        const stored = key ? await chrome.storage.session.get(key) : {};
        const pending = stored[key];
        if (key) await chrome.storage.session.remove(key);
        const validPending = pending && Date.now() - pending.createdAt < 60000 ? pending : null;
        sendResponse({ ok: true, pending: validPending });
        return;
      }
      const backendUrl = await getBackendUrl();
      if (message.type === 'session.end') {
        const response = await fetchWithTimeout(`${backendUrl}/api/session/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: message.sessionId })
        }, REQUEST_TIMEOUT_MS);
        sendResponse({ ok: response.ok });
        return;
      }
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
          headers: { 'X-NRVI-Session': message.sessionId || '' },
          body: form
        }, REQUEST_TIMEOUT_MS);
        let data = {};
        try {
          data = await response.json();
        } catch {
          data = {};
        }
        if (!response.ok) {
          const error = new Error(data.error || `El backend respondió ${response.status}.`);
          error.status = response.status;
          throw error;
        }
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
          audio: message.audio !== false,
          sessionId: message.sessionId
        })
      }, REQUEST_TIMEOUT_MS);

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) {
        const error = new Error(data.error || `El backend respondió ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      sendResponse({ ok: true, ...data });
    } catch (error) {
      sendResponse({ ok: false, status: error.status, error: describeError(error) });
    }
  })();

  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const key = `nrvi-navigation-${tabId}`;
  const stored = await chrome.storage.session.get(key);
  if (!stored[key] || typeof chrome.action.openPopup !== 'function') return;
  try {
    await chrome.action.openPopup();
  } catch {
    void 0;
  }
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
