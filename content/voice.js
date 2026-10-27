(() => {
  if (window.__nrviVoiceLoaded) return;
  window.__nrviVoiceLoaded = true;

  const STOP_COMMANDS = ['detente', 'para', 'alto', 'callate', 'silencio', 'cancela', 'cancelar'];
  const PAUSE_COMMAND = 'pausa';
  const RESUME_COMMANDS = ['reanuda', 'continua', 'sigue hablando'];
  const REPEAT_COMMANDS = ['repite', 'repetir', 'otra vez', 'vuelve a explicarlo', 'que dijiste', 'que has dicho', 'repitemelo'];
  const SLOW_COMMANDS = ['mas despacio', 'habla mas despacio', 'explica mas despacio', 'explicamelo mas despacio', 'explicamelo de nuevo mas despacio'];
  const STOP_LISTENING_COMMANDS = [
    'deja de escuchar',
    'para de escuchar',
    'no escuches mas',
    'deja de escucharme',
    'termina',
    'termina la llamada',
    'finaliza',
    'finalizar',
    'finaliza la llamada',
    'finalizar la llamada',
    'cuelga',
    'colgar'
  ];
  const PAUSE_PHRASES = ['pausa la respuesta', 'espera'];
  const STOP_PHRASES = ['deten la respuesta', 'para la respuesta', 'cancela la respuesta'];
  const INACTIVITY_TIMEOUT_MS = 7000;
  const MIN_RECORDING_DURATION_MS = 250;
  const MIN_AUDIO_BYTES = 1024;
  const AUDIO_FALLBACK_MIN_DURATION_MS = 800;
  const AUDIO_FALLBACK_MIN_BYTES = 4096;
  const GREETING = 'Hola, soy Navi, tu asistente de navegación. ¿En qué puedo ayudarte?';
  const FAREWELL = 'De acuerdo, hasta luego.';

  let recorder;
  let audioStream;
  let audioContext;
  let analyser;
  let analyserSink;
  let recorderMonitor;
  let recognitionStarting = false;
  let audioChunks = [];
  let audioBytes = 0;
  let speechDetected = false;
  let recordingStartedAt = 0;
  let speechStartedAt = 0;
  let silenceStartedAt = 0;
  let noiseFloor = 0.01;
  let voiceThreshold = 0.05;
  let noiseSamples = [];
  let lastAudioDiagnosticsAt = 0;
  let mode = 'off';
  let active = false;
  let wakeListeningEnabled = false;
  let wakeWordEnabled = false;
  let inCall = false;
  let processing = false;
  let speaking = false;
  let pausedState = false;
  let currentAudio;
  let lastResponse;
  let spokenText = '';
  let sessionId = null;
  let errorState = null;
  let errorTimer = null;
  let inactivityTimer = null;
  const persistedCallKey = 'nrvi-call-state';

  let micLevel = 0;
  let meterTimer = null;
  let lastSentLevel = -1;

  const normalize = text => String(text || '')
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!,.;:]/g, '')
    .trim();

  const WAKE_WORD_DICTIONARY = {
    navi: ['navi', 'nabi', 'naby', 'navy', 'nave', 'nabhi', 'navi asistente', 'navi asistente']
  };
  const WAKE_VARIANTS = WAKE_WORD_DICTIONARY.navi;

  const extractQuestion = raw => {
    const normalized = normalize(raw);
    const directVariant = WAKE_VARIANTS.find(variant => normalized.startsWith(variant));
    if (directVariant) return normalized.slice(directVariant.length).trim();
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
    if (wakeListeningEnabled && !inCall) return 'standby';
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
    const snapshot = {
      state: currentState(),
      error: errorState,
      wakeWordEnabled: wakeListeningEnabled,
      inCall,
      active,
      processing,
      speaking,
      micLevel,
      noiseFloor,
      voiceThreshold
    };
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
      chrome.runtime.sendMessage({
        type: 'voice.miclevel',
        level: micLevel,
        noiseFloor,
        voiceThreshold
      }, () => void chrome.runtime.lastError);
    } catch {
      void 0;
    }
  };

  const broadcastTranscript = (text, isFinal) => {
    dispatchLocal('nrvi:transcript', { text, final: Boolean(isFinal) });
  };

  const sync = () => broadcastState();

  const persistCallState = () => {
    try {
      if (inCall && sessionId) {
        sessionStorage.setItem(persistedCallKey, JSON.stringify({ sessionId }));
      } else {
        sessionStorage.removeItem(persistedCallKey);
      }
    } catch (error) {
      console.warn('[NRVI] No se pudo conservar la sesión:', error.message);
    }
  };

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
    startRecognition('interrupt');
  };

  const playResponse = (text, audioBase64, audioMimeType = 'audio/mpeg', rate = 1, onend) => {
    stopSpeaking();
    lastResponse = { text, audioBase64, audioMimeType };
    spokenText = text || '';
    if (!audioBase64) {
      speak(text, { rate, onend });
      return;
    }
    currentAudio = new Audio(`data:${audioMimeType};base64,${audioBase64}`);
    currentAudio.playbackRate = rate;
    currentAudio.onended = () => {
      currentAudio = null;
      speaking = false;
      pausedState = false;
      sync();
      onend?.();
    };
    speaking = true;
    sync();
    currentAudio.play().catch(() => {
      currentAudio = null;
      speak(text, { rate, onend });
    });
    startRecognition('interrupt');
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

  const clearInactivityTimer = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  };

  const armInactivityTimer = () => {
    clearInactivityTimer();
    inactivityTimer = setTimeout(() => {
      inactivityTimer = null;
      if (!inCall) return;
      if (active || processing || speaking || recognitionStarting) {
        armInactivityTimer();
        return;
      }
      endCall();
    }, INACTIVITY_TIMEOUT_MS);
  };

  const startsWithPhrase = (value, phrases) => phrases.some(phrase => value === phrase || value.startsWith(`${phrase} `));

  const classifyVoiceCommand = transcript => {
    const command = normalize(transcript);
    if (!command) return null;
    if (STOP_LISTENING_COMMANDS.includes(command)
      || command.endsWith(' finaliza')
      || command.endsWith(' finalizar')
      || command.endsWith(' termina')
      || command.endsWith(' cuelga')) return 'end_call';
    if (STOP_COMMANDS.includes(command) || startsWithPhrase(command, STOP_PHRASES)) return 'stop';
    if (command === PAUSE_COMMAND || startsWithPhrase(command, PAUSE_PHRASES)) return 'pause';
    if (RESUME_COMMANDS.includes(command)) return 'resume';
    if (REPEAT_COMMANDS.includes(command)) return 'repeat';
    if (SLOW_COMMANDS.includes(command)) return 'repeat_slow';
    return null;
  };

  const executeVoiceCommand = command => {
    if (!command) return false;
    console.info('[NRVI] Comando local:', command);
    switch (command) {
      case 'stop':
        window.nrviCancel?.();
        return true;
      case 'pause':
        pauseSpeaking();
        return true;
      case 'resume':
        resumeSpeaking();
        return true;
      case 'repeat':
        replay();
        return true;
      case 'repeat_slow':
        replay({ slow: true });
        return true;
      case 'end_call':
        endCall();
        return true;
      default:
        return false;
    }
  };

  const recorderMimeType = () => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  };

  const stopRecorder = (discard = false, resumeAfterDiscard = true) => {
    if (recorderMonitor) {
      clearInterval(recorderMonitor);
      recorderMonitor = null;
    }
    if (recorder && recorder.state !== 'inactive') {
      recorder.__discard = discard;
      recorder.__resumeAfterDiscard = resumeAfterDiscard;
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
        sessionId,
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
      if (inCall) endCall();
      else if (wakeListeningEnabled) startRecognition('wake');
      else sync();
      return;
    }
    console.info('[NRVI] Transcripción recibida:', text);
    broadcastTranscript(text, true);
    if (!inCall) {
      const question = extractQuestion(text);
      if (question === null) {
        processing = false;
        if (wakeListeningEnabled) {
          sync();
          startRecognition('wake');
        } else {
          sync();
        }
        return;
      }
      processing = false;
      setCall(true, question.trim() || undefined);
      return;
    }
    if (executeVoiceCommand(classifyVoiceCommand(text))) {
      processing = false;
      if (inCall) {
        resumeRecognitionAfterSpeech();
      }
      return;
    }
    const question = extractQuestion(text)?.trim() || text;
    if (executeVoiceCommand(classifyVoiceCommand(question))) {
      processing = false;
      if (inCall) {
        resumeRecognitionAfterSpeech();
      }
      return;
    }
    askQuestion(question);
  };

  const processInterruptionTranscript = transcript => {
    processing = false;
    const command = classifyVoiceCommand(transcript);
    if (command) {
      executeVoiceCommand(command);
      stopRecorder(true);
      return;
    }
    if (!speaking && wakeListeningEnabled) {
      setTimeout(() => resumeRecognitionAfterSpeech(), 0);
    }
  };

  const startRecognition = nextMode => {
    if ((processing && nextMode !== 'interrupt') || active || recognitionStarting || (!inCall && !wakeListeningEnabled)
      || typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    clearInactivityTimer();
    if (document.visibilityState !== 'visible') {
      active = false;
      stopMeter();
      sync();
      return;
    }
    mode = nextMode;
    recognitionStarting = true;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(async stream => {
      if ((nextMode === 'call' && !inCall)
        || (processing && nextMode !== 'interrupt')
        || !wakeListeningEnabled) {
        recognitionStarting = false;
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      recognitionStarting = false;
      audioStream = stream;
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0;
      const source = audioContext.createMediaStreamSource(stream);
      analyserSink = audioContext.createGain();
      analyserSink.gain.value = 0;
      source.connect(analyser);
      analyser.connect(analyserSink);
      analyserSink.connect(audioContext.destination);
      if (audioContext.state === 'suspended') await audioContext.resume();
      const audioTrack = stream.getAudioTracks()[0];
      console.info('[NRVI] AudioContext:', audioContext.state, {
        track: audioTrack?.getSettings?.(),
        enabled: audioTrack?.enabled,
        muted: audioTrack?.muted,
        readyState: audioTrack?.readyState,
        sampleRate: audioContext.sampleRate
      });
      const mimeType = recorderMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunks = [];
      audioBytes = 0;
      speechDetected = false;
      recordingStartedAt = Date.now();
      speechStartedAt = 0;
      silenceStartedAt = 0;
      noiseFloor = 0.01;
      voiceThreshold = 0.05;
      noiseSamples = [];
      lastAudioDiagnosticsAt = 0;
      recorder.ondataavailable = event => {
        if (event.data.size) {
          audioChunks.push(event.data);
          audioBytes += event.data.size;
        }
      };
      recorder.onstop = async () => {
        const chunks = audioChunks;
        const discard = recorder.__discard;
        const resumeAfterDiscard = recorder.__resumeAfterDiscard !== false;
        const recordedMode = mode;
        const recordingDuration = Date.now() - recordingStartedAt;
        const fallbackSpeechDetected = audioBytes >= AUDIO_FALLBACK_MIN_BYTES
          && recordingDuration >= AUDIO_FALLBACK_MIN_DURATION_MS;
        console.info('[NRVI] Audio grabado:', {
          durationMs: recordingDuration,
          bytes: audioBytes,
          rmsDetected: speechDetected,
          fallbackDetected: fallbackSpeechDetected
        });
        audioChunks = [];
        recorder = null;
        stream.getTracks().forEach(track => track.stop());
        audioStream = null;
        audioContext?.close();
        audioContext = null;
        analyser = null;
        analyserSink = null;
        stopMeter();
        active = false;
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        if (
          !chunks.length
          || discard
          || (!speechDetected && !fallbackSpeechDetected)
          || recordingDuration < MIN_RECORDING_DURATION_MS
          || blob.size < MIN_AUDIO_BYTES
        ) {
          if (recordedMode === 'interrupt') {
            if (resumeAfterDiscard && !speaking && wakeListeningEnabled) {
              setTimeout(() => resumeRecognitionAfterSpeech(), 0);
            }
          } else if (inCall && !processing) endCall();
          else if (wakeListeningEnabled && !processing) startRecognition('wake');
          return;
        }
        processing = true;
        sync();
        const result = await requestTranscription(blob);
        if (!result.ok) {
          processing = false;
          fail(result.error || 'No se pudo transcribir el audio.');
          return;
        }
        if (recordedMode === 'interrupt') {
          processInterruptionTranscript(result.text);
          return;
        }
        processTranscript(result.text);
      };
      recorder.start(250);
      active = true;
      console.info('[NRVI] Grabación MediaRecorder iniciada:', mimeType || 'audio/webm');
      startMeter();
      sync();
      const data = new Float32Array(analyser.fftSize);
      recorderMonitor = setInterval(() => {
        if (!recorder || !analyser) return;
        analyser.getFloatTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
        bumpMic(Math.min(1, rms * 5));
        const now = Date.now();
        if (noiseSamples.length < 60) {
          noiseSamples.push(rms);
          noiseFloor = noiseSamples.reduce((sum, sample) => sum + sample, 0) / noiseSamples.length;
          voiceThreshold = Math.max(0.05, noiseFloor * 2.5);
        }
        if (now - lastAudioDiagnosticsAt >= 1000) {
          console.info('[NRVI] Audio:', {
            rms: Number(rms.toFixed(4)),
            noiseFloor: Number(noiseFloor.toFixed(4)),
            voiceThreshold: Number(voiceThreshold.toFixed(4)),
            speechDetected,
            trackEnabled: audioTrack?.enabled,
            trackMuted: audioTrack?.muted,
            trackState: audioTrack?.readyState
          });
          lastAudioDiagnosticsAt = now;
        }
        if (!speechDetected && !speaking && now - recordingStartedAt >= INACTIVITY_TIMEOUT_MS) {
          stopRecorder();
          return;
        }
        if (rms > voiceThreshold) {
          if (!speechDetected) speechStartedAt = now;
          speechDetected = true;
          silenceStartedAt = 0;
          if (speaking) stopSpeaking();
        } else if (speechDetected) {
          silenceStartedAt ||= now;
        }
        if ((speechDetected && silenceStartedAt && now - silenceStartedAt > 1200)
          || (speechStartedAt && now - speechStartedAt > 15000)) {
          stopRecorder();
        }
      }, 100);
    }).catch(error => {
      recognitionStarting = false;
      console.error('[NRVI] No se pudo acceder al micrófono:', error);
      wakeWordEnabled = false;
      inCall = false;
      mode = 'off';
      fail('No se pudo acceder al micrófono. Revisa el permiso de Brave para esta página.');
    });
  };

  const recognitionMode = () => (inCall ? 'call' : 'wake');

  const resumeRecognitionAfterSpeech = () => {
    if (!wakeListeningEnabled || processing || speaking) return;
    if (mode === 'interrupt' && active && !speechDetected) {
      stopRecorder(true);
      setTimeout(() => resumeRecognitionAfterSpeech(), 50);
      return;
    }
    startRecognition(recognitionMode());
    armInactivityTimer();
  };

  const askQuestion = question => {
    processing = true;
    mode = 'off';
    clearTimeout(errorTimer);
    errorState = null;
    sync();
    if (typeof window.nrviAsk !== 'function') {
      processing = false;
      fail('NRVI no está listo para procesar la pregunta.');
      return;
    }
    window.nrviAsk(question, () => {
      processing = false;
      sync();
    });
  };

  const stopWakeWord = () => {
    const closingSessionId = sessionId;
    wakeListeningEnabled = false;
    wakeWordEnabled = false;
    inCall = false;
    sessionId = null;
    persistCallState();
    mode = 'off';
    clearInactivityTimer();
    stopRecorder(true);
    audioStream?.getTracks().forEach(track => track.stop());
    audioStream = null;
    active = false;
    stopMeter();
    if (closingSessionId) {
      chrome.runtime.sendMessage({ type: 'session.end', sessionId: closingSessionId }, () => void chrome.runtime.lastError);
    }
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
    wakeListeningEnabled = true;
    wakeWordEnabled = true;
    sync();
    if (!inCall) startRecognition('wake');
    return true;
  };

  const setCall = (enabled, initialQuestion) => {
    if (enabled) {
      if (inCall) {
        if (!active && !processing && !speaking) startRecognition('call');
        return true;
      }
      sessionId ||= `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      wakeListeningEnabled = true;
      wakeWordEnabled = true;
      inCall = true;
      processing = false;
      persistCallState();
      errorState = null;
      broadcastState();
      speak(GREETING, {
        onend: () => {
          if (!inCall) return;
          const continueConversation = () => {
            if (initialQuestion) askQuestion(initialQuestion);
            else resumeRecognitionAfterSpeech();
          };
          if (mode === 'interrupt' && active && !speechDetected) {
            stopRecorder(true, false);
            setTimeout(continueConversation, 50);
          } else {
            continueConversation();
          }
          armInactivityTimer();
        }
      });
      return true;
    }
    const closingSessionId = sessionId;
    processing = false;
    if (inCall) {
      speak(FAREWELL, {
        onend: () => {
          if (wakeListeningEnabled && !inCall && !processing) startRecognition('wake');
        }
      });
    }
    inCall = false;
    clearInactivityTimer();
    stopRecorder(true);
    audioStream?.getTracks().forEach(track => track.stop());
    audioStream = null;
    active = false;
    stopMeter();
    persistCallState();
    if (closingSessionId) {
      chrome.runtime.sendMessage({ type: 'session.end', sessionId: closingSessionId }, () => void chrome.runtime.lastError);
    }
    sessionId = null;
    sync();
    return false;
  };

  const endCall = () => {
    setCall(false);
  };

  const restoreSession = restoredSessionId => {
    if (!restoredSessionId) return false;
    sessionId = restoredSessionId;
    wakeWordEnabled = true;
    wakeListeningEnabled = true;
    inCall = true;
    errorState = null;
    persistCallState();
    sync();
    return true;
  };

  const restoreCallState = () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(persistedCallKey) || 'null');
      if (!saved?.sessionId) return;
      restoreSession(saved.sessionId);
      if (document.visibilityState === 'visible') {
        setTimeout(() => {
          let navigationPending = false;
          try {
            navigationPending = sessionStorage.getItem('nrvi-navigation-pending') === 'true';
          } catch {
            navigationPending = false;
          }
          if (!navigationPending && inCall && !active && !processing && !speaking) startRecognition('call');
        }, 250);
      }
    } catch (error) {
      console.warn('[NRVI] No se pudo restaurar la sesión:', error.message);
    }
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
    getSessionId: () => sessionId,
    restoreSession,
    armInactivityTimer,
    resumeRecognition: resumeRecognitionAfterSpeech,
    isWakeWordEnabled: () => wakeListeningEnabled,
    isInCall: () => inCall,
    setWakeWord,
    setCall,
    toggle() {
      setCall(!inCall);
    }
  };

  restoreCallState();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'voice.getState') {
      sendResponse({
        ok: true,
        state: currentState(),
        wakeWordEnabled,
        inCall,
        active,
        processing,
        speaking,
        micLevel,
        noiseFloor,
        voiceThreshold
      });
      return false;
    }
    if (message.type === 'voice.setCall') {
      const enabled = Boolean(message.enabled);
      sendResponse({ ok: true, inCall: setCall(enabled) });
      return false;
    }
    if (message.type === 'voice.setWakeWord') {
      const enabled = setWakeWord(Boolean(message.enabled));
      chrome.storage.local.set({ wakeWordEnabled: Boolean(message.enabled) });
      sendResponse({ ok: true, enabled });
      return false;
    }
    return false;
  });

  chrome.storage.local.get({ wakeWordEnabled: true }, settings => {
    setWakeWord(Boolean(settings.wakeWordEnabled));
  });
})();
