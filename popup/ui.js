document.addEventListener('DOMContentLoaded', () => {
  // Cargar claves guardadas previamente
  chrome.storage.local.get(['llmKey', 'elevenKey'], (result) => {
    if (result.llmKey) document.getElementById('llmKey').value = result.llmKey;
    if (result.elevenKey) document.getElementById('elevenKey').value = result.elevenKey;
  });

  // Guardar nuevas claves
  document.getElementById('saveBtn').addEventListener('click', () => {
    const llmKey = document.getElementById('llmKey').value;
    const elevenKey = document.getElementById('elevenKey').value;

    chrome.storage.local.set({ llmKey, elevenKey }, () => {
      const status = document.getElementById('status');
      status.style.display = 'block';
      setTimeout(() => status.style.display = 'none', 2000);
    });
  });
});