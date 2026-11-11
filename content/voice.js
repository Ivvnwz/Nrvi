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
  const INACTIVITY_TIMEOUT_MS = 180000;
  const FACE_ABSENCE_TIMEOUT_MS = 7000;
  const FACE_REMINDER_DELAY_MS = 5000;
  const REQUEST_CAPTURE_TIMEOUT_MS = 9000;
  const MIN_RECORDING_DURATION_MS = 250;
  const MIN_AUDIO_BYTES = 1024;
  const AUDIO_FALLBACK_MIN_DURATION_MS = 800;
  const AUDIO_FALLBACK_MIN_BYTES = 4096;
  const GREETING = 'Hola, soy Navi, tu asistente de navegación. ¿En qué puedo ayudarte?';
  const FAREWELL = 'De acuerdo, hasta luego.';
  const FACE_ABSENCE_FAREWELL = 'Usuario ausente, terminando llamada.';
  const FACE_REMINDER = 'Usuario presente, diga Navi para activar el asistente.';

  let recorder;
  let recorderGeneration = 0;
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
  let wakeWordPreferenceEnabled = false;
  let facePresenceEnabled = true;
  let facePresent = false;
  let faceWasDetected = false;
  let faceAbsenceTimer = null;
  let faceReminderTimer = null;
  let faceReminderShown = false;
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
    const allowInterruption = typeof options !== 'object' || options.allowInterruption !== false;
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
    clearFaceAbsenceTimer();
    sync();
    utterance.onend = () => {
      speaking = false;
      pausedState = false;
      armFaceAbsenceTimer();
      sync();
      onend?.();
    };
    speechSynthesis.speak(utterance);
    if (allowInterruption) startRecognition('interrupt');
  };

  const playResponse = (text, audioBase64, audioMimeType = 'audio/mpeg', rate = 1, onend, allowInterruption = true) => {
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
      armFaceAbsenceTimer();
      sync();
      onend?.();
    };
    speaking = true;
    clearFaceAbsenceTimer();
    sync();
    currentAudio.play().catch(() => {
      currentAudio = null;
      speak(text, { rate, onend });
    });
    if (allowInterruption) startRecognition('interrupt');
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

  const clearFaceAbsenceTimer = () => {
    if (faceAbsenceTimer) {
      clearTimeout(faceAbsenceTimer);
      faceAbsenceTimer = null;
    }
  };

  const clearFaceReminderTimer = () => {
    if (faceReminderTimer) {
      clearTimeout(faceReminderTimer);
      faceReminderTimer = null;
    }
  };

  const armFaceReminder = () => {
    if (faceReminderTimer || !wakeListeningEnabled || inCall || !facePresent || speaking || faceReminderShown) return;
    faceReminderTimer = setTimeout(() => {
      faceReminderTimer = null;
      if (!wakeListeningEnabled || inCall || !facePresent || speaking || faceReminderShown) return;
      faceReminderShown = true;
      speak(FACE_REMINDER, {
        allowInterruption: false,
        onend: () => {
          if (wakeListeningEnabled && !inCall && !speaking) startRecognition('wake');
        }
      });
    }, FACE_REMINDER_DELAY_MS);
  };

  const armFaceAbsenceTimer = () => {
    if (faceAbsenceTimer || !inCall || speaking || facePresent || !faceWasDetected) return;
    faceAbsenceTimer = setTimeout(() => {
      faceAbsenceTimer = null;
      if (facePresent || speaking || !inCall) return;
      setCall(false, undefined, FACE_ABSENCE_FAREWELL);
    }, FACE_ABSENCE_TIMEOUT_MS);
  };

  const setFacePresence = (present, available = true) => {
    facePresenceEnabled = available;
    if (!available) {
      facePresent = true;
      if (wakeWordPreferenceEnabled) {
        wakeListeningEnabled = true;
        wakeWordEnabled = true;
        sync();
        if (!inCall) startRecognition('wake');
      }
      return;
    }
    facePresent = Boolean(present);
    if (facePresent) {
      faceWasDetected = true;
      clearFaceAbsenceTimer();
      armFaceReminder();
      if (wakeWordPreferenceEnabled && !inCall) {
        wakeListeningEnabled = true;
        wakeWordEnabled = true;
        sync();
        startRecognition('wake');
      }
      return;
    }
    if (inCall && faceWasDetected) {
      armFaceAbsenceTimer();
      sync();
      return;
    }
    faceReminderShown = false;
    clearFaceReminderTimer();
    if (wakeWordPreferenceEnabled && faceWasDetected) {
      clearFaceAbsenceTimer();
      faceAbsenceTimer = setTimeout(() => {
        faceAbsenceTimer = null;
        if (facePresent || !faceWasDetected) return;
        if (inCall) {
          setCall(false, undefined, FACE_ABSENCE_FAREWELL);
          return;
        }
        if (!wakeWordPreferenceEnabled) return;
        wakeListeningEnabled = false;
        wakeWordEnabled = false;
        stopRecorder(true);
        sync();
      }, FACE_ABSENCE_TIMEOUT_MS);
      sync();
    }
  };

  const setHandGesture = gesture => {
    if (gesture === 'fist') {
      pauseSpeaking();
    } else if (gesture === 'open' && pausedState) {
      resumeSpeaking();
    } else if (gesture === 'thumbs_up') {
      replay();
    } else if (gesture === 'victory') {
      stopRecorder(true, false);
      window.nrviCancel?.();
      stopSpeaking();
      processing = false;
      sync();
      restartRecognitionAfterInterruption();
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
        stopSpeaking();
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
    const text = String(transcript || '').trim();
    const command = classifyVoiceCommand(text);
    if (command) {
      executeVoiceCommand(command);
      stopRecorder(true, false);
      setTimeout(restartRecognitionAfterInterruption, 150);
      return;
    }
    const question = extractQuestion(text);
    if (question === null) {
      if (wakeListeningEnabled) {
        setTimeout(() => {
          if (speaking) resumeInterruptionRecognition();
          else resumeRecognitionAfterSpeech();
        }, 0);
      }
      return;
    }
    const wakeQuestion = question.trim();
    const wakeCommand = classifyVoiceCommand(wakeQuestion);
    if (wakeCommand) {
      executeVoiceCommand(wakeCommand);
      stopRecorder(true, false);
      setTimeout(restartRecognitionAfterInterruption, 150);
      return;
    }
    if (wakeQuestion && speaking) {
      stopSpeaking();
      askQuestion(wakeQuestion);
      return;
    }
    if (wakeListeningEnabled) {
      setTimeout(() => {
        if (speaking) resumeInterruptionRecognition();
        else resumeRecognitionAfterSpeech();
      }, 0);
    }
  };

  const startRecognition = nextMode => {
    if ((processing && nextMode !== 'interrupt') || active || recognitionStarting
      || (nextMode === 'wake' && !wakeListeningEnabled)
      || (nextMode !== 'wake' && !inCall && !wakeListeningEnabled)
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
      const recorderInstance = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const generation = ++recorderGeneration;
      recorderInstance.__mode = nextMode;
      recorder = recorderInstance;
      const recording = {
        chunks: [],
        bytes: 0,
        startedAt: Date.now(),
        speechDetected: false,
        speechStartedAt: 0,
        silenceStartedAt: 0,
        maxDurationTimer: null
      };
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
      recorderInstance.ondataavailable = event => {
        if (event.data.size) {
          recording.chunks.push(event.data);
          recording.bytes += event.data.size;
        }
      };
      recorderInstance.onstop = async () => {
        const isCurrentRecorder = recorder === recorderInstance && generation === recorderGeneration;
        if (recording.maxDurationTimer) {
          clearTimeout(recording.maxDurationTimer);
          recording.maxDurationTimer = null;
        }
        const chunks = recording.chunks;
        const discard = recorderInstance?.__discard;
        const resumeAfterDiscard = recorderInstance?.__resumeAfterDiscard !== false;
        const recordedMode = recorderInstance?.__mode || nextMode;
        const recordingDuration = Date.now() - recording.startedAt;
        const interruptionAudioDetected = recordedMode === 'interrupt'
          && recording.bytes >= MIN_AUDIO_BYTES
          && recordingDuration >= MIN_RECORDING_DURATION_MS;
        const fallbackSpeechDetected = recording.bytes >= AUDIO_FALLBACK_MIN_BYTES
          && recordingDuration >= AUDIO_FALLBACK_MIN_DURATION_MS;
        console.info('[NRVI] Audio grabado:', {
          durationMs: recordingDuration,
          bytes: recording.bytes,
          rmsDetected: recording.speechDetected,
          fallbackDetected: fallbackSpeechDetected
        });
        stream.getTracks().forEach(track => track.stop());
        if (!isCurrentRecorder) return;
        recorder = null;
        audioChunks = [];
        audioStream = null;
        audioContext?.close();
        audioContext = null;
        analyser = null;
        analyserSink = null;
        stopMeter();
        active = false;
        processing = false;
        sync();
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        if (
          !chunks.length
          || discard
          || (!recording.speechDetected && !fallbackSpeechDetected && !interruptionAudioDetected)
          || recordingDuration < MIN_RECORDING_DURATION_MS
          || blob.size < MIN_AUDIO_BYTES
        ) {
          if (recordedMode === 'interrupt') {
            if (resumeAfterDiscard && wakeListeningEnabled) {
              setTimeout(() => {
                if (speaking) resumeInterruptionRecognition();
                else resumeRecognitionAfterSpeech();
              }, 0);
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
      recorderInstance.start(250);
      active = true;
      console.info('[NRVI] Grabación MediaRecorder iniciada:', mimeType || 'audio/webm');
      startMeter();
      sync();
      recording.maxDurationTimer = setTimeout(() => {
        if (recorder !== recorderInstance || generation !== recorderGeneration) return;
        console.info('[NRVI] Límite de captura alcanzado:', REQUEST_CAPTURE_TIMEOUT_MS);
        stopRecorder();
      }, REQUEST_CAPTURE_TIMEOUT_MS);
      const data = new Float32Array(analyser.fftSize);
      const monitor = setInterval(() => {
        if (recorder !== recorderInstance || generation !== recorderGeneration || !analyser) {
          clearInterval(monitor);
          if (recorderMonitor === monitor) recorderMonitor = null;
          return;
        }
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
          if (!recording.speechDetected) {
            speechStartedAt = now;
            recording.speechStartedAt = now;
          }
          speechDetected = true;
          recording.speechDetected = true;
          silenceStartedAt = 0;
          recording.silenceStartedAt = 0;
          if (speaking && nextMode !== 'interrupt') stopSpeaking();
        } else if (speechDetected) {
          silenceStartedAt ||= now;
          recording.silenceStartedAt ||= now;
        }
        if ((recording.speechDetected && recording.silenceStartedAt && now - recording.silenceStartedAt > 1200)
          || (recording.speechStartedAt && now - recording.speechStartedAt > REQUEST_CAPTURE_TIMEOUT_MS)) {
          stopRecorder();
        }
      }, 100);
      recorderMonitor = monitor;
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

  const resumeInterruptionRecognition = () => {
    if (!wakeListeningEnabled || processing || !speaking) return;
    startRecognition('interrupt');
  };

  const restartRecognitionAfterInterruption = (attempt = 0) => {
    if ((recorder || active) && attempt < 10) {
      setTimeout(() => restartRecognitionAfterInterruption(attempt + 1), 150);
      return;
    }
    processing = false;
    active = false;
    recognitionStarting = false;
    sync();
    if (inCall) {
      resumeRecognitionAfterSpeech();
    } else if (wakeListeningEnabled) {
      startRecognition('wake');
    }
    armInactivityTimer();
  };

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

  const setWakeWord = (enabled, startVision = true) => {
    if (!enabled) {
      wakeWordPreferenceEnabled = false;
      faceWasDetected = false;
      clearFaceAbsenceTimer();
      window.nrviVision?.stop?.();
      stopWakeWord();
      return false;
    }
    wakeWordPreferenceEnabled = true;
    wakeListeningEnabled = true;
    wakeWordEnabled = true;
    sync();
    if (startVision) window.nrviVision?.start?.();
    if (!inCall) startRecognition('wake');
    return true;
  };

  const setCall = (enabled, initialQuestion, farewell = FAREWELL) => {
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
      if (wakeWordPreferenceEnabled) window.nrviVision?.start?.();
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
      speak(farewell, {
        allowInterruption: false,
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

  const endCall = farewell => {
    setCall(false, undefined, farewell);
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
    setFacePresence,
    setHandGesture,
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
    if (message.type === 'vision.setPreview') {
      (async () => {
        try {
          if (message.visible && !window.nrviVision?.isRunning?.()) {
            const started = await window.nrviVision?.start?.();
            if (!started) throw new Error('No se pudo iniciar la cámara.');
          }
          const visible = window.nrviVision?.setPreview?.(message.visible) ?? Boolean(message.visible);
          chrome.storage.local.set({ cameraPreviewVisible: Boolean(message.visible) });
          sendResponse({ ok: true, visible });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
      })();
      return true;
    }
    if (message.type === 'vision.setLandmarks') {
      (async () => {
        try {
          if (message.visible && !window.nrviVision?.isRunning?.()) {
            const started = await window.nrviVision?.start?.();
            if (!started) throw new Error('No se pudo iniciar la cámara.');
          }
          const visible = window.nrviVision?.setLandmarks?.(message.visible) ?? Boolean(message.visible);
          chrome.storage.local.set({ cameraLandmarksVisible: Boolean(message.visible) });
          sendResponse({ ok: true, visible });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
      })();
      return true;
    }
    if (message.type === 'vision.getState') {
      sendResponse({ ok: true, ...(window.nrviVision?.getState?.() || {}) });
      return false;
    }
    return false;
  });

  chrome.storage.local.get({ wakeWordEnabled: true }, settings => {
    wakeWordPreferenceEnabled = Boolean(settings.wakeWordEnabled);
    setWakeWord(Boolean(settings.wakeWordEnabled), Boolean(settings.wakeWordEnabled));
  });
})();
