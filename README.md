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
# Edita .env y agrega GROQ_API_KEY_1, GROQ_API_KEY_2 y GROQ_API_KEY_3.
# ELEVENLABS_API_KEY es opcional.
npm install
npm start
```

El reconocimiento de voz de NRVI usa `MediaRecorder` y transcribe cada frase mediante
Groq Speech-to-Text (`whisper-large-v3-turbo`). Esto evita depender de
`SpeechRecognition`, cuyo servicio puede estar bloqueado en Brave. La primera
clave Groq se utiliza como fallback de transcripción y las claves configuradas
se rotan para las consultas del agente.
`ELEVENLABS_API_KEY` solo controla el audio de respuesta y es opcional; si no está
disponible, se usa la voz del navegador.

Las consultas conversacionales rotan las claves Groq configuradas en orden
`GROQ_API_KEY_1`, `GROQ_API_KEY_2`, `GROQ_API_KEY_3` y vuelven a la primera.
La grabación se mantiene en memoria durante una frase, con detección local de
silencio, cierre automático tras 3 minutos sin instrucciones y un límite de
9 segundos por frase. El audio se envía al backend
`/api/transcribe` y no se guarda en disco.

Después carga la carpeta `Nrvi` como extensión descomprimida en `chrome://extensions`, recarga la extensión y las páginas que quieras probar.

## Modo llamada

NRVI activa la captura al pulsar **Iniciar llamada**. Cada frase se delimita
mediante detección local de silencio, se transcribe con Groq y se envía al agente.
Mientras NRVI responde, la captura se pausa para evitar que el audio de salida
se convierta en una nueva pregunta.

- Para activar la llamada: pulsa **Iniciar llamada** en el panel.
- Para activar la escucha por palabra clave: pulsa **Activar palabra «NAVI»**
  en el panel y di `NAVI` seguido de una pregunta.
- El modo de espera queda activado por defecto cuando no existe una llamada
  activa. El navegador debe conceder permiso de micrófono a la página.
- Para colgar: di `cuelga`, `termina`, `deja de escuchar` (o usa el botón del panel).
- Durante la respuesta: `detente`, `para`, `cancela` (detiene audio). `pausa` para pausar. `reanuda`/`continua` para reanudar.
- `repite` / `otra vez` / `¿qué dijiste?` para repetir la última respuesta.
- `más despacio` para repetir más despacio (fallback a TTS del navegador).

El panel muestra la última pregunta y respuesta (también las dichas por voz) y las conserva al volver a abrirlo. La captura usa APIs estándar del navegador (`getUserMedia` y `MediaRecorder`), por lo que no depende del servicio remoto `SpeechRecognition`. En la consola de la página verás logs `[NRVI]` con los estados de captura, transcripción y errores.

Las transcripciones pasan primero por un router local de comandos. `detente`,
`cancela`, `pausa`, `reanuda`, `repite`, `más despacio` y `termina` controlan
la sesión sin enviarse al modelo conversacional. Solo las frases que no
coinciden con esos comandos se envían a `/api/agent`.

La palabra clave usa el diccionario local `WAKE_WORD_DICTIONARY` y acepta
`navi`, `nabi`, `naby`, `navy`, `nave`, `nabhi` y la forma `navi asistente`.
En modo espera, las frases que no contienen una variante válida se descartan
localmente y no se envían al modelo.
Actualmente el modo de espera usa ventanas breves de `MediaRecorder` y
transcripción mediante Deepgram. Es compatible con el prototipo, pero consume
solicitudes de STT; para producción conviene añadir VAD local y un detector de
palabra clave local antes de enviar audio a la nube.

Cada llamada crea un identificador de sesión. El registro operativo se guarda
en `server/logs/nrvi.log` y solo se rota cada 5 minutos o cuando supera 2.000
caracteres; no se borra al cerrar la llamada. Los errores y advertencias se
conservan en `server/logs/nrvi-errors.log`; una misma firma de error dentro de
una sesión se mantiene en una sola entrada y aumenta su contador. Las
peticiones y respuestas se conservan en `server/logs/nrvi-conversations.log`.

Durante la captura, la consola muestra cada segundo el RMS, el nivel de ruido
estimado y el umbral de voz. El popup recibe esos mismos valores para observar
si el micrófono está captando ruido ambiental. La medición usa `AnalyserNode`;
no usa `ScriptProcessorNode`, que está obsoleto.

La escucha permanece activa durante la respuesta de Navi para detectar
interrupciones locales. Se recomienda usar audífonos para evitar que la
respuesta reproducida vuelva al micrófono. La sesión y el historial se
conservan al navegar dentro de la misma pestaña, de modo que la llamada no se
reinicia por una recarga o cambio de página.

Durante la respuesta, una pregunta conversacional debe comenzar por `NAVI`
(incluidas sus variantes). `NAVI, pregunta` detiene la reproducción y envía la
pregunta al agente. Los comandos locales exactos como `detente`, `pausa`,
`reanuda`, `repite`, `finaliza la llamada` y `cuelga` siguen funcionando sin
la palabra clave.

La extensión incluye el detector facial Tiny Face Detector de `face-api.js` y
sus pesos locales en `vendor/face-api`. Cuando el modo NAVI está habilitado,
la cámara detecta presencia facial sin enviar imágenes al backend. Si no hay
rostro durante 3 minutos, se pausa el standby; cuando el rostro vuelve, la
escucha de NAVI se reactiva. Durante una llamada activa, la ausencia facial
durante 7 segundos sin que Navi esté hablando reproduce «Usuario ausente,
terminando llamada.» y finaliza la llamada. Los frames consecutivos sin rostro
mantienen el mismo temporizador; no lo reinician.

Debido a la política CSP de las extensiones MV3, el detector se ejecuta en
`sandbox/vision.html`, no directamente en el script de contenido. El contenido
envía frames locales al sandbox y recibe únicamente los rectángulos detectados;
ningún vídeo se envía al backend. La cámara es una capacidad secundaria: si el
detector tarda o no encuentra un rostro, la escucha de la palabra `NAVI` no se
bloquea.

La cámara no se inicia automáticamente al abrir una página. Se inicia al
activar explícitamente la palabra `NAVI`, iniciar una llamada o pulsar
**Mostrar cámara**. Ocultarla solo cambia su visibilidad y permite volver a
mostrarla desde el popup.

En standby, cuando el rostro permanece detectado durante 15 segundos, Navi
recuerda: «Usuario presente, diga Navi para activar el asistente». El aviso se
repite cada 15 segundos mientras el usuario permanezca presente; se detiene
cuando el rostro desaparece o comienza una llamada.

Los marcadores faciales usan el modelo local de 68 puntos de `face-api.js`.
Los marcadores de mano usan MediaPipe Hands local y muestran sus 21 puntos
(incluidos los cinco dedos). Los gestos se clasifican localmente sobre esos
puntos y requieren buena iluminación. Cada gesto debe mantenerse estable
durante 5 segundos: puño pausa la respuesta, mano abierta reanuda una
respuesta pausada, pulgar arriba repite la última respuesta y dos dedos
extendidos interrumpen la respuesta o solicitud actual y devuelven a NAVI al
modo de escucha. Dos palmas abiertas vuelven al inicio del sitio y reproducen
una confirmación breve después de la navegación. Girar la cabeza a la
izquierda vuelve a la página anterior y girarla a la derecha avanza a la
siguiente. Navi bloquea volver cuando se encuentra en la URL inicial de la
sesión y anuncia que no puede retroceder; si no existe una página siguiente,
anuncia que no puede avanzar. Los gestos solo están
habilitados durante una llamada activa; en standby esperando «NAVI» no
ejecutan acciones. El pulgar abajo y las posturas ambiguas no ejecutan acciones.

El popup incluye **Mostrar cámara** y **Mostrar marcadores**. La vista de
cámara muestra el resultado actual de la detección; los marcadores dibujan el
rectángulo y puntos de referencia del rostro y los 21 puntos de la mano.
El texto de estado de la vista previa indica por separado si se detectaron
rostro y mano, además del gesto clasificado cuando existe.

Los comandos locales no se envían al modelo conversacional, pero primero deben
transcribirse con Groq Whisper para que el navegador pueda identificarlos. Por
eso un límite de Groq que afecte al servicio de transcripción también puede
impedir reconocer `detente` o `finalizar`. Las variantes `finaliza`,
`finalizar`, `termina`, `cuelga` y sus formas con “la llamada” se reconocen
localmente después de la transcripción.

La transcripción usa Deepgram como proveedor principal (`DEEPGRAM_API_KEY`).
Groq Whisper se conserva como fallback si Deepgram falla y hay una clave Groq
configurada. Groq continúa siendo el proveedor del modelo conversacional.

Cuando una respuesta incluye un clic sobre un enlace, NRVI guarda la respuesta
en el service worker antes de navegar. La nueva página consume esa respuesta
y Navi la reproduce allí, restaurando explícitamente `inCall` y el `sessionId`
antes de reproducirla para evitar que el popup muestre «Iniciar llamada» o que
la nueva página cierre la sesión durante esa respuesta.
El popup conserva la última pregunta y respuesta mediante `chrome.storage`; no
puede permanecer visualmente abierto porque el popup pertenece al documento
anterior, pero la extensión intenta abrirlo automáticamente después de una
navegación controlada cuando Brave permite `chrome.action.openPopup()`.

El backend limita la salida de Groq para reducir el consumo de tokens por
consulta (`GROQ_MAX_COMPLETION_TOKENS`, valor predeterminado: 700). Si Groq
responde con HTTP 429, NRVI informa el límite y evita nuevos envíos durante
9 segundos.

Cada respuesta de `/api/agent` incluye `tokenUsage` con los tokens de entrada,
salida y total devueltos por Groq. Si se ejecutan herramientas se suman ambas
llamadas al modelo. La transcripción de audio no se cuenta como tokens LLM y
ElevenLabs se mide por caracteres enviados; ambos datos quedan en el log
operativo para comparar coste y calidad sin confundir ruido, consultas o
fallos de proveedor.

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

## Monitoreo con Playwright

Playwright se usa únicamente como monitor pasivo en un navegador de prueba
desde `server/playwright/monitor.js`.
No reemplaza ni ejecuta las acciones de Navi (`click_element`, `fill_input`,
`focus_field` o `scroll_page`) y no modifica los módulos de la extensión.
Registra la carga de la página, errores de consola, errores JavaScript,
solicitudes fallidas y respuestas HTTP con estado 400 o superior.

Desde `server`, instala la dependencia y ejecuta el monitor con una URL
explícita:

```powershell
npm install
$env:NRVI_MONITOR_URL="https://ejemplo.test"
npm run monitor
```

La monitorización dura 10 segundos por defecto. Se puede cambiar con
`NRVI_MONITOR_DURATION_MS`. La herramienta se define como **monitor de
calidad y diagnóstico web**, no como motor de automatización web de NRVI.
