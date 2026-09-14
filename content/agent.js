(() => {
  const history = [];
  const runAction = action => {
    const context = window.nrviContext();
    if (action.type === 'scroll_page') {
      window.scrollBy({ top: action.direction === 'up' ? -innerHeight * 0.8 : innerHeight * 0.8, behavior: 'smooth' });
      return true;
    }
    const match = action.id?.match(/^(action|field)-(\d+)$/);
    if (!match) return false;
    const collection = match[1] === 'action' ? context.actions : context.fields;
    const item = collection[Number(match[2])];
    if (!item) return false;
    const elements = match[1] === 'action'
      ? [...document.querySelectorAll('button, a[href], [role="button"], input[type="submit"], input[type="button"]')].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      })
      : [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')].filter(element => element.getBoundingClientRect().width > 0);
    const element = elements[Number(match[2])];
    if (!element) return false;
    element.focus();
    if (action.type === 'click_element') element.click();
    if (action.type === 'fill_input') {
      element.value = String(action.text || '');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  };

  window.nrviAsk = (question, done) => {
    const context = window.nrviContext();
    chrome.runtime.sendMessage({ type: 'agent.request', question, context, history, audio: true }, response => {
      if (chrome.runtime.lastError || !response?.ok) {
        window.nrviVoice.speak(response?.error || 'No pude conectar con el agente.');
        done?.({ ok: false, error: response?.error || 'No pude conectar con el agente.' });
        return;
      }
      response.actions?.forEach(runAction);
      history.push({ role: 'user', content: question }, { role: 'assistant', content: response.text });
      if (history.length > 12) history.splice(0, 2);
      if (response.audio) {
        const audio = new Audio(`data:${response.audioMimeType || 'audio/mpeg'};base64,${response.audio}`);
        audio.play().catch(() => window.nrviVoice.speak(response.text));
      } else {
        window.nrviVoice.speak(response.text);
      }
      done?.({ ok: true, text: response.text });
    });
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'agent.ask.fromPopup') return false;
    window.nrviAsk(message.question, sendResponse);
    return true;
  });

  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'voice.toggle') window.nrviVoice.toggle();
  });
})();
