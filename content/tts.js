function hablarTexto(texto) {
  if (!('speechSynthesis' in window)) {
    console.warn("Este navegador no soporta síntesis de voz.");
    return;
  }
  
  // Cancelar cualquier audio anterior para que no se encime
  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(texto);
  utterance.lang = 'es-ES';
  utterance.rate = 1.0; // Velocidad normal
  window.speechSynthesis.speak(utterance);
}