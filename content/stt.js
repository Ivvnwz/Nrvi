function iniciarEscuchaVoz(onComandoDetectado) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  
  if (!SpeechRecognition) {
    console.warn("Este navegador no soporta reconocimiento de voz.");
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const textoTranscrito = event.results[event.results.length - 1][0].transcript.trim().toLowerCase();
    console.log("Comando de voz recibido:", textoTranscrito);
    onComandoDetectado(textoTranscrito);
  };

  recognition.onerror = (event) => {
    console.error("Error en reconocimiento de voz:", event.error);
  };

  recognition.onend = () => {
    // Reiniciar automáticamente si se detiene para mantener la escucha activa
    try {
      recognition.start();
    } catch (e) {
      // Ignorar si ya está iniciado
    }
  };

  recognition.start();
  console.log("VoiceNav: Micrófono activo a la escucha...");
}