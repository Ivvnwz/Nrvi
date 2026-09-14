import 'dotenv/config';
import cors from 'cors';
import express from 'express';

const app = express();
const port = Number(process.env.PORT || 3000);
const tools = [
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: 'Activa un botón o enlace visible. No uses esta herramienta para acciones irreversibles sin confirmación.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'focus_field',
      description: 'Enfoca un campo visible.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fill_input',
      description: 'Escribe texto en un campo visible, sin enviar formularios.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll_page',
      description: 'Desplaza la página hacia arriba o abajo.',
      parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'], additionalProperties: false }
    }
  }
];

app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

const systemPrompt = `Eres NRVI, una asistente amigable, empática y conversacional para una persona con discapacidad visual.
Responde siempre en español y de forma clara, natural y breve. Entiende la página actual usando el contexto semántico.
Puedes resumir, conversar y guiar. Solo usa herramientas con IDs presentes en el contexto.
No inventes controles. Para comprar, borrar, enviar formularios o acciones irreversibles, explica lo que ocurrirá y pide confirmación antes de actuar.`;

async function chat(messages, useTools = true) {
 
  const rawModel = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const cleanModel = rawModel.replace(/[`"'\s]/g, '');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      Authorization: `Bearer ${process.env.GROQ_API_KEY?.trim()}` 
    },
    body: JSON.stringify({
      model: cleanModel,
      temperature: 0.25,
      messages,
      ...(useTools ? { tools, tool_choice: 'auto' } : {})
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Groq rechazó la solicitud.');
  return data.choices?.[0]?.message || {};
}

function safeActions(toolCalls = []) {
  const allowed = new Set(['click_element', 'focus_field', 'fill_input', 'scroll_page']);
  return toolCalls.flatMap(call => {
    if (!allowed.has(call.function?.name)) return [];
    try {
      return [{ type: call.function.name, ...JSON.parse(call.function.arguments || '{}') }];
    } catch {
      return [];
    }
  });
}

async function elevenLabs(text) {
  if (!process.env.ELEVENLABS_API_KEY || !text) return null;
  const voice = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY, Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' })
  });
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer()).toString('base64');
}

app.get('/health', (_request, response) => response.json({ ok: true, groq: Boolean(process.env.GROQ_API_KEY), elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY) }));

app.post('/api/agent', async (request, response) => {
  const { question, context, history = [], audio = true } = request.body || {};
  if (!process.env.GROQ_API_KEY) return response.status(503).json({ error: 'Configura GROQ_API_KEY en server/.env.' });
  if (!question?.trim()) return response.status(400).json({ error: 'La pregunta está vacía.' });

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10),
      { role: 'user', content: `Contexto actual de la página:\n${JSON.stringify(context || {})}\n\nUsuario: ${question.trim()}` }
    ];
    const first = await chat(messages);
    let actions = [];
    let final = first;
    if (first.tool_calls?.length) {
      actions = safeActions(first.tool_calls);
      messages.push(first);
      first.tool_calls.forEach(call => messages.push({ role: 'tool', tool_call_id: call.id, content: 'Acción preparada para ejecutarse en la página.' }));
      final = await chat(messages, false);
    }
    const text = final.content?.trim() || 'He preparado la acción solicitada.';
    const audioBase64 = audio ? await elevenLabs(text) : null;
    response.json({ text, actions, audio: audioBase64, audioMimeType: audioBase64 ? 'audio/mpeg' : null });
  } catch (error) {
    response.status(502).json({ error: error.message || 'Error del agente.' });
  }
});

app.listen(port, () => console.log(`NRVI backend: http://localhost:${port}`));
