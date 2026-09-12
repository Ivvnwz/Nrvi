function extraerEstructuraDOM() {
  const elementos = {
    titulos: [],
    botones: [],
    enlaces: [],
    inputs: [],
    descripcion: ''
  };

  const limpiarTexto = (texto) => (texto || '').replace(/\s+/g, ' ').trim();
  const esVisible = (el) => {
    const estilos = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return estilos.display !== 'none' && estilos.visibility !== 'hidden' &&
      rect.width > 0 && rect.height > 0;
  };
  const nombreAccesible = (el) => {
    const ariaLabel = limpiarTexto(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const texto = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.innerText || '')
        .join(' ');
      if (limpiarTexto(texto)) return limpiarTexto(texto);
    }

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && limpiarTexto(label.innerText)) return limpiarTexto(label.innerText);
    }

    const labelPadre = el.closest('label');
    if (labelPadre && limpiarTexto(labelPadre.innerText)) return limpiarTexto(labelPadre.innerText);

    return limpiarTexto(el.innerText || el.value || el.getAttribute('placeholder'));
  };

  document.querySelectorAll('h1, h2, h3').forEach(el => {
    const texto = limpiarTexto(el.innerText);
    if (texto && esVisible(el)) elementos.titulos.push(texto);
  });

  document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]').forEach(el => {
    const etiqueta = nombreAccesible(el);
    if (etiqueta && esVisible(el) && !el.disabled) elementos.botones.push({ etiqueta, elemento: el });
  });

  document.querySelectorAll('a[href]').forEach(el => {
    const etiqueta = nombreAccesible(el);
    if (etiqueta && esVisible(el)) elementos.enlaces.push({ etiqueta, elemento: el });
  });

  document.querySelectorAll('input:not([type="hidden"]), textarea, select').forEach(el => {
    const identificador = nombreAccesible(el) || el.name || el.type || 'campo';
    if (esVisible(el) && !el.disabled) {
      elementos.inputs.push({
        tipo: el.tagName === 'SELECT' ? 'select' : (el.type || el.tagName.toLowerCase()),
        identificador,
        requerido: el.required,
        elemento: el
      });
    }
  });

  const titulo = elementos.titulos[0] || limpiarTexto(document.title);
  const metaDescripcion = document.querySelector('meta[name="description"]')?.content;
  const primerTexto = limpiarTexto(document.querySelector('main p, article p, body p')?.innerText);
  elementos.descripcion = limpiarTexto(metaDescripcion || primerTexto || titulo || 'Página sin descripción disponible');

  return elementos;
}