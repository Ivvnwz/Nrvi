(() => {
  if (window.__nrviVoiceLoaded) return;
  window.__nrviVoiceLoaded = true;

  const STOP_COMMANDS = ['detente', 'para', 'alto', 'callate', 'silencio', 'cancela', 'cancelar'];
  const PAUSE_COMMAND = 'pausa';
  const RESUME_COMMANDS = ['reanuda', 'continua', 'sigue hablando'];
  const REPEAT_COMMANDS = ['repite', 'repetir', 'otra vez', 'vuelve a explicarlo', 'que dijiste', 'que has dicho', 'repitemelo'];
  const SLOW_COMMANDS = ['mas despacio', 'habla mas despacio', 'explica mas despacio', 'explicamelo mas despacio', 'explicamelo de nuevo mas despacio'];
  const STOP_LISTENING_COMMANDS = ['deja de escuchar', 'para de escuchar', 'no escuches mas', 'deja de escucharme', 'termina', 'cuelga', 'colgar', 'termina la llamada'];

  let recorder;
  let audioStream;
  let audioContext;
  let analyser;
  let recorderMonitor;
  let audioChunks = [];
  let speechDetected = false;
  let speechStartedAt = 0;
  let silenceStartedAt = 0;
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
    const snapshot = { state: currentState(), error: errorState, wakeWordEnabled, inCall, active, processing, speaking, micLevel };
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
    console.error('[NRVI] Error de voz:', message);
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

  const recorderMimeType = () => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  };

  const stopRecorder = (discard = false) => {
    if (recorderMonitor) {
      clearInterval(recorderMonitor);
      recorderMonitor = null;
    }
    if (recorder && recorder.state !== 'inactive') {
      recorder.__discard = discard;
      recorder.stop();
    }
  };

  const requestTranscription = blob => new Promise(resolve => {
    blob.arrayBuffer().then(audio => {
      const bytes = new Uint8Array(audio);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      chrome.runtime.sendMessage({
        type: 'transcription.request',
        audioBase64: btoa(binary),
        mimeType: blob.type || 'audio/webm',
        fileName: 'nrvi.webm'
      }, response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: 'No hubo respuesta del backend.' });
      });
    }).catch(error => resolve({ ok: false, error: error.message }));
  });

  const processTranscript = transcript => {
    const text = String(transcript || '').trim();
    if (!text) {
      processing = false;
      if (inCall) startRecognition('call');
      else sync();
      return;
    }
    console.info('[NRVI] Transcripción recibida:', text);
    broadcastTranscript(text, true);
    if (handleVoiceCommand(text)) {
      processing = false;
      if (inCall) startRecognition('call');
      return;
    }
    const question = extractQuestion(text)?.trim() || text;
    if (handleVoiceCommand(question)) {
      processing = false;
      if (inCall) startRecognition('call');
      return;
    }
    askQuestion(question);
  };

  const startRecognition = nextMode => {
    if (processing || !inCall || typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    if (document.visibilityState !== 'visible') {
      active = false;
      stopMeter();
      sync();
      return;
    }
    mode = nextMode;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      if (!inCall || processing) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      audioStream = stream;
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const mimeType = recorderMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunks = [];
      speechDetected = false;
      speechStartedAt = 0;
      silenceStartedAt = 0;
      recorder.ondataavailable = event => {
        if (event.data.size) audioChunks.push(event.data);
      };
      recorder.onstop = async () => {
        const chunks = audioChunks;
        const discard = recorder.__discard;
        audioChunks = [];
        recorder = null;
        stream.getTracks().forEach(track => track.stop());
        audioStream = null;
        audioContext?.close();
        audioContext = null;
        analyser = null;
        stopMeter();
        active = false;
        if (!chunks.length || discard) {
          if (inCall && !processing) startRecognition('call');
          return;
        }
        processing = true;
        sync();
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        const result = await requestTranscription(blob);
        if (!result.ok) {
          processing = false;
          fail(result.error || 'No se pudo transcribir el audio.');
          return;
        }
        processTranscript(result.text);
      };
      recorder.start();
      active = true;
      console.info('[NRVI] Grabación MediaRecorder iniciada:', mimeType || 'audio/webm');
      startMeter();
      sync();
      const data = new Uint8Array(analyser.fftSize);
      recorderMonitor = setInterval(() => {
        if (!recorder || !analyser) return;
        analyser.getByteTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, value) => {
          const sample = (value - 128) / 128;
          return sum + sample * sample;
        }, 0) / data.length);
        bumpMic(Math.min(1, rms * 5));
        const now = Date.now();
        if (rms > 0.035) {
          if (!speechDetected) speechStartedAt = now;
          speechDetected = true;
          silenceStartedAt = 0;
        } else if (speechDetected) {
          silenceStartedAt ||= now;
        }
        if ((speechDetected && silenceStartedAt && now - silenceStartedAt > 1200)
          || now - speechStartedAt > 15000) {
          stopRecorder();
        }
      }, 100);
    }).catch(error => {
      console.error('[NRVI] No se pudo acceder al micrófono:', error);
      wakeWordEnabled = false;
      inCall = false;
      mode = 'off';
      fail('No se pudo acceder al micrófono. Revisa el permiso de Brave para esta página.');
    });
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
    stopRecorder(true);
    audioStream?.getTracks().forEach(track => track.stop());
    audioStream = null;
    active = false;
    stopMeter();
    sync();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      stopRecorder(true);
      audioStream?.getTracks().forEach(track => track.stop());
      audioStream = null;
      active = false;
      stopMeter();
      sync();
      return;
    }
    if (wakeWordEnabled && !processing) startRecognition(recognitionMode());
  });

  const setWakeWord = enabled => {
    if (!enabled) {
      stopWakeWord();
      return false;
    }
    wakeWordEnabled = false;
    sync();
    return false;
  };

  const setCall = (enabled, initialQuestion) => {
    if (enabled) {
      wakeWordEnabled = true;
      inCall = true;
      errorState = null;
      broadcastState();
      if (initialQuestion) {
        askQuestion(initialQuestion);
      } else {
        startRecognition('call');
      }
      return true;
    }
    inCall = false;
    stopWakeWord();
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
      sendResponse({ ok: true, inCall: setCall(enabled) });
      return false;
    }
    if (message.type !== 'voice.setWakeWord') return false;
    sendResponse({ ok: true, enabled: setWakeWord(Boolean(message.enabled)) });
    return false;
  });

  chrome.storage.local.get({ wakeWordEnabled: false }, settings => {
    setWakeWord(Boolean(settings.wakeWordEnabled));
  });
})();
