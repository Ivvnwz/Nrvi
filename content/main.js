window.addEventListener('load', () => {
  console.log("VoiceNav: Analizando página y preparando comandos...");
  
  const datos = extraerEstructuraDOM();
  let resumen = `Página cargada. Sección principal: ${datos.titulos[0] || 'Inicio'}. Encontré ${datos.botones.length} botones disponibles. Di el nombre del botón que deseas presionar, como Aspirantes, Estudiantes o Docentes.`;
  
  hablarTexto(resumen);

  // Iniciar la escucha de comandos de voz
  iniciarEscuchaVoz((comando) => {
    // Buscar si el usuario dijo el nombre de algún botón extraído
    let botonEncontrado = null;
    
    document.querySelectorAll('button, a').forEach(el => {
      const textoBoton = (el.getAttribute('aria-label') || el.innerText).trim().toLowerCase();
      if (textoBoton.includes(comando)) {
        botonEncontrado = el;
      }
    });

    if (botonEncontrado) {
      hablarTexto(`Seleccionando ${botonEncontrado.innerText}`);
      botonEncontrado.focus();
      botonEncontrado.click(); // Simula el clic en el botón de la sección (ej. Estudiantes)
    } else {
      hablarTexto(`No encontré ningún elemento que coincida con ${comando}`);
    }
  });
});