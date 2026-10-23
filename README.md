# NRVI

NRVI es un agente conversacional para navegar páginas web con apoyo de voz. La extensión observa la página actual, crea un contexto semántico pequeño y permite conversar con un backend que puede responder y proponer acciones.

## Arquitectura

- `content/`: contexto semántico, captura de voz con `MediaRecorder`, control de audio y ejecución segura de acciones.
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

El reconocimiento de voz de NRVI usa `MediaRecorder` y transcribe cada frase mediante
Groq Speech-to-Text (`whisper-large-v3-turbo`). Esto evita depender de
`SpeechRecognition`, cuyo servicio puede estar bloqueado en Brave. La misma
`GROQ_API_KEY` se utiliza para la transcripción y para las consultas del agente.
`ELEVENLABS_API_KEY` solo controla el audio de respuesta y es opcional; si no está
disponible, se usa la voz del navegador.

La grabación se mantiene en memoria durante una frase, con detección local de
silencio y un límite de 15 segundos por frase. El audio se envía al backend
`/api/transcribe` y no se guarda en disco.

Después carga la carpeta `Nrvi` como extensión descomprimida en `chrome://extensions`, recarga la extensión y las páginas que quieras probar.

## Modo llamada

NRVI activa la captura al pulsar **Iniciar llamada**. Cada frase se delimita
mediante detección local de silencio, se transcribe con Groq y se envía al agente.
Mientras NRVI responde, la captura se pausa para evitar que el audio de salida
se convierta en una nueva pregunta.

- Para activar la llamada: pulsa **Iniciar llamada** en el panel.
- Para colgar: di `cuelga`, `termina`, `deja de escuchar` (o usa el botón del panel).
- Durante la respuesta: `detente`, `para`, `cancela` (detiene audio). `pausa` para pausar. `reanuda`/`continua` para reanudar.
- `repite` / `otra vez` / `¿qué dijiste?` para repetir la última respuesta.
- `más despacio` para repetir más despacio (fallback a TTS del navegador).

El panel muestra la última pregunta y respuesta (también las dichas por voz) y las conserva al volver a abrirlo. La captura usa APIs estándar del navegador (`getUserMedia` y `MediaRecorder`), por lo que no depende del servicio remoto `SpeechRecognition`. En la consola de la página verás logs `[NRVI]` con los estados de captura, transcripción y errores.

## Fases recomendadas

1. Conversación textual con contexto semántico.
2. Function calling para enfocar, rellenar, desplazarse y activar controles.
3. Audio de respuesta con ElevenLabs.
4. Transcripción con Groq Whisper desde el backend; Deepgram puede incorporarse después como proveedor alternativo.
5. Captura de pantalla y modelo con visión como capacidad opcional y bajo demanda.

## Tests

Desde el directorio `server`:

```powershell
npm test
```

Se ejecutan tests nativos (`node:test`) sobre funciones puras (`lib.js`).
