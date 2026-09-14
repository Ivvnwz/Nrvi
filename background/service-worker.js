const DEFAULT_BACKEND = 'http://localhost:3000';

async function getBackendUrl() {
  const { backendUrl } = await chrome.storage.local.get('backendUrl');
  return (backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'agent.request') return false;

  (async () => {
    try {
      const response = await fetch(`${await getBackendUrl()}/api/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: message.question,
          context: message.context,
          history: message.history || [],
          audio: message.audio !== false
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'El backend no pudo responder.');
      sendResponse({ ok: true, ...data });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-listening') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'voice.toggle' });
});
