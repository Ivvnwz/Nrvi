(() => {
  if (window.__nrviVisionLoaded) return;
  window.__nrviVisionLoaded = true;

  const CASCADE_FILE = 'haarcascade_frontalface_default.xml';
  const DETECTION_INTERVAL_MS = 250;
  let video;
  let canvas;
  let context;
  let classifier;
  let stream;
  let timer;
  let running = false;
  let starting = false;
  let candidateGesture = null;
  let candidateSince = 0;
  let lastGesture = null;
  let lastGestureAt = 0;

  const notify = detail => {
    window.dispatchEvent(new CustomEvent('nrvi:face-presence', { detail }));
    window.nrviVoice?.setFacePresence?.(detail.present, detail.available);
  };

  const notifyHand = gesture => {
    window.dispatchEvent(new CustomEvent('nrvi:hand-gesture', {
      detail: { gesture, stable: Boolean(gesture) }
    }));
    window.nrviVoice?.setHandGesture?.(gesture);
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
    video = null;
    canvas = null;
    context = null;
    classifier = null;
    candidateGesture = null;
    candidateSince = 0;
    lastGesture = null;
    lastGestureAt = 0;
    notify({ present: false, available: true });
  };

  const loadCascade = async cv => {
    const response = await fetch(chrome.runtime.getURL(`vendor/${CASCADE_FILE}`));
    if (!response.ok) throw new Error(`No se pudo cargar ${CASCADE_FILE}.`);
    const data = new Uint8Array(await response.arrayBuffer());
    cv.FS_createDataFile('/', CASCADE_FILE, data, true, false, false);
    classifier = new cv.CascadeClassifier();
    classifier.load(CASCADE_FILE);
  };

  const waitForOpenCv = () => new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      if (window.cv?.CascadeClassifier && window.cv?.FS_createDataFile) {
        resolve(window.cv);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('OpenCV.js no terminó de inicializarse.'));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });

  const detect = cv => {
    if (!running || !video || video.readyState < 2) {
      if (running) timer = setTimeout(() => detect(cv), DETECTION_INTERVAL_MS);
      return;
    }
    canvas.width = 320;
    canvas.height = Math.round(320 * video.videoHeight / video.videoWidth) || 240;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const source = cv.imread(canvas);
    const gray = new cv.Mat();
    const faces = new cv.RectVector();
    try {
      cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
      cv.equalizeHist(gray, gray);
      classifier.detectMultiScale(gray, faces, 1.1, 4, 0);
      notify({ present: faces.size() > 0, available: true });
      detectHand(cv, source);
    } finally {
      source.delete();
      gray.delete();
      faces.delete();
    }
    if (running) timer = setTimeout(() => detect(cv), DETECTION_INTERVAL_MS);
  };

  const detectHand = (cv, source) => {
    const roiHeight = Math.floor(source.rows / 2);
    if (roiHeight < 1) return;
    const roi = source.roi(new cv.Rect(0, roiHeight, source.cols, roiHeight));
    const hsv = new cv.Mat();
    const mask = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 30, 50, 0]);
    const upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [30, 255, 255, 255]);
    try {
      cv.cvtColor(roi, hsv, cv.COLOR_RGBA2HSV);
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
      hull.delete();
      largest.delete();
      updateGesture(gesture);
    } finally {
      roi.delete();
      hsv.delete();
      mask.delete();
      contours.delete();
      hierarchy.delete();
      lower.delete();
      upper.delete();
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
    if (now - candidateSince < 2000 || lastGesture === gesture && now - lastGestureAt < 2000) return;
    lastGesture = gesture;
    lastGestureAt = now;
    notifyHand(gesture);
  };

  const start = async () => {
    if (running || starting) return true;
    starting = true;
    try {
      const cv = await waitForOpenCv();
      await loadCascade(cv);
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.style.display = 'none';
      canvas = document.createElement('canvas');
      canvas.style.display = 'none';
      context = canvas.getContext('2d', { willReadFrequently: true });
      document.documentElement.append(video, canvas);
      await video.play();
      running = true;
      notify({ present: false, available: true });
      detect(cv);
      return true;
    } catch (error) {
      console.warn('[NRVI] No se pudo iniciar la detección facial:', error.message);
      stop();
      notify({ present: false, available: false, error: error.message });
      return false;
    } finally {
      starting = false;
    }
  };

  window.nrviVision = { start, stop };
})();
