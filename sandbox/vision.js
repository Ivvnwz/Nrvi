(() => {
  let cvReady;
  let handsReady;
  let handResults = [];
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
        hands.setOptions({ maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.55, minTrackingConfidence: 0.5 });
        hands.onResults(results => {
          handResults = results.multiHandLandmarks || [];
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
    const fingerTips = [8, 12, 16, 20];
    const fingerPips = [6, 10, 14, 18];
    const extended = fingerTips.map((tip, index) => (
      points[tip].y < points[fingerPips[index]].y
    ));
    const foldedCount = extended.filter(value => !value).length;
    const thumbUp = points[4].y < points[3].y;
    const thumbDown = points[4].y > points[3].y;
    let gesture = null;
    if (extended.every(Boolean)) gesture = 'open';
    else if (foldedCount === 4 && thumbUp) gesture = 'thumbs_up';
    else if (foldedCount === 4 && thumbDown) gesture = 'thumbs_down';
    else if (extended[0] && extended[1] && !extended[2] && !extended[3]) gesture = 'victory';
    else if (foldedCount === 4) gesture = 'fist';
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
      handResults = [];
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
        hands: handResults
          .map(landmarks => detectHand(landmarks, message.image.width, message.image.height))
          .filter(Boolean)
      }, '*');
    } catch (error) {
      event.source.postMessage({ type: 'vision.error', error: error.message }, '*');
    }
  });
})();
