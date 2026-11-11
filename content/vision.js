(() => {
  if (window.__nrviVisionLoaded) return;
  window.__nrviVisionLoaded = true;

  const DETECTION_INTERVAL_MS = 250;
  const GESTURE_STABILITY_MS = 4000;
  const FIST_STABILITY_MS = 5000;
  const VICTORY_STABILITY_MS = 3000;
  let video;
  let canvas;
  let context;
  let markerCanvas;
  let markerContext;
  let resultLabel;
  let stream;
  let timer;
  let running = false;
  let starting = false;
  let candidateGesture = null;
  let candidateSince = 0;
  let lastGesture = null;
  let lastGestureAt = 0;
  let previewVisible = false;
  let landmarksVisible = false;
  let lastFacePresent = false;
  let lastHandPresent = false;
  let sandbox;
  let sandboxReady;

  const gestureLabel = gesture => ({
    open: 'abierta',
    fist: 'puño',
    thumbs_up: 'pulgar arriba',
    thumbs_down: 'pulgar abajo',
    victory: 'dos dedos',
    both_open: 'ambas palmas'
  }[gesture] || gesture);

  const notify = detail => {
    lastFacePresent = Boolean(detail.present);
    if (resultLabel) {
      resultLabel.textContent = detail.available === false
        ? `Visión no disponible${detail.error ? `: ${detail.error}` : ''}`
        : lastFacePresent ? 'Rostro detectado' : 'Rostro no detectado';
    }
    window.dispatchEvent(new CustomEvent('nrvi:face-presence', { detail }));
    window.nrviVoice?.setFacePresence?.(detail.present, detail.available);
  };

  const notifyHand = gesture => {
    lastGesture = gesture;
    if (resultLabel && gesture) resultLabel.textContent = `Rostro detectado | Mano: ${gestureLabel(gesture)}`;
    window.dispatchEvent(new CustomEvent('nrvi:hand-gesture', {
      detail: { gesture, stable: Boolean(gesture) }
    }));
    window.nrviVoice?.setHandGesture?.(gesture);
  };

  const updateHandStatus = hand => {
    lastHandPresent = Boolean(hand?.points?.length);
    if (!resultLabel) return;
    const faceStatus = lastFacePresent ? 'Rostro detectado' : 'Rostro no detectado';
    const handStatus = lastHandPresent
      ? `Mano detectada${hand?.gesture ? `: ${gestureLabel(hand.gesture)}` : ''}`
      : 'Mano no detectada';
    resultLabel.textContent = `${faceStatus} | ${handStatus}`;
  };

  const stop = () => {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video?.remove();
    canvas?.remove();
    markerCanvas?.remove();
    resultLabel?.remove();
    sandbox?.remove();
    video = null;
    canvas = null;
    context = null;
    markerCanvas = null;
    markerContext = null;
    resultLabel = null;
    sandbox = null;
    sandboxReady = null;
    candidateGesture = null;
    candidateSince = 0;
    lastGesture = null;
    lastGestureAt = 0;
    lastFacePresent = false;
    lastHandPresent = false;
    lastGesture = null;
    notify({ present: false, available: true });
  };

  const setPreview = visible => {
    previewVisible = Boolean(visible);
    if (!video || !resultLabel) return previewVisible === false;
    video.style.display = previewVisible ? 'block' : 'none';
    markerCanvas.style.display = previewVisible && landmarksVisible ? 'block' : 'none';
    resultLabel.style.display = previewVisible ? 'block' : 'none';
    return true;
  };

  const setLandmarks = visible => {
    landmarksVisible = Boolean(visible);
    if (markerCanvas) markerCanvas.style.display = previewVisible && landmarksVisible ? 'block' : 'none';
    return landmarksVisible;
  };

  const drawFaceMarkers = faces => {
    if (!landmarksVisible || !markerContext) return;
    markerContext.clearRect(0, 0, markerCanvas.width, markerCanvas.height);
    markerContext.strokeStyle = '#22d3ee';
    markerContext.fillStyle = '#22d3ee';
    markerContext.lineWidth = 3;
    for (let index = 0; index < faces.size(); index++) {
      const face = faces.get(index);
      markerContext.strokeRect(face.x, face.y, face.width, face.height);
      (face.points || []).forEach(point => {
        markerContext.beginPath();
        markerContext.arc(point.x, point.y, 2, 0, Math.PI * 2);
        markerContext.fill();
      });
    }
  };

  const startSandbox = async () => {
    const modelBase = chrome.runtime.getURL('vendor/face-api/');
    const readModel = async manifestName => {
      const manifestResponse = await fetch(`${modelBase}${manifestName}`);
      if (!manifestResponse.ok) throw new Error(`No se pudo cargar el modelo facial (${manifestResponse.status}).`);
      const manifests = await manifestResponse.json();
      const specs = manifests[0]?.weights;
      const weightFile = manifests[0]?.paths?.[0];
      if (!Array.isArray(specs) || !weightFile) throw new Error(`El manifiesto ${manifestName} está incompleto.`);
      const weightsResponse = await fetch(`${modelBase}${weightFile}`);
      if (!weightsResponse.ok) throw new Error(`No se pudieron cargar los pesos de ${manifestName} (${weightsResponse.status}).`);
      return { specs, data: await weightsResponse.arrayBuffer() };
    };
    const detectorModel = await readModel('tiny_face_detector_model-weights_manifest.json');
    const landmarkModel = await readModel('face_landmark_68_tiny_model-weights_manifest.json');
    sandbox = document.createElement('iframe');
    sandbox.src = chrome.runtime.getURL('sandbox/vision.html');
    sandbox.style.display = 'none';
    document.documentElement.append(sandbox);
    sandboxReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('El detector facial no terminó de inicializarse en el sandbox.')), 20000);
      const onMessage = event => {
        if (event.source !== sandbox.contentWindow) return;
        if (event.data?.type === 'vision.ready') {
          clearTimeout(timeout);
          window.removeEventListener('message', onMessage);
          resolve();
        } else if (event.data?.type === 'vision.error') {
          clearTimeout(timeout);
          window.removeEventListener('message', onMessage);
          reject(new Error(event.data.error || 'El detector facial no pudo iniciar.'));
        }
      };
      window.addEventListener('message', onMessage);
    });
    sandbox.addEventListener('load', () => {
      sandbox.contentWindow.postMessage({
        type: 'vision.init',
        weightSpecs: detectorModel.specs,
        weightData: detectorModel.data,
        landmarkSpecs: landmarkModel.specs,
        landmarkData: landmarkModel.data
      }, '*', [detectorModel.data, landmarkModel.data]);
    }, { once: true });
    await sandboxReady;
  };

  const detect = async () => {
    if (!running || !video || video.readyState < 2) {
      if (running) timer = setTimeout(detect, DETECTION_INTERVAL_MS);
      return;
    }
    canvas.width = 320;
    canvas.height = Math.round(320 * video.videoHeight / video.videoWidth) || 240;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (sandboxReady) {
      try {
        await sandboxReady;
        const result = await new Promise(resolve => {
          const onMessage = event => {
            if (event.source !== sandbox.contentWindow) return;
            if (event.data?.type === 'vision.error') {
              window.removeEventListener('message', onMessage);
              resolve({ error: event.data.error || 'El detector facial devolvió un error.' });
              return;
            }
            if (event.data?.type !== 'vision.result') return;
            window.removeEventListener('message', onMessage);
            resolve(event.data);
          };
          window.addEventListener('message', onMessage);
          sandbox.contentWindow.postMessage({ type: 'vision.frame', image: context.getImageData(0, 0, canvas.width, canvas.height) }, '*');
          setTimeout(() => {
            window.removeEventListener('message', onMessage);
            resolve({ faces: [] });
          }, 3000);
        });
        if (result.error) throw new Error(result.error);
        notify({ present: result.faces.length > 0, available: true });
        drawFaceMarkers({ size: () => result.faces.length, get: index => result.faces[index] });
        const hands = Array.isArray(result.hands) ? result.hands : (result.hand ? [result.hand] : []);
        if (result.handError) {
          console.warn('[NRVI] Detección de manos:', result.handError);
        }
        const headGesture = result.faces[0]?.headGesture || null;
        if (hands.length) {
          const bothPalms = hands.length === 2 && hands.every(hand => hand.gesture === 'open');
          const handGesture = bothPalms ? 'both_open' : hands[0].gesture;
          updateHandStatus({ points: hands.flatMap(hand => hand.points || []), gesture: handGesture });
          updateGesture(handGesture || headGesture);
          if (landmarksVisible && markerContext) {
            hands.forEach(hand => hand.points.forEach(point => {
              markerContext.beginPath();
              markerContext.arc(point.x, point.y, 2, 0, Math.PI * 2);
              markerContext.fillStyle = '#4ade80';
              markerContext.fill();
            }));
            hands.forEach(hand => {
            markerContext.strokeStyle = hand.gesture === 'open' || hand.gesture === 'victory'
              ? '#4ade80'
              : '#facc15';
            markerContext.lineWidth = 3;
            markerContext.strokeRect(hand.x, hand.y, hand.width, hand.height);
            markerContext.fillStyle = markerContext.strokeStyle;
            markerContext.font = 'bold 14px system-ui';
            markerContext.fillText(
              hand.gesture ? `Mano ${gestureLabel(hand.gesture)}` : 'Mano detectada',
              hand.x + 4,
              Math.max(16, hand.y - 6)
            );
            });
          }
        } else {
          updateHandStatus(null);
          updateGesture(headGesture);
        }
      } catch (error) {
        notify({ present: false, available: false, error: error.message });
      }
    }
    if (running) timer = setTimeout(detect, DETECTION_INTERVAL_MS);
  };

  const detectHand = (cv, source) => {
    const roiHeight = Math.floor(source.rows / 2);
    if (roiHeight < 1) return;
    const roi = source.roi(new cv.Rect(0, roiHeight, source.cols, roiHeight));
    const hsv = new cv.Mat();
    const mask = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let lower;
    let upper;
    try {
      cv.cvtColor(roi, hsv, cv.COLOR_RGBA2HSV);
      lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 30, 50, 0]);
      upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [30, 255, 255, 255]);
      cv.inRange(hsv, lower, upper, mask);
      cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let largest = null;
      let largestArea = 0;
      for (let index = 0; index < contours.size(); index++) {
        const contour = contours.get(index);
        const area = cv.contourArea(contour);
        if (area > largestArea) {
          largest?.delete();
          largestArea = area;
          largest = contour;
        } else {
          contour.delete();
        }
      }
      if (!largest || largestArea < source.cols * source.rows * 0.015) {
        if (largest) largest.delete();
        updateGesture(null);
        return;
      }
      const hull = new cv.Mat();
      cv.convexHull(largest, hull, false, true);
      const hullArea = cv.contourArea(hull);
      const solidity = hullArea ? largestArea / hullArea : 1;
      const gesture = solidity < 0.72 ? 'open' : solidity > 0.82 ? 'fist' : null;
      if (landmarksVisible && markerContext && gesture) {
        const bounds = cv.boundingRect(largest);
        markerContext.strokeStyle = gesture === 'open' ? '#4ade80' : '#facc15';
        markerContext.lineWidth = 3;
        markerContext.strokeRect(bounds.x, bounds.y + roiHeight, bounds.width, bounds.height);
        markerContext.fillStyle = markerContext.strokeStyle;
        markerContext.font = 'bold 14px system-ui';
        markerContext.fillText(gesture === 'open' ? 'Mano abierta' : 'Puño', bounds.x + 4, bounds.y + roiHeight - 6);
      }
      hull.delete();
      largest.delete();
      updateGesture(gesture);
    } finally {
      roi.delete();
      hsv.delete();
      mask.delete();
      contours.delete();
      hierarchy.delete();
      lower?.delete();
      upper?.delete();
    }
  };

  const updateGesture = gesture => {
    const now = Date.now();
    if (!gesture) {
      candidateGesture = null;
      candidateSince = 0;
      return;
    }
    if (candidateGesture !== gesture) {
      candidateGesture = gesture;
      candidateSince = now;
      return;
    }
    const stabilityMs = gesture === 'fist'
      ? FIST_STABILITY_MS
      : gesture === 'victory' ? VICTORY_STABILITY_MS : GESTURE_STABILITY_MS;
    if (now - candidateSince < stabilityMs
      || lastGesture === gesture && now - lastGestureAt < stabilityMs) return;
    lastGesture = gesture;
    lastGestureAt = now;
    notifyHand(gesture);
  };

  const start = async () => {
    if (running || starting) return true;
    starting = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      console.info('[NRVI] Cámara autorizada para visión local.');
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.autoplay = true;
      video.setAttribute('aria-label', 'Vista previa de la cámara de NRVI');
      Object.assign(video.style, {
        display: previewVisible ? 'block' : 'none',
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        width: '240px',
        height: '180px',
        objectFit: 'cover',
        zIndex: '2147483646',
        borderRadius: '12px',
        border: '2px solid #38bdf8',
        boxShadow: '0 8px 24px rgba(0, 0, 0, .35)',
        background: '#0f172a'
      });
      canvas = document.createElement('canvas');
      canvas.style.display = 'none';
      context = canvas.getContext('2d', { willReadFrequently: true });
      markerCanvas = document.createElement('canvas');
      markerCanvas.width = 320;
      markerCanvas.height = 240;
      markerCanvas.style.display = landmarksVisible ? 'block' : 'none';
      markerCanvas.style.pointerEvents = 'none';
      Object.assign(markerCanvas.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        width: '240px',
        height: '180px',
        zIndex: '2147483647',
        borderRadius: '12px'
      });
      markerContext = markerCanvas.getContext('2d');
      resultLabel = document.createElement('div');
      resultLabel.textContent = 'Iniciando visión…';
      Object.assign(resultLabel.style, {
        position: 'fixed',
        right: '24px',
        bottom: '170px',
        zIndex: '2147483647',
        color: '#f8fafc',
        background: 'rgba(15, 23, 42, .82)',
        padding: '4px 8px',
        borderRadius: '6px',
        font: '12px system-ui',
        pointerEvents: 'none'
      });
      resultLabel.style.display = previewVisible ? 'block' : 'none';
      document.documentElement.append(video, canvas, markerCanvas, resultLabel);
      await video.play();
      running = true;
      notify({ present: false, available: false, error: 'Inicializando detector facial…' });
      await startSandbox();
      console.info('[NRVI] Detector facial local listo en sandbox.');
      notify({ present: false, available: true });
      detect();
      const settings = await chrome.storage.local.get({
        cameraPreviewVisible: false,
        cameraLandmarksVisible: false
      });
      setLandmarks(Boolean(settings.cameraLandmarksVisible));
      setPreview(Boolean(settings.cameraPreviewVisible));
      return true;
    } catch (error) {
      console.warn('[NRVI] No se pudo iniciar la detección facial:', error.message);
      if (stream && video) {
        running = true;
        notify({ present: false, available: false, error: error.message });
        return true;
      }
      stop();
      notify({ present: false, available: false, error: error.message });
      return false;
    } finally {
      starting = false;
    }
  };

  window.nrviVision = {
    start,
    stop,
    setPreview,
    setLandmarks,
    getState: () => ({
      running,
      previewVisible,
      landmarksVisible,
      facePresent: lastFacePresent,
      handPresent: lastHandPresent,
      gesture: lastGesture
    }),
    isRunning: () => running
  };

})();
