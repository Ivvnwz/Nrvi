import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { cleanModel, safeActions, buildMessages, fetchWithTimeout, DEFAULT_MODEL } from './lib.js';
import { endLogSession, safeLogValue, writeConversationLog, writeLog } from './logger.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const groqTimeout = Number(process.env.GROQ_TIMEOUT_MS || 20000);
const groqSttTimeout = Number(process.env.GROQ_STT_TIMEOUT_MS || 30000);
const deepgramTimeout = Number(process.env.DEEPGRAM_STT_TIMEOUT_MS || 30000);
const elevenTimeout = Number(process.env.ELEVENLABS_TIMEOUT_MS || 15000);
const sttModel = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const deepgramModel = process.env.DEEPGRAM_STT_MODEL || 'nova-3';
const maxCompletionTokens = Number(process.env.GROQ_MAX_COMPLETION_TOKENS || 700);
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
Responde siempre en español y de forma clara, natural y breve. No uses emojis ni emoticonos. Entiende la página actual usando el contexto semántico.
Puedes resumir, conversar y guiar. Solo usa herramientas con IDs presentes en el contexto.
No inventes controles. Para comprar, borrar, enviar formularios o acciones irreversibles, explica lo que ocurrirá y pide confirmación antes de actuar.`;

async function chat(messages, useTools = true, sessionId) {
  const model = cleanModel(process.env.GROQ_MODEL || DEFAULT_MODEL);
  await writeLog('info', 'provider.request', {
    provider: 'groq',
    sessionId,
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
        max_completion_tokens: maxCompletionTokens,
        messages,
        ...(useTools ? { tools, tool_choice: 'auto' } : {})
      })
    }, groqTimeout);
  } catch (error) {
    await writeLog('error', 'provider.error', {
      provider: 'groq',
      sessionId,
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
      sessionId,
      status: response.status,
      error: errorMessage
    });
    throw new Error(errorMessage);
  }
  await writeLog('info', 'provider.response', {
    provider: 'groq',
    sessionId,
    status: response.status,
    hasToolCalls: Boolean(data.choices?.[0]?.message?.tool_calls),
    responseLength: safeLogValue(data.choices?.[0]?.message?.content || '').length
  });
  return data.choices?.[0]?.message || {};
}

async function elevenLabs(text, sessionId) {
  if (!process.env.ELEVENLABS_API_KEY || !text) {
    await writeLog('info', 'provider.skipped', {
      provider: 'elevenlabs',
      sessionId,
      reason: !text ? 'empty_text' : 'api_key_not_configured'
    });
    return null;
  }
  const voice = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
  await writeLog('info', 'provider.request', {
    provider: 'elevenlabs',
    sessionId,
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
        sessionId,
        status: response.status,
        error: response.status === 402 ? 'Cuota o saldo de ElevenLabs agotado; se usará la voz del navegador.' : undefined
      });
      return null;
    }
    const audio = Buffer.from(await response.arrayBuffer()).toString('base64');
    await writeLog('info', 'provider.response', {
      provider: 'elevenlabs',
      sessionId,
      status: response.status,
      audioLength: audio.length
    });
    return audio;
  } catch (error) {
    await writeLog('error', 'provider.error', {
      provider: 'elevenlabs',
      sessionId,
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

const transcribeWithDeepgram = async file => {
  const params = new URLSearchParams({
    model: deepgramModel,
    language: 'es',
    smart_format: 'true',
    punctuate: 'true'
  });
  const providerResponse = await fetchWithTimeout(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      'Content-Type': file.mimetype || 'audio/webm'
    },
    body: file.buffer
  }, deepgramTimeout);
  const data = await providerResponse.json().catch(() => ({}));
  if (!providerResponse.ok) {
    const error = new Error(data.err_msg || data.message || 'Deepgram rechazó la transcripción.');
    error.status = providerResponse.status;
    throw error;
  }
  return {
    status: providerResponse.status,
    text: data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || ''
  };
};

app.post('/api/transcribe', upload.single('file'), async (request, response) => {
  const sessionId = request.get('X-NRVI-Session') || undefined;
  if (!process.env.DEEPGRAM_API_KEY && !process.env.GROQ_API_KEY) {
    const error = 'Configura DEEPGRAM_API_KEY o GROQ_API_KEY en server/.env.';
    void writeLog('error', 'transcription.response_error', { sessionId, status: 503, error });
    return response.status(503).json({ error });
  }
  if (!request.file?.buffer?.length) {
    const error = 'No se recibió audio para transcribir.';
    void writeLog('error', 'transcription.response_error', { sessionId, status: 400, error });
    return response.status(400).json({ error });
  }
  if (request.file.size < 1024) {
    const error = 'El audio recibido es demasiado corto para transcribirlo.';
    void writeLog('warn', 'transcription.discarded', {
      sessionId,
      audioBytes: request.file.size,
      error
    });
    return response.status(400).json({ error });
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (process.env.DEEPGRAM_API_KEY) {
    void writeLog('info', 'transcription.request', {
      requestId,
      sessionId,
      provider: 'deepgram',
      model: deepgramModel,
      mimeType: request.file.mimetype,
      audioBytes: request.file.size
    });
    try {
      const result = await transcribeWithDeepgram(request.file);
      await writeLog('info', 'transcription.response', {
        requestId,
        sessionId,
        provider: 'deepgram',
        status: result.status,
        response: safeLogValue(result.text)
      });
      return response.json({ text: result.text });
    } catch (error) {
      await writeLog('error', 'transcription.provider_error', {
        requestId,
        sessionId,
        provider: 'deepgram',
        status: error.status || 502,
        error: error.message,
        fallback: Boolean(process.env.GROQ_API_KEY)
      });
      if (!process.env.GROQ_API_KEY) {
        return response.status(502).json({ error: 'No se pudo transcribir el audio con Deepgram.' });
      }
    }
  }

  void writeLog('info', 'transcription.request', {
    requestId,
    sessionId,
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
        sessionId,
        provider: 'groq',
        status: providerResponse.status,
        error
      });
      return response.status(502).json({ error });
    }

    const text = typeof data.text === 'string' ? data.text.trim() : '';
    await writeLog('info', 'transcription.response', {
      requestId,
      sessionId,
      provider: 'groq',
      status: providerResponse.status,
      response: safeLogValue(text)
    });
    return response.json({ text });
  } catch (error) {
    await writeLog('error', 'transcription.error', { requestId, sessionId, error: error.message });
    return response.status(502).json({
      error: error.name === 'AbortError' ? 'La transcripción tardó demasiado.' : 'No se pudo transcribir el audio.'
    });
  }
});

app.post('/api/session/end', async (request, response) => {
  const sessionId = request.body?.sessionId;
  await endLogSession(sessionId);
  response.json({ ok: true });
});

app.post('/api/agent', async (request, response) => {
  const body = request.body || {};
  const { question, context, history = [], audio = true } = body;
  const sessionId = body.sessionId;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  void writeLog('info', 'agent.request', {
    requestId,
    sessionId,
    question: safeLogValue(question || ''),
    contextLength: safeLogValue(context || {}).length,
    historyCount: Array.isArray(history) ? history.length : 0,
    audioRequested: audio !== false
  });
  void writeConversationLog('conversation.request', {
    sessionId,
    requestId,
    question: safeLogValue(question || '')
  });

  if (!process.env.GROQ_API_KEY) {
    const error = 'Configura GROQ_API_KEY en server/.env.';
    void writeLog('error', 'agent.response_error', { requestId, sessionId, status: 503, error });
    return response.status(503).json({ error });
  }
  if (typeof question !== 'string' || !question.trim()) {
    const error = 'La pregunta está vacía.';
    void writeLog('error', 'agent.response_error', { requestId, sessionId, status: 400, error });
    return response.status(400).json({ error });
  }

  try {
    const messages = buildMessages({ systemPrompt, history, context, question });
    const first = await chat(messages, true, sessionId);
    let actions = [];
    let final = first;

    if (first.tool_calls?.length) {
      actions = safeActions(first.tool_calls);
      messages.push(first);
      first.tool_calls.forEach(call => messages.push({ role: 'tool', tool_call_id: call.id, content: 'Acción preparada para ejecutarse en la página.' }));
      final = await chat(messages, false, sessionId);
    }

    const text = final.content?.trim() || 'He preparado la acción solicitada.';
    const audioBase64 = audio ? await elevenLabs(text, sessionId) : null;
    void writeLog('info', 'agent.response', {
      requestId,
      sessionId,
      status: 200,
      response: safeLogValue(text),
      actionCount: actions.length,
      audioIncluded: Boolean(audioBase64)
    });
    void writeConversationLog('conversation.response', {
      sessionId,
      requestId,
      response: safeLogValue(text)
    });
    response.json({ text, actions, audio: audioBase64, audioMimeType: audioBase64 ? 'audio/mpeg' : null });
  } catch (error) {
    console.error('NRVI agent error:', error.message);
    const isRateLimit = /rate limit|too many requests|TPM/i.test(error.message || '');
    const status = isRateLimit ? 429 : 502;
    const publicError = isRateLimit
      ? 'Groq alcanzó temporalmente el límite de uso. Espera unos segundos antes de volver a preguntar.'
      : error.message || 'Error del agente.';
    void writeLog('error', 'agent.response_error', {
      requestId,
      sessionId,
      status,
      error: error.message
    });
    response.status(status).json({ error: publicError });
  }
});

app.listen(port, () => console.log(`NRVI backend: http://localhost:${port}`));
