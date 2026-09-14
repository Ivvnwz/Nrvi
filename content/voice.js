(() => {
  const speak = text => {
    if (!text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  };
  const recognitionType = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition;
  let active = false;

  window.nrviVoice = {
    speak,
    toggle() {
      if (!recognitionType) {
        speak('Este navegador no permite reconocimiento de voz. Puedes usar el cuadro de texto del panel.');
        return;
      }
      if (active) {
        recognition.stop();
        return;
      }
      recognition = new recognitionType();
      recognition.lang = 'es-ES';
      recognition.interimResults = false;
      recognition.onstart = () => { active = true; speak('Te escucho.'); };
      recognition.onend = () => { active = false; };
      recognition.onerror = () => { active = false; speak('No pude escuchar el comando.'); };
      recognition.onresult = event => {
        const question = event.results[0]?.[0]?.transcript?.trim();
        if (question) window.nrviAsk?.(question);
      };
      recognition.start();
    }
  };
})();
