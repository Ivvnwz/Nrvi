(() => {
  const WAKE_WORD = 'navi';
  const STOP_COMMANDS = ['detente', 'para', 'alto', 'callate'];
  const PAUSE_COMMAND = 'pausa';
  const RESUME_COMMANDS = ['reanuda', 'continua', 'sigue hablando'];
  const speak = (text, onend) => {
    stopSpeaking();
    if (!text || !('speechSynthesis' in window)) {
      onend?.();
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    utterance.onend = () => onend?.();
    speechSynthesis.speak(utterance);
  };
  const recognitionType = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition;
  let active = false;
  let mode = 'off';
  let wakeWordEnabled = false;
  let processing = false;
  let currentAudio;
  let lastResponse;
  let recognitionGeneration = 0;
  let restartTimer;
  let pendingMode;
  let promptComplete = true;

  const normalize = text => String(text || '')
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  const stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
  };

  const pauseSpeaking = () => {
    window.speechSynthesis?.pause();
    currentAudio?.pause();
  };

  const resumeSpeaking = () => {
    window.speechSynthesis?.resume();
    if (currentAudio?.paused) currentAudio.play().catch(() => speak(lastResponse?.text));
  };

  const playResponse = (text, audioBase64, audioMimeType = 'audio/mpeg', onend) => {
    stopSpeaking();
    lastResponse = { text, audioBase64, audioMimeType };
    if (!audioBase64) {
      speak(text, onend);
      return;
    }
    currentAudio = new Audio(`data:${audioMimeType};base64,${audioBase64}`);
    currentAudio.onended = () => {
      currentAudio = null;
      onend?.();
    };
    currentAudio.play().catch(() => {
      currentAudio = null;
      speak(text, onend);
    });
  };

  const handlePlaybackCommand = transcript => {
    const command = normalize(transcript).replace(/[¿?¡!,.;:]/g, '').trim();
    if (STOP_COMMANDS.includes(command)) {
      stopSpeaking();
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
    return false;
  };

  const scheduleWakeRecognition = () => {
    clearTimeout(restartTimer);
    if (!wakeWordEnabled || processing || recognition || mode !== 'wake') return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startRecognition('wake');
    }, 350);
  };

  const requestRecognition = nextMode => {
    pendingMode = nextMode;
    if (!recognition && !processing && promptComplete) {
      const requestedMode = pendingMode;
      pendingMode = null;
      startRecognition(requestedMode);
    }
  };

  const startPendingRecognition = () => {
    if (!pendingMode || recognition || processing || !promptComplete) return;
    const requestedMode = pendingMode;
    pendingMode = null;
    startRecognition(requestedMode);
  };

  const startRecognition = nextMode => {
    if (!recognitionType || processing || recognition) return;
    clearTimeout(restartTimer);
    mode = nextMode;
    const generation = ++recognitionGeneration;
    const instance = new recognitionType();
    recognition = instance;
    instance.lang = 'es-ES';
    instance.continuous = nextMode === 'wake';
    instance.interimResults = false;
    instance.onstart = () => {
      if (recognition !== instance || generation !== recognitionGeneration) return;
      active = true;
    };
    instance.onend = () => {
      if (recognition !== instance || generation !== recognitionGeneration) return;
      recognition = null;
      active = false;
      if (pendingMode) {
        startPendingRecognition();
      } else if (wakeWordEnabled && mode === 'wake' && !processing) {
        scheduleWakeRecognition();
      }
    };
    instance.onerror = event => {
      if (recognition !== instance || generation !== recognitionGeneration) return;
      active = false;
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) {
        wakeWordEnabled = false;
        pendingMode = null;
        mode = 'off';
        speak(event.error === 'audio-capture'
          ? 'No pude acceder al micrófono.'
          : 'No tengo permiso para usar el micrófono.');
      } else if (event.error === 'no-speech' && nextMode === 'question') {
        speak('No detecté voz. Di Navi para intentarlo de nuevo.');
      } else if (event.error === 'network') {
        speak('Se perdió la conexión con el reconocimiento de voz.');
      }
    };
    instance.onresult = event => {
      if (recognition !== instance || generation !== recognitionGeneration) return;
      const transcript = event.results[event.results.length - 1]?.[0]?.transcript?.trim();
      if (!transcript) return;

      if (nextMode === 'wake') {
        if (handlePlaybackCommand(transcript)) return;
        const normalized = normalize(transcript);
        const wakeIndex = normalized.indexOf(WAKE_WORD);
        if (wakeIndex < 0) return;
        mode = 'prompting';
        pendingMode = 'question';
        promptComplete = false;
        instance.stop();
        speak('Dime, ¿en qué puedo ayudarte?', () => {
          promptComplete = true;
          startPendingRecognition();
        });
        return;
      }

      instance.stop();
      askQuestion(transcript);
    };
    try {
      instance.start();
    } catch (error) {
      if (recognition === instance) {
        recognition = null;
        active = false;
      }
      if (error.name !== 'InvalidStateError') {
        speak('No pude iniciar el micrófono.');
      } else if (nextMode === 'wake' && wakeWordEnabled && !processing) {
        scheduleWakeRecognition();
      }
    }
  };

  const askQuestion = question => {
    processing = true;
    mode = 'off';
    window.nrviAsk?.(question, () => {
      processing = false;
      if (wakeWordEnabled) requestRecognition('wake');
    });
  };

  const stopWakeWord = () => {
    wakeWordEnabled = false;
    mode = 'off';
    pendingMode = null;
    promptComplete = true;
    clearTimeout(restartTimer);
    if (recognition) {
      recognition.onend = null;
      recognition.abort();
      recognition = null;
    }
    active = false;
  };

  const setWakeWord = enabled => {
    if (!recognitionType) {
      stopWakeWord();
      speak('Este navegador no permite reconocimiento de voz.');
      return false;
    }
    if (!enabled) {
      stopWakeWord();
      return false;
    }
    wakeWordEnabled = true;
    requestRecognition('wake');
    return true;
  };

  window.nrviVoice = {
    speak,
    playResponse,
    stopSpeaking,
    pauseSpeaking,
    resumeSpeaking,
    isWakeWordEnabled: () => wakeWordEnabled,
    setWakeWord,
    toggle() {
      if (!recognitionType) {
        speak('Este navegador no permite reconocimiento de voz. Puedes usar el cuadro de texto del panel.');
        return;
      }
      setWakeWord(!wakeWordEnabled);
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'voice.getStatus') {
      sendResponse({ ok: true, enabled: wakeWordEnabled, active, mode });
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
