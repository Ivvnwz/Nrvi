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
    lastResponse = null;
  };

  const pauseSpeaking = () => {
    window.speechSynthesis?.pause();
    currentAudio?.pause();
  };

  const resumeSpeaking = () => {
    window.speechSynthesis?.resume();
    if (currentAudio?.paused) currentAudio.play().catch(() => speak(lastResponse?.text));
  };

  const playResponse = (text, audioBase64, audioMimeType = 'audio/mpeg') => {
    stopSpeaking();
    lastResponse = { text, audioBase64, audioMimeType };
    if (!audioBase64) {
      speak(text);
      return;
    }
    currentAudio = new Audio(`data:${audioMimeType};base64,${audioBase64}`);
    currentAudio.onended = () => { currentAudio = null; };
    currentAudio.play().catch(() => {
      currentAudio = null;
      speak(text);
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

  const startRecognition = nextMode => {
    if (!recognitionType || processing) return;
    if (recognition) recognition.abort();
    mode = nextMode;
    recognition = new recognitionType();
    recognition.lang = 'es-ES';
    recognition.continuous = nextMode === 'wake';
    recognition.interimResults = false;
    recognition.onstart = () => { active = true; };
    recognition.onend = () => {
      active = false;
      recognition = null;
      if (wakeWordEnabled && mode === 'wake' && !processing) {
        setTimeout(() => startRecognition('wake'), 300);
      }
    };
    recognition.onerror = event => {
      active = false;
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) {
        wakeWordEnabled = false;
        mode = 'off';
        speak('No tengo permiso para usar el micrófono.');
      }
    };
    recognition.onresult = event => {
      const transcript = event.results[event.results.length - 1]?.[0]?.transcript?.trim();
      if (!transcript) return;

      if (mode === 'wake') {
        if (handlePlaybackCommand(transcript)) return;
        const normalized = normalize(transcript);
        const wakeIndex = normalized.indexOf(WAKE_WORD);
        if (wakeIndex < 0) return;
        const question = transcript.slice(wakeIndex + WAKE_WORD.length).trim();
        recognition.stop();
        if (question) {
          askQuestion(question);
        } else {
          mode = 'question';
          speak('Dime, ¿en qué puedo ayudarte?', () => {
            if (wakeWordEnabled && !processing) startRecognition('question');
          });
        }
        return;
      }

      recognition.stop();
      askQuestion(transcript);
    };
    try {
      recognition.start();
    } catch (error) {
      if (error.name !== 'InvalidStateError') speak('No pude iniciar el micrófono.');
    }
  };

  const askQuestion = question => {
    processing = true;
    mode = 'off';
    window.nrviAsk?.(question, () => {
      processing = false;
      if (wakeWordEnabled) startRecognition('wake');
    });
  };

  const stopWakeWord = () => {
    wakeWordEnabled = false;
    mode = 'off';
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
    startRecognition('wake');
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
    if (message.type !== 'voice.setWakeWord') return false;
    sendResponse({ ok: true, enabled: setWakeWord(Boolean(message.enabled)) });
    return false;
  });

  chrome.storage.local.get({ wakeWordEnabled: true }, settings => {
    setWakeWord(Boolean(settings.wakeWordEnabled));
  });
})();
