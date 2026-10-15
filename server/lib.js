export const ALLOWED_ACTIONS = ['click_element', 'focus_field', 'fill_input', 'scroll_page'];

export const DEFAULT_MODEL = 'openai/gpt-oss-20b';

export const cleanModel = raw => {
  const cleaned = String(raw || '').replace(/[`"'\s]/g, '');
  return cleaned || DEFAULT_MODEL;
};

export const safeActions = (toolCalls = []) => {
  const allowed = new Set(ALLOWED_ACTIONS);
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.flatMap(call => {
    const name = call?.function?.name;
    if (!allowed.has(name)) return [];
    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return [];
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
    return [{ type: name, ...args }];
  });
};

export const buildMessages = ({ systemPrompt, history = [], context, question }) => {
  const safeHistory = Array.isArray(history)
    ? history
      .filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
      .slice(-10)
    : [];

  return [
    { role: 'system', content: systemPrompt },
    ...safeHistory,
    { role: 'user', content: `Contexto actual de la página:\n${JSON.stringify(context || {})}\n\nUsuario: ${String(question).trim()}` }
  ];
};

export const fetchWithTimeout = async (url, options = {}, timeoutMs = 20000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};
