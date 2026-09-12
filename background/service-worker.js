chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "procesar_pagina") {
    
    // 1. Obtener las claves de API guardadas
    chrome.storage.local.get(['llmKey', 'elevenKey'], async (keys) => {
      if (!keys.llmKey || !keys.elevenKey) {
        sendResponse({ exito: false, error: "Faltan claves de API en la configuración." });
        return;
      }

      try {
        // Aquí irá la lógica real de Fetch hacia Grok/Gemini usando request.domData
        console.log("Datos recibidos del DOM:", request.domData);
        const textoResumido = "Resumen simulado: Estás en una página con un formulario.";
        
        // Aquí irá la lógica real de Fetch hacia ElevenLabs usando el textoResumido
        console.log("Generando audio para:", textoResumido);
        const audioBase64Simulado = ""; // Reemplazar con el base64 real de ElevenLabs

        sendResponse({ exito: true, texto: textoResumido, audio: audioBase64Simulado });
      } catch (error) {
        sendResponse({ exito: false, error: error.message });
      }
    });

    return true; // Obligatorio para respuestas asíncronas (async/await)
  }
});