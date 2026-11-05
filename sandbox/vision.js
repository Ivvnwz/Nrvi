(() => {
  let cvReady;
  let handsReady;
  let handResult;
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
        hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.55, minTrackingConfidence: 0.5 });
        hands.onResults(results => {
          handResult = results.multiHandLandmarks?.[0] || null;
        });
        handsReady = hands;
      } catch (error) {
        console.warn('[NRVI] Manos no disponibles:', error.message);
        handsReady = null;
      }
    }
  };

  const detectHand = (landmarks, width, height) => {
    if (!landmarks) return null;
    const points = landmarks.map(point => ({ x: point.x * width, y: point.y * height }));
    const tips = [8, 12, 16, 20];
    const pips = [6, 10, 14, 18];
    const extended = tips.reduce((count, tip, index) => (
      count + Number(points[tip].y < points[pips[index]].y)
    ), 0);
    const gesture = extended === 4 ? 'open' : extended === 0 ? 'fist' : null;
    if (!gesture) return { points, gesture: null };
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
      handResult = null;
      if (handsReady) {
        try {
          await handsReady.send({ image: frameCanvas });
        } catch (error) {
          console.warn('[NRVI] No se pudo procesar la mano:', error.message);
          handsReady = null;
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
            .map(point => ({ x: point.x, y: point.y }))
        };
      }).filter(face => face.width > 0 && face.height > 0);
      event.source.postMessage({
        type: 'vision.result',
        faces: result,
        hand: detectHand(handResult, message.image.width, message.image.height)
      }, '*');
    } catch (error) {
      event.source.postMessage({ type: 'vision.error', error: error.message }, '*');
    }
  });
})();
