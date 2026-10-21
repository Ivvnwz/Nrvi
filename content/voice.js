(() => {
  if (window.__nrviVoiceLoaded) return;
  window.__nrviVoiceLoaded = true;

  const STOP_COMMANDS = ['detente', 'para', 'alto', 'callate', 'silencio', 'cancela', 'cancelar'];
  const PAUSE_COMMAND = 'pausa';
  const RESUME_COMMANDS = ['reanuda', 'continua', 'sigue hablando'];
  const REPEAT_COMMANDS = ['repite', 'repetir', 'otra vez', 'vuelve a explicarlo', 'que dijiste', 'que has dicho', 'repitemelo'];
  const SLOW_COMMANDS = ['mas despacio', 'habla mas despacio', 'explica mas despacio', 'explicamelo mas despacio', 'explicamelo de nuevo mas despacio'];
  const STOP_LISTENING_COMMANDS = ['deja de escuchar', 'para de escuchar', 'no escuches mas', 'deja de escucharme', 'termina', 'cuelga', 'colgar', 'termina la llamada'];

  const recognitionType = window.SpeechRecognition || window.webkitSpeechRecognition;

  let recognition;
  let mode = 'off';
  let active = false;
  let wakeWordEnabled = false;
  let inCall = false;
  let processing = false;
  let speaking = false;
  let pausedState = false;
  let currentAudio;
  let lastResponse;
  let spokenText = '';
  let errorState = null;
  let errorTimer = null;

  let micLevel = 0;
  let meterTimer = null;
  let lastSentLevel = -1;

  const normalize = text => String(text || '')
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!,.;:]/g, '')
    .trim();

  const WAKE_VARIANTS = ['navi', 'nabi', 'naby', 'navy', 'nave', 'nabhi'];

  const extractQuestion = raw => {
    const words = String(raw || '').replace(/[¿?¡!]/g, ' ').split(/\s+/).filter(Boolean);
    const index = words.findIndex(word => WAKE_VARIANTS.includes(normalize(word)));
    if (index < 0) return null;
    return words.slice(index + 1).join(' ').replace(/^[,.;:]+/, '').trim();
  };

  const isEcho = candidate => {
    if (!spokenText) return false;
    const said = normalize(candidate);
    if (said.length < 3) return true;
    return normalize(spokenText).includes(said);
  };


  const currentState = () => {
    if (errorState) return 'error';
    if (pausedState) return 'paused';
    if (speaking) return 'speaking';
    if (processing) return 'processing';
    if (inCall) return 'listening';
    if (wakeWordEnabled) return 'standby';
    return 'idle';
  };

  const dispatchLocal = (name, detail) => {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
      void 0;
    }
  };

  const broadcastState = () => {
    const snapshot = { state: currentState(), wakeWordEnabled, inCall, active, processing, speaking, micLevel };
    dispatchLocal('nrvi:state', snapshot);
    try {
      chrome.runtime.sendMessage({ type: 'voice.state', ...snapshot }, () => void chrome.runtime.lastError);
    } catch {
      void 0;
    }
  };

  const broadcastMicLevel = () => {
    dispatchLocal('nrvi:miclevel', { level: micLevel });
    const rounded = Math.round(micLevel * 20) / 20;
    if (rounded === lastSentLevel) return;
    lastSentLevel = rounded;
    try {
      chrome.runtime.sendMessage({ type: 'voice.miclevel', level: micLevel }, () => void chrome.runtime.lastError);
    } catch {
      void 0;
    }
  };

  const broadcastTranscript = (text, isFinal) => {
    dispatchLocal('nrvi:transcript', { text, final: Boolean(isFinal) });
  };

  const sync = () => broadcastState();

  const fail = message => {
    errorState = message;
    broadcastState();
    speak(message);
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      errorState = null;
      sync();
    }, 3000);
  };

  const stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    speaking = false;
    pausedState = false;
    sync();
  };

  const pauseSpeaking = () => {
    if (!speaking) return;
    window.speechSynthesis?.pause();
    currentAudio?.pause();
    pausedState = true;
    sync();
  };

  const resumeSpeaking = () => {
    if (!pausedState) return;
    pausedState = false;
    window.speechSynthesis?.resume();
    if (currentAudio?.paused) currentAudio.play().catch(() => speak(lastResponse?.text));
    sync();
  };

  const speak = (text, options = {}) => {
    const onend = typeof options === 'function' ? options : options.onend;
    const rate = typeof options === 'object' && options.rate ? options.rate : 1;
    stopSpeaking();
    if (!text || !('speechSynthesis' in window)) {
      onend?.();
      return;
    }
    spokenText = text;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    utterance.rate = rate;
    speaking = true;
    sync();
    utterance.onend = () => {
      speaking = false;
      pausedState = false;
      sync();
      onend?.();
    };
    speechSynthesis.speak(utterance);
  };

  const playResponse = (text, audioBase64, audioMimeType = 'audio/mpeg', rate = 1) => {
    stopSpeaking();
    lastResponse = { text, audioBase64, audioMimeType };
    spokenText = text || '';
    if (!audioBase64) {
      speak(text, { rate });
      return;
    }
    currentAudio = new Audio(`data:${audioMimeType};base64,${audioBase64}`);
    currentAudio.playbackRate = rate;
    currentAudio.onended = () => {
      currentAudio = null;
      speaking = false;
      pausedState = false;
      sync();
    };
    speaking = true;
    sync();
    currentAudio.play().catch(() => {
      currentAudio = null;
      speak(text, { rate });
    });
  };

  const replay = ({ slow = false } = {}) => {
    if (!lastResponse?.text) {
      speak('Todavía no tengo una respuesta que repetir.');
      return;
    }
    playResponse(lastResponse.text, lastResponse.audioBase64, lastResponse.audioMimeType, slow ? 0.8 : 1);
  };

  const bumpMic = value => {
    micLevel = Math.max(0, Math.min(1, value));
    broadcastMicLevel();
  };

  const startMeter = () => {
    if (meterTimer) return;
    meterTimer = setInterval(() => {
      micLevel = micLevel * 0.82;
      if (micLevel < 0.02) micLevel = 0;
      broadcastMicLevel();
    }, 120);
  };

  const stopMeter = () => {
    if (meterTimer) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
    micLevel = 0;
    broadcastMicLevel();
  };

  const handleVoiceCommand = transcript => {
    const command = normalize(transcript);
    if (!command) return false;

    if (STOP_COMMANDS.includes(command)) {
      window.nrviCancel?.();
      return true;
    }
    if (command === PAUSE_COMMAND) {
      pauseSpeaking();
      return true;
    }
    if (RESUME_COMMANDS.includes(command)) {
      resumeSpeaking();
      return true;
    }
    if (REPEAT_COMMANDS.includes(command)) {
      replay();
      return true;
    }
    if (SLOW_COMMANDS.includes(command)) {
      replay({ slow: true });
      return true;
    }
    if (STOP_LISTENING_COMMANDS.includes(command)) {
      endCall();
      return true;
    }
    return false;
  };

  const startRecognition = nextMode => {
    if (!recognitionType || processing) return;
    if (document.visibilityState !== 'visible') {
      active = false;
      stopMeter();
      sync();
      return;
    }
    if (recognition) {
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.onspeechstart = null;
      recognition.onspeechend = null;
      recognition.abort();
    }
    mode = nextMode;
    recognition = new recognitionType();
    recognition.lang = 'es-ES';
    recognition.continuous = nextMode === 'call';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      active = true;
      startMeter();
      sync();
    };
    recognition.onspeechstart = () => bumpMic(0.75);
    recognition.onspeechend = () => bumpMic(0.15);
    recognition.onend = () => {
      active = false;
      recognition = null;
      stopMeter();
      sync();
      if (wakeWordEnabled && !processing && document.visibilityState === 'visible') {
        setTimeout(() => {
          if (wakeWordEnabled && !processing && document.visibilityState === 'visible') {
            startRecognition(recognitionMode());
          }
        }, 250);
      }
    };
    recognition.onerror = event => {
      active = false;
      const error = event.error;
      console.debug('[NRVI] error de reconocimiento:', error);
      if (error === 'aborted') return;
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(error)) {
        wakeWordEnabled = false;
        inCall = false;
        mode = 'off';
        stopMeter();
        fail('No tengo permiso para usar el micrófono.');
        return;
      }
      if (error === 'no-speech') {
        sync();
        return;
      }
      if (error === 'network') {
        fail('Se perdió la conexión con el reconocimiento de voz.');
        return;
      }
      sync();
    };
    recognition.onresult = event => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript || '';
        if (result.isFinal) final += text;
        else interim += text;
      }

      const candidate = (final || interim).trim();
      if (!candidate) return;

      if (speaking && inCall) {
        if (isEcho(candidate)) return;
        stopSpeaking();
      }

      if (mode === 'wake') {
        const transcript = final.trim();
        if (!transcript) return;
        const question = extractQuestion(transcript);
        if (question === null) return;
        console.debug('[NRVI] Navi detectado, activando llamada:', transcript);
        broadcastTranscript(transcript, true);
        setCall(true, question);
        return;
      }

      if (!speaking && interim) broadcastTranscript(interim.trim(), false);

      const transcript = final.trim();
      if (!transcript) return;
      console.debug('[NRVI] escuchado:', transcript);

      if (handleVoiceCommand(transcript)) return;

      let question = extractQuestion(transcript);
      if (question === null) question = transcript;
      question = question.trim();
      if (question && handleVoiceCommand(question)) return;

      broadcastTranscript(transcript, true);
      if (recognition) recognition.stop();

      if (question) askQuestion(question);
      else if (wakeWordEnabled && !processing) startRecognition(recognitionMode());
    };
    try {
      recognition.start();
    } catch (error) {
      if (error.name === 'InvalidStateError') {
        setTimeout(() => {
          if (wakeWordEnabled && !processing && document.visibilityState === 'visible') {
            startRecognition(recognitionMode());
          }
        }, 400);
      } else {
        recognition = null;
        wakeWordEnabled = false;
        inCall = false;
        mode = 'off';
        active = false;
        stopMeter();
        fail('No pude iniciar el micrófono.');
      }
    }
  };

  const recognitionMode = () => (inCall ? 'call' : 'wake');

  const askQuestion = question => {
    processing = true;
    mode = 'off';
    clearTimeout(errorTimer);
    errorState = null;
    sync();
    window.nrviAsk?.(question, () => {
      processing = false;
      if (wakeWordEnabled) startRecognition(recognitionMode());
      else sync();
    });
  };

  const stopWakeWord = () => {
    wakeWordEnabled = false;
    inCall = false;
    mode = 'off';
    if (recognition) {
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.onspeechstart = null;
      recognition.onspeechend = null;
      recognition.abort();
      recognition = null;
    }
    active = false;
    stopMeter();
    sync();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      if (recognition) {
        recognition.onstart = null;
        recognition.onend = null;
        recognition.onerror = null;
        recognition.onresult = null;
        recognition.onspeechstart = null;
        recognition.onspeechend = null;
        recognition.abort();
        recognition = null;
      }
      active = false;
      stopMeter();
      sync();
      return;
    }
    if (wakeWordEnabled && !processing) startRecognition(recognitionMode());
  });

  const setWakeWord = enabled => {
    if (!recognitionType) {
      stopWakeWord();
      fail('El reconocimiento de voz no está disponible en este navegador.');
      return false;
    }
    if (!enabled) {
      stopWakeWord();
      return false;
    }
    wakeWordEnabled = true;
    inCall = false;
    broadcastState();
    startRecognition('wake');
    return true;
  };

  const setCall = (enabled, initialQuestion) => {
    if (!recognitionType) {
      fail('El reconocimiento de voz no está disponible en este navegador.');
      return false;
    }
    if (enabled) {
      wakeWordEnabled = true;
      inCall = true;
      broadcastState();
      if (initialQuestion) {
        if (recognition) recognition.stop();
        askQuestion(initialQuestion);
      } else {
        startRecognition('call');
      }
      return true;
    }
    inCall = false;
    broadcastState();
    if (wakeWordEnabled) startRecognition('wake');
    else stopWakeWord();
    return false;
  };

  const endCall = () => {
    if (inCall) speak('De acuerdo, cuelgo.');
    setCall(false);
  };

  window.nrviVoice = {
    speak,
    playResponse,
    stopSpeaking,
    pauseSpeaking,
    resumeSpeaking,
    repeatLastResponse: replay,
    getState: currentState,
    getMicLevel: () => micLevel,
    isWakeWordEnabled: () => wakeWordEnabled,
    isInCall: () => inCall,
    setWakeWord,
    setCall,
    toggle() {
      if (!recognitionType) {
        speak('El reconocimiento de voz no está disponible en este navegador. Puedes usar el cuadro de texto del panel.');
        return;
      }
      setCall(!inCall);
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'voice.getState') {
      sendResponse({ ok: true, state: currentState(), wakeWordEnabled, inCall, active, processing, speaking, micLevel });
      return false;
    }
    if (message.type === 'voice.setCall') {
      const enabled = Boolean(message.enabled);
      if (enabled && !recognitionType) {
        sendResponse({ ok: false, error: 'El reconocimiento de voz no está disponible en este navegador.' });
        return false;
      }
      sendResponse({ ok: true, inCall: setCall(enabled) });
      return false;
    }
    if (message.type !== 'voice.setWakeWord') return false;
    sendResponse({ ok: true, enabled: setWakeWord(Boolean(message.enabled)) });
    return false;
  });

  chrome.storage.local.get({ wakeWordEnabled: true }, settings => {
    setWakeWord(Boolean(settings.wakeWordEnabled));
  });
})();
