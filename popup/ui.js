document.addEventListener('DOMContentLoaded', async () => {
  const backendUrlInput = document.getElementById('backendUrl');
  const questionInput = document.getElementById('question');
  const answer = document.getElementById('answer');
  const connectionStatus = document.getElementById('connectionStatus');
  const voiceButton = document.getElementById('listen');
  const voiceStateLabel = document.getElementById('voiceStateLabel');
  const voiceStateHint = document.getElementById('voiceStateHint');
  const askButton = document.getElementById('ask');
  const saveButton = document.getElementById('save');
  const checkHealthButton = document.getElementById('checkHealth');
  const micFill = document.getElementById('micFill');
  const micLevelText = document.getElementById('micLevelText');

  const defaultBackend = 'http://localhost:3000';

  let activeTabId = null;
  let busy = false;

  const { backendUrl, lastQuestion = '', lastAnswer = '' } = await chrome.storage.local.get(['backendUrl', 'lastQuestion', 'lastAnswer']);
  backendUrlInput.value = backendUrl || defaultBackend;
  if (lastQuestion) questionInput.value = lastQuestion;
  if (lastAnswer) answer.textContent = lastAnswer;

  const setConnection = (message, type = 'info') => {
    connectionStatus.className = 'status';
    if (type === 'ok') connectionStatus.classList.add('ok');
    if (type === 'err') connectionStatus.classList.add('err');
    if (type === 'warn') connectionStatus.classList.add('warn');
    connectionStatus.innerHTML = `<p class="hint">${escapeHtml(message)}</p>`;
  };

  const setVoiceState = (state, hint = '') => {
    const labels = {
      idle: 'Inactivo',
      standby: 'En espera',
      listening: 'Escuchando',
      processing: 'Procesando',
      speaking: 'Hablando',
      paused: 'En pausa',
      error: 'Error'
    };
    voiceStateLabel.textContent = labels[state] || state || 'Desconocido';
    voiceStateHint.textContent = hint;
  };

  const setMicLevel = level => {
    const v = Math.max(0, Math.min(1, Number(level) || 0));
    micFill.style.width = `${Math.round(v * 100)}%`;
    micLevelText.textContent = `${Math.round(v * 100)}%`;
  };

  renderVoiceButton(false);
  setMicLevel(0);

  const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[c]);

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id;
    return tab;
  }

  async function updateVoiceScript(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/context.js', 'content/voice.js', 'content/agent.js', 'content/overlay.js']
      });
      return true;
    } catch {
      return false;
    }
  }

  async function ensureAgentReady(tabId) {
    try {
      const [{ result: hasAgent }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => typeof window.nrviAsk === 'function'
      });
      return hasAgent || await updateVoiceScript(tabId);
    } catch {
      return false;
    }
  }

  function renderVoiceButton(inCall) {
    voiceButton.textContent = inCall ? 'Colgar (en llamada)' : 'Iniciar llamada';
    voiceButton.setAttribute('aria-pressed', String(Boolean(inCall)));
  }

  const voiceStateHints = {
    idle: 'Pulsa «Iniciar llamada» o di «Navi».',
    standby: 'Esperando la palabra «Navi».',
    listening: 'Dime lo que necesitas.',
    processing: 'NRVI está preparando una respuesta.',
    speaking: 'NRVI está hablando.',
    paused: 'Respuesta en pausa.',
    error: 'No se pudo iniciar o mantener la voz.'
  };

  function showVoiceState(state) {
    setVoiceState(state, voiceStateHints[state] || 'Estado de voz no reconocido.');
  }

  async function queryVoiceState(tabId) {
    if (!tabId) return;
    try {
      chrome.tabs.sendMessage(tabId, { type: 'voice.getState' }, response => {
        if (chrome.runtime.lastError || !response?.ok) {
          setVoiceState('inactivo', 'NRVI no está disponible en esta página. Abre una página web normal.');
          renderVoiceButton(false);
          return;
        }
        showVoiceState(response.state);
        renderVoiceButton(response.inCall);
        if (typeof response.micLevel === 'number') setMicLevel(response.micLevel);
      });
    } catch {
      setVoiceState('inactivo', 'No pude consultar el estado de voz de esta página.');
    }
  }

  async function getBackendBase(requestPermission = false) {
    const value = backendUrlInput.value.trim().replace(/\/+$/, '') || defaultBackend;
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Escribe una URL válida para el backend.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.host) {
      throw new Error('La URL del backend debe usar HTTP o HTTPS.');
    }
    const originPattern = `${url.origin}/*`;
    if (requestPermission) {
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) throw new Error('No se concedió permiso para conectar con ese backend.');
    } else {
      const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
      if (!hasPermission) {
        throw new Error('Pulsa «Guardar conexión» para autorizar este backend.');
      }
    }
    return value;
  }

  async function healthCheck(requestPermission = false) {
    let base;
    try {
      base = await getBackendBase(requestPermission);
    } catch (error) {
      setConnection(error.message, 'warn');
      return;
    }
    setConnection('Comprobando salud del backend…', 'info');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(timer);
      let data = {};
      try { data = await response.json(); } catch { data = {}; }
      if (response.ok) {
        setConnection(`Backend ok | groq=${data.groq?'si':'no'} | elevenlabs=${data.elevenlabs?'si':'no'}`, 'ok');
      } else {
        setConnection(`Backend responde ${response.status}`, 'err');
      }
    } catch (error) {
      clearTimeout(timer);
      const message = error.name === 'AbortError' ? 'Tiempo de espera agotado al conectar.' : 'No se pudo conectar con el backend.';
      setConnection(message, 'err');
    }
  }

  async function ensureVoiceReady(tabId, enabled) {
    let result = await sendSetCall(tabId, enabled);
    if (result.error || !result.response?.ok) {
      const updated = await updateVoiceScript(tabId);
      if (updated) result = await sendSetCall(tabId, enabled);
    }
    return result;
  }

  function sendSetCall(tabId, enabled) {
    return new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { type: 'voice.setCall', enabled }, response => {
        resolve({ response, error: chrome.runtime.lastError });
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.tab?.id !== activeTabId) return;
    if (message.type === 'voice.state') {
      showVoiceState(message.state);
      renderVoiceButton(message.inCall);
      if (typeof message.micLevel === 'number') setMicLevel(message.micLevel);
      return;
    }
    if (message.type === 'voice.miclevel') {
      if (typeof message.level === 'number') setMicLevel(message.level);
      return;
    }
    if (message.type === 'voice.qa') {
      if (message.question) questionInput.value = message.question;
      if (typeof message.answer === 'string') answer.textContent = message.answer;
      return;
    }
  });

  saveButton.addEventListener('click', async () => {
    try {
      const value = await getBackendBase(true);
      await chrome.storage.local.set({ backendUrl: value });
      setConnection(`Conexión guardada: ${value}`, 'ok');
    } catch (error) {
      setConnection(error.message || 'No pude guardar la conexión.', 'err');
    }
  });

  checkHealthButton.addEventListener('click', () => healthCheck(true));

  askButton.addEventListener('click', async () => {
    if (busy) return;
    const question = questionInput.value.trim();
    if (!question) {
      answer.textContent = 'Escribe una pregunta.';
      return;
    }
    busy = true;
    askButton.disabled = true;
    answer.textContent = 'NRVI está pensando...';
    let tab;
    try {
      tab = await getActiveTab();
    } catch {
      busy = false;
      askButton.disabled = false;
      answer.textContent = 'No pude consultar la pestaña activa.';
      return;
    }
    if (!tab?.id) {
      busy = false;
      askButton.disabled = false;
      answer.textContent = 'No encontré una pestaña activa.';
      return;
    }
    if (!await ensureAgentReady(tab.id)) {
      busy = false;
      askButton.disabled = false;
      answer.textContent = 'NRVI no puede ejecutarse en esta página. Abre una página web normal y vuelve a intentarlo.';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'agent.ask.fromPopup', question }, response => {
      busy = false;
      askButton.disabled = false;
      if (chrome.runtime.lastError || !response?.ok) {
        answer.textContent = response?.error || 'No se pudo iniciar la pregunta en esta página.';
        return;
      }
      answer.textContent = response.text;
    });
  });

  voiceButton.addEventListener('click', async () => {
    let tab;
    try {
      tab = await getActiveTab();
    } catch {
      setVoiceState('error', 'No pude consultar la pestaña activa.');
      return;
    }
    if (!tab?.id) {
      setVoiceState('error', 'No encontré una pestaña activa.');
      return;
    }
    const inCall = voiceButton.getAttribute('aria-pressed') === 'true';
    const enabled = !inCall;
    renderVoiceButton(enabled);
    const result = await ensureVoiceReady(tab.id, enabled);
    if (result.error || !result.response?.ok) {
      setVoiceState('error', result.response?.error || 'No se pudo iniciar la voz en esta página.');
      return;
    }
    renderVoiceButton(result.response.inCall);
    queryVoiceState(tab.id);
  });

  const tab = await getActiveTab();
  if (tab?.id) {
    await queryVoiceState(tab.id);
    await healthCheck();
  }
});
