import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { cleanModel, safeActions, buildMessages, fetchWithTimeout, DEFAULT_MODEL } from './lib.js';
import { safeLogValue, writeLog } from './logger.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const groqTimeout = Number(process.env.GROQ_TIMEOUT_MS || 20000);
const groqSttTimeout = Number(process.env.GROQ_STT_TIMEOUT_MS || 30000);
const elevenTimeout = Number(process.env.ELEVENLABS_TIMEOUT_MS || 15000);
const sttModel = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 }
});

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

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins?.length ? allowedOrigins : true }));
app.use(express.json({ limit: '2mb' }));

const systemPrompt = `Eres NRVI, una asistente amigable, empática y conversacional para una persona con discapacidad visual.
Responde siempre en español y de forma clara, natural y breve. Entiende la página actual usando el contexto semántico.
Puedes resumir, conversar y guiar. Solo usa herramientas con IDs presentes en el contexto.
No inventes controles. Para comprar, borrar, enviar formularios o acciones irreversibles, explica lo que ocurrirá y pide confirmación antes de actuar.`;

async function chat(messages, useTools = true) {
  const model = cleanModel(process.env.GROQ_MODEL || DEFAULT_MODEL);
  await writeLog('info', 'provider.request', {
    provider: 'groq',
    model,
    useTools,
    messageCount: messages.length
  });

  let response;
  try {
    response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY?.trim()}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        messages,
        ...(useTools ? { tools, tool_choice: 'auto' } : {})
      })
    }, groqTimeout);
  } catch (error) {
    await writeLog('error', 'provider.error', {
      provider: 'groq',
      error: error.message
    });
    throw new Error(error.name === 'AbortError' ? 'Groq tardó demasiado en responder.' : 'No se pudo contactar con Groq.');
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const errorMessage = data.error?.message || 'Groq rechazó la solicitud.';
    await writeLog('error', 'provider.response_error', {
      provider: 'groq',
      status: response.status,
      error: errorMessage
    });
    throw new Error(errorMessage);
  }
  await writeLog('info', 'provider.response', {
    provider: 'groq',
    status: response.status,
    hasToolCalls: Boolean(data.choices?.[0]?.message?.tool_calls),
    responseLength: safeLogValue(data.choices?.[0]?.message?.content || '').length
  });
  return data.choices?.[0]?.message || {};
}

async function elevenLabs(text) {
  if (!process.env.ELEVENLABS_API_KEY || !text) {
    await writeLog('info', 'provider.skipped', {
      provider: 'elevenlabs',
      reason: !text ? 'empty_text' : 'api_key_not_configured'
    });
    return null;
  }
  const voice = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  await writeLog('info', 'provider.request', {
    provider: 'elevenlabs',
    voice,
    textLength: text.length
  });
  try {
    const response = await fetchWithTimeout(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY, Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' })
    }, elevenTimeout);
    if (!response.ok) {
      await writeLog(response.status === 402 ? 'warn' : 'error', 'provider.response_error', {
        provider: 'elevenlabs',
        status: response.status,
        error: response.status === 402 ? 'Cuota o saldo de ElevenLabs agotado; se usará la voz del navegador.' : undefined
      });
      return null;
    }
    const audio = Buffer.from(await response.arrayBuffer()).toString('base64');
    await writeLog('info', 'provider.response', {
      provider: 'elevenlabs',
      status: response.status,
      audioLength: audio.length
    });
    return audio;
  } catch (error) {
    await writeLog('error', 'provider.error', {
      provider: 'elevenlabs',
      error: error.message
    });
    return null;
  }
}

app.get('/health', (_request, response) => {
  const result = {
    ok: true,
    groq: Boolean(process.env.GROQ_API_KEY),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY)
  };
  void writeLog('info', 'health.response', result);
  response.json(result);
});

app.post('/api/transcribe', upload.single('file'), async (request, response) => {
  if (!process.env.GROQ_API_KEY) {
    const error = 'Configura GROQ_API_KEY en server/.env.';
    void writeLog('error', 'transcription.response_error', { status: 503, error });
    return response.status(503).json({ error });
  }
  if (!request.file?.buffer?.length) {
    const error = 'No se recibió audio para transcribir.';
    void writeLog('error', 'transcription.response_error', { status: 400, error });
    return response.status(400).json({ error });
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  void writeLog('info', 'transcription.request', {
    requestId,
    provider: 'groq',
    model: sttModel,
    mimeType: request.file.mimetype,
    audioBytes: request.file.size
  });

  try {
    const form = new FormData();
    form.append('file', new Blob([request.file.buffer], { type: request.file.mimetype }), request.file.originalname || 'nrvi.webm');
    form.append('model', sttModel);
    form.append('language', 'es');
    form.append('response_format', 'json');
    const providerResponse = await fetchWithTimeout('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form
    }, groqSttTimeout);

    let data = {};
    try {
      data = await providerResponse.json();
    } catch {
      data = {};
    }
    if (!providerResponse.ok) {
      const error = data.error?.message || 'Groq rechazó la transcripción.';
      await writeLog('error', 'transcription.provider_error', {
        requestId,
        provider: 'groq',
        status: providerResponse.status,
        error
      });
      return response.status(502).json({ error });
    }

    const text = typeof data.text === 'string' ? data.text.trim() : '';
    await writeLog('info', 'transcription.response', {
      requestId,
      provider: 'groq',
      status: providerResponse.status,
      response: safeLogValue(text)
    });
    return response.json({ text });
  } catch (error) {
    await writeLog('error', 'transcription.error', { requestId, error: error.message });
    return response.status(502).json({
      error: error.name === 'AbortError' ? 'La transcripción tardó demasiado.' : 'No se pudo transcribir el audio.'
    });
  }
});

app.post('/api/agent', async (request, response) => {
  const body = request.body || {};
  const { question, context, history = [], audio = true } = body;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  void writeLog('info', 'agent.request', {
    requestId,
    question: safeLogValue(question || ''),
    contextLength: safeLogValue(context || {}).length,
    historyCount: Array.isArray(history) ? history.length : 0,
    audioRequested: audio !== false
  });

  if (!process.env.GROQ_API_KEY) {
    const error = 'Configura GROQ_API_KEY en server/.env.';
    void writeLog('error', 'agent.response_error', { requestId, status: 503, error });
    return response.status(503).json({ error });
  }
  if (typeof question !== 'string' || !question.trim()) {
    const error = 'La pregunta está vacía.';
    void writeLog('error', 'agent.response_error', { requestId, status: 400, error });
    return response.status(400).json({ error });
  }

  try {
    const messages = buildMessages({ systemPrompt, history, context, question });
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
    void writeLog('info', 'agent.response', {
      requestId,
      status: 200,
      response: safeLogValue(text),
      actionCount: actions.length,
      audioIncluded: Boolean(audioBase64)
    });
    response.json({ text, actions, audio: audioBase64, audioMimeType: audioBase64 ? 'audio/mpeg' : null });
  } catch (error) {
    console.error('NRVI agent error:', error.message);
    void writeLog('error', 'agent.response_error', {
      requestId,
      status: 502,
      error: error.message
    });
    response.status(502).json({ error: error.message || 'Error del agente.' });
  }
});

app.listen(port, () => console.log(`NRVI backend: http://localhost:${port}`));
