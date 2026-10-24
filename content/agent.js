(() => {
  if (window.__nrviAgentLoaded) return;
  window.__nrviAgentLoaded = true;

  const history = [];
  let busy = false;
  let requestId = 0;
  let pendingDone = null;
  let rateLimitUntil = 0;
  const fallbackSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const setNativeValue = (element, value) => {
    if (element.tagName === 'SELECT') {
      element.value = value;
      return;
    }
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  };

  const runAction = action => {
    if (!action || typeof action !== 'object') return false;

    if (action.type === 'scroll_page') {
      const direction = action.direction === 'up' ? -1 : 1;
      window.scrollBy({ top: direction * innerHeight * 0.8, behavior: 'smooth' });
      return true;
    }

    const element = window.nrviResolve?.(action.id);
    if (!element) return false;

    element.focus?.();

    if (action.type === 'click_element') {
      element.click();
      return true;
    }

    if (action.type === 'fill_input') {
      if (!('value' in element)) return false;
      setNativeValue(element, String(action.text ?? ''));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (action.type === 'focus_field') return true;

    return false;
  };

  const rememberExchange = (question, answer) => {
    try {
      chrome.storage.local.set({ lastQuestion: question, lastAnswer: answer });
    } catch {
      void 0;
    }
    try {
      chrome.runtime.sendMessage({ type: 'voice.qa', question, answer });
    } catch {
      void 0;
    }
  };

  window.nrviAsk = (question, done) => {
    const text = String(question || '').trim();
    if (!text) {
      done?.({ ok: false, error: 'La pregunta está vacía.' });
      return;
    }
    if (Date.now() < rateLimitUntil) {
      const seconds = Math.ceil((rateLimitUntil - Date.now()) / 1000);
      const message = `Groq está temporalmente limitado. Espera ${seconds} segundos antes de volver a preguntar.`;
      window.nrviVoice?.speak?.(message);
      done?.({ ok: false, error: message });
      return;
    }
    if (busy) {
      const message = 'Todavía estoy procesando la pregunta anterior.';
      window.nrviVoice?.speak?.(message);
      done?.({ ok: false, error: message });
      return;
    }

    busy = true;
    const id = ++requestId;
    pendingDone = done;
    const context = window.nrviContext ? window.nrviContext() : {};

    chrome.runtime.sendMessage(
      {
        type: 'agent.request',
        question: text,
        context,
        history,
        audio: true,
        sessionId: window.nrviVoice?.getSessionId?.() || fallbackSessionId
      },
      response => {
        if (id !== requestId) return;
        busy = false;
        pendingDone = null;

        if (chrome.runtime.lastError || !response?.ok) {
          const message = response?.error || 'No pude conectar con NRVI.';
          if (response?.status === 429) rateLimitUntil = Date.now() + 15000;
          window.nrviVoice?.speak?.(message);
          done?.({ ok: false, error: message });
          return;
        }

        (response.actions || []).forEach(runAction);
        history.push({ role: 'user', content: text }, { role: 'assistant', content: response.text });
        if (history.length > 12) history.splice(0, history.length - 12);
        window.nrviVoice?.playResponse?.(response.text, response.audio, response.audioMimeType);
        rememberExchange(text, response.text);
        done?.({ ok: true, text: response.text, actions: (response.actions || []).length });
      }
    );
  };

  window.nrviCancel = () => {
    const done = pendingDone;
    requestId += 1;
    busy = false;
    pendingDone = null;
    window.nrviVoice?.stopSpeaking?.();
    done?.({ ok: false, error: 'Solicitud cancelada.' });
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'agent.ask.fromPopup') return false;
    window.nrviAsk(message.question, sendResponse);
    return true;
  });

  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'voice.toggle') window.nrviVoice?.toggle?.();
  });
})();
