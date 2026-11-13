(() => {
  let cvReady;
  let handsReady;
  let handDetectionError = null;
  let resolveHandFrame = null;
  const frameCanvas = document.createElement('canvas');
  const frameContext = frameCanvas.getContext('2d', { willReadFrequently: true });

  const load = async message => {
    if (!window.faceapi?.nets?.tinyFaceDetector) {
      throw new Error('El detector facial local no está disponible.');
    }
    await window.faceapi.tf.ready();
    const weightMap = window.faceapi.tf.io.decodeWeights(message.weightData, message.weightSpecs);
    await window.faceapi.nets.tinyFaceDetector.loadFromWeightMap(weightMap);
    const landmarkMap = window.faceapi.tf.io.decodeWeights(message.landmarkData, message.landmarkSpecs);
    await window.faceapi.nets.faceLandmark68TinyNet.loadFromWeightMap(landmarkMap);
    if (window.Hands) {
      try {
        const hands = new window.Hands({
          locateFile: file => new URL(`../vendor/mediapipe-hands/${file}`, window.location.href).href
        });
        hands.setOptions({
          maxNumHands: 2,
          modelComplexity: 1,
          minDetectionConfidence: 0.3,
          minTrackingConfidence: 0.3,
          selfieMode: false
        });
        hands.onResults(results => {
          const handResults = Array.isArray(results.multiHandLandmarks)
            ? results.multiHandLandmarks
            : [];
          handDetectionError = null;
          resolveHandFrame?.(handResults);
          resolveHandFrame = null;
        });
        await hands.initialize();
        handsReady = hands;
      } catch (error) {
        handDetectionError = error.message;
        console.warn('[NRVI] Manos no disponibles:', error.message);
        handsReady = null;
      }
    } else {
      handDetectionError = 'MediaPipe Hands no está disponible en el sandbox.';
    }
  };

  const detectHand = (landmarks, width, height) => {
    if (!landmarks) return null;
    const points = landmarks.map(point => ({ x: point.x * width, y: point.y * height }));
    const fingerTips = [8, 12, 16, 20];
    const fingerPips = [6, 10, 14, 18];
    const extended = fingerTips.map((tip, index) => (
      points[tip].y < points[fingerPips[index]].y
    ));
    const foldedCount = extended.filter(value => !value).length;
    const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);
    const thumbExtended = distance(points[4], points[0]) > distance(points[3], points[0]) * 1.12;
    const thumbUp = thumbExtended && points[4].y < points[3].y;
    const thumbDown = thumbExtended && points[4].y > points[3].y;
    let gesture = null;
    if (extended.every(Boolean)) gesture = 'open';
    else if (foldedCount === 4 && thumbUp) gesture = 'thumbs_up';
    else if (foldedCount === 4 && thumbDown) gesture = 'thumbs_down';
    else if (extended[0] && extended[1] && !extended[2] && !extended[3]) gesture = 'victory';
    else if (foldedCount === 4) gesture = 'fist';
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    return {
      points,
      gesture,
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    };
  };

  const detectHeadGesture = points => {
    if (!Array.isArray(points) || points.length < 48) return null;
    const leftEye = points.slice(36, 42);
    const rightEye = points.slice(42, 48);
    const nose = points[30];
    if (!nose || !leftEye.length || !rightEye.length) return null;
    const eyeCenter = [...leftEye, ...rightEye].reduce((sum, point) => sum + point.x, 0)
      / (leftEye.length + rightEye.length);
    const faceWidth = Math.abs(rightEye.reduce((sum, point) => sum + point.x, 0) / rightEye.length
      - leftEye.reduce((sum, point) => sum + point.x, 0) / leftEye.length);
    if (!faceWidth) return null;
    const offset = (nose.x - eyeCenter) / faceWidth;
    // The camera preview is mirrored, so screen-side offsets are opposite to
    // the user's physical head direction.
    if (offset < -0.18) return 'head_right';
    if (offset > 0.18) return 'head_left';
    return null;
  };

  const detectSmile = points => {
    if (!Array.isArray(points) || points.length < 68) return false;
    const faceWidth = Math.abs(points[16].x - points[0].x);
    const mouthWidth = Math.abs(points[54].x - points[48].x);
    const mouthCenterY = (points[51].y + points[57].y) / 2;
    const cornersAboveCenter = points[48].y < mouthCenterY && points[54].y < mouthCenterY;
    return faceWidth > 0 && mouthWidth / faceWidth > 0.3 && cornersAboveCenter;
  };

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'vision.init') return;
    cvReady = load(message).then(() => {
      event.source.postMessage({ type: 'vision.ready' }, '*');
    }).catch(error => {
      event.source.postMessage({ type: 'vision.error', error: error.message }, '*');
    });
  });

  window.addEventListener('message', async event => {
    const message = event.data;
    if (!message || message.type !== 'vision.frame' || !cvReady) return;
    try {
      await cvReady;
      const options = new window.faceapi.TinyFaceDetectorOptions({
        inputSize: 320,
        scoreThreshold: 0.2
      });
      frameCanvas.width = message.image.width;
      frameCanvas.height = message.image.height;
      frameContext.putImageData(message.image, 0, 0);
      const detections = await window.faceapi.detectAllFaces(frameCanvas, options)
        .withFaceLandmarks(true);
      let handResults = [];
      if (handsReady) {
        try {
          const handFrame = new Promise(resolve => {
            resolveHandFrame = resolve;
          });
          await handsReady.send({ image: frameCanvas });
          handResults = await Promise.race([
            handFrame,
            new Promise(resolve => setTimeout(() => resolve([]), 1000))
          ]);
          resolveHandFrame = null;
        } catch (error) {
          handDetectionError = error.message;
          console.warn('[NRVI] No se pudo procesar la mano:', error.message);
          resolveHandFrame = null;
        }
      }
      const result = detections.map(detection => {
        const box = detection.detection?.box || detection.box;
        const positions = detection.landmarks?.positions || [];
        return {
          x: Number(box?.x) || 0,
          y: Number(box?.y) || 0,
          width: Number(box?.width) || 0,
          height: Number(box?.height) || 0,
          points: positions
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            .map(point => ({ x: point.x, y: point.y })),
          headGesture: detectHeadGesture(positions),
          smiling: detectSmile(positions)
        };
      }).filter(face => face.width > 0 && face.height > 0);
      event.source.postMessage({
        type: 'vision.result',
        faces: result,
        hands: handResults
          .map(landmarks => detectHand(landmarks, message.image.width, message.image.height))
          .filter(Boolean),
        handError: handDetectionError
      }, '*');
    } catch (error) {
      event.source.postMessage({ type: 'vision.error', error: error.message }, '*');
    }
  });
})();
