# NRVI

NRVI es un agente conversacional para navegar páginas web con apoyo de voz. La extensión observa la página actual, crea un contexto semántico pequeño y permite conversar con un backend que puede responder y proponer acciones.

## Arquitectura

- `content/`: contexto semántico, reconocimiento de voz con comando "Navi", control de audio y ejecución segura de acciones.
- `background/`: puente entre la extensión y el backend, con timeout de peticiones.
- `popup/`: configuración, prueba de texto, salud del backend y estado de voz en tiempo real.
- `server/`: claves en `.env`, LLM (Groq) con function calling y TTS (ElevenLabs).
- `notes/`: notas de ajustes y casos de excepción.

Las API keys nunca se guardan en la extensión. Van en `server/.env`.

## Arranque

```powershell
cd server
Copy-Item .env.example .env
# Edita .env y agrega GROQ_API_KEY. ELEVENLABS_API_KEY es opcional.
npm install
npm start
```

Después carga la carpeta `Nrvi` como extensión descomprimida en `chrome://extensions`, recarga la extensión y las páginas que quieras probar.

## Modo llamada

NRVI espera en segundo plano y activa la llamada cuando dices **"Navi"**. A partir de ahí escucha de forma continua y cada frase que dices es una pregunta. Mientras NRVI responde, el micrófono sigue activo para permitir interrumpirla (barge-in); el eco de su propia voz se filtra para evitar bucles.

- Para activar la llamada: di `Navi` (y opcionalmente la pregunta seguida, p. ej. "Navi, ¿de qué trata esta página?"). También con el botón **Iniciar llamada** del panel.
- Para colgar: `cuelga`, `termina`, `deja de escuchar` (o el botón del panel). Vuelve a esperar "Navi".
- Durante la respuesta: `detente`, `para`, `cancela` (detiene audio). `pausa` para pausar. `reanuda`/`continua` para reanudar.
- `repite` / `otra vez` / `¿qué dijiste?` para repetir la última respuesta.
- `más despacio` para repetir más despacio (fallback a TTS del navegador).

El panel muestra la última pregunta y respuesta (también las dichas por voz) y las conserva al volver a abrirlo. El reconocimiento de voz depende de `SpeechRecognition` (compatible con Chrome/Chromium). En la consola de la página verás logs `[NRVI]` con lo que escucha y los errores.

## Fases recomendadas

1. Conversación textual con contexto semántico.
2. Function calling para enfocar, rellenar, desplazarse y activar controles.
3. Audio de respuesta con ElevenLabs.
4. STT del navegador para prototipar; luego Whisper o Deepgram desde el backend.
5. Captura de pantalla y modelo con visión como capacidad opcional y bajo demanda.

## Tests

Desde el directorio `server`:

```powershell
npm test
```

Se ejecutan tests nativos (`node:test`) sobre funciones puras (`lib.js`).
