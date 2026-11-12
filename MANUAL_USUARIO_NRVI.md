# Manual de usuario — NRVI (prototipo v0.2.0)

NRVI es una extensión de navegador (Chrome/Brave, Manifest V3) acompañada de un
servidor local que funciona como **asistente conversacional para navegar la web con
apoyo de voz, cámara y gestos**. Está pensada para ayudar a entender e interactuar
con la página actual, con especial atención a personas con discapacidad visual.

---

## 1. ¿Qué puede hacer NRVI en este prototipo?

- **Responder preguntas sobre la página actual** (por texto o por voz), usando un
  contexto semántico de la misma (título, encabezados, texto, botones y campos).
- **Conversar por voz**: captura el micrófono, detecta el final de cada frase por
  silencio, la transcribe y responde hablando.
- **Activarse con la palabra clave «NAVI»** sin necesidad de pulsar botones.
- **Ejecutar acciones seguras en la página**: hacer clic en botones/enlaces,
  enfocar campos, rellenar campos de texto y desplazar la página.
- **Detectar tu presencia con la cámara** y controlar la sesión con gestos de mano.
- **Mantener la conversación** al navegar dentro de la misma pestaña: la sesión, el
  historial y la respuesta en curso sobreviven los cambios de página.

---

## 2. Requisitos previos

| Requisito | Detalle |
|---|---|
| Navegador | Chrome 116+ o Brave (basado en Chromium) |
| Node.js | Para ejecutar el backend local (probado con proyectos ESM de Node) |
| Claves API | `GROQ_API_KEY` (obligatoria) y `DEEPGRAM_API_KEY` (recomendada para transcripción). `ELEVENLABS_API_KEY` es opcional (voz de respuesta) |
| Periféricos | Micrófono (imprescindible para voz) y cámara (opcional, para presencia y gestos). Se recomiendan **audífonos** para evitar que la voz de Navi vuelva al micrófono |

> Las claves API viven **solo en `server/.env`**, nunca dentro de la extensión.

---

## 3. Instalación

### 3.1 Backend (primero)

Abre una terminal de PowerShell en la carpeta del proyecto:

```powershell
cd server
Copy-Item .env.example .env
# Edita server/.env y rellena GROQ_API_KEY y (recomendado) DEEPGRAM_API_KEY
npm install
npm start
```

Si todo está bien verás:

```
NRVI backend: http://localhost:3000
```

Deja esta terminal abierta mientras uses NRVI. El backend atiende:

| Endpoint | Función |
|---|---|
| `GET /health` | Comprobación de salud del backend |
| `POST /api/transcribe` | Convierte audio en texto (Deepgram principal, Groq Whisper de respaldo) |
| `POST /api/agent` | Consulta al modelo conversacional (Groq) con contexto de la página; devuelve texto, acciones y audio |
| `POST /api/session/end` | Cierra una sesión de conversación en los registros |

### 3.2 Extensión (después)

1. Abre `chrome://extensions` (o `brave://extensions`).
2. Activa el **modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y selecciona la carpeta del proyecto `Nrvi`
   (la que contiene `manifest.json`).
4. Recarga las pestañas donde quieras usar NRVI (los scripts de contenido se
   inyectan al cargar la página).

### 3.3 Conexión desde el popup

1. Pulsa el icono de NRVI en la barra del navegador.
2. En **Conexión**, la URL por defecto es `http://localhost:3000`. Si usas otra,
   escríbela y pulsa **Guardar conexión** (el navegador pedirá autorizar ese host).
3. Pulsa **Probar conexión**. Deberías ver:
   `Backend ok | groq=si | elevenlabs=si/no`
   — `elevenlabs=no` solo significa que usarás la voz del navegador como respuesta.

---

## 4. Formas de usar NRVI

### 4.1 Por texto

1. Abre el popup y escribe tu pregunta en **Habla con NRVI**
   (por ejemplo: `¿De qué trata esta página?` o `¿Dónde inicio sesión?`).
2. Pulsa **Preguntar**. La respuesta aparece bajo el botón y también se reproduce
   en voz.
3. La última pregunta y respuesta se conservan al cerrar y reabrir el popup.

### 4.2 Modo llamada (voz continua)

1. Pulsa **Iniciar llamada** en el popup. Navi saluda:
   *«Hola, soy Navi, tu asistente de navegación. ¿En qué puedo ayudarte?»*
2. Habla con normalidad. Cada frase se delimita por detección de silencio
   (máximo 9 segundos por frase) y se transcribe automáticamente.
3. Mientras Navi responde, la escucha continúa en modo "interrupción": puedes
   cortar la respuesta con comandos locales (ver §5) o hacer una nueva pregunta
   **comenzando por «NAVI»**.
4. Pulsa **Colgar (en llamada)** o di `cuelga`, `termina`, `finaliza`, etc.

Atajos:

| Acción | Cómo |
|---|---|
| Activar/detener la escucha | Atajo de teclado **Alt+Shift+V** (configurable en `chrome://extensions/shortcuts`) |
| Colgar por voz | `cuelga`, `termina`, `finaliza`, `deja de escuchar`, y variantes con «la llamada» |

### 4.3 Modo de espera con palabra clave «NAVI»

1. Pulsa **Activar palabra «NAVI»** en el popup (queda guardado como preferencia
   y está activo por defecto).
2. NRVI queda **En espera** (standby) escuchando en ventanas cortas de audio.
   Las frases que no contienen la palabra clave se descartan localmente y no se
   envían al modelo.
3. Di `NAVI` y, a continuación, tu pregunta:
   - `NAVI` (solo) → activa la llamada y espera la pregunta.
   - `NAVI, explica esta página` → activa la llamada y usa lo que sigue como
     pregunta inicial.
4. La palabra clave acepta variantes: `navi`, `nabi`, `naby`, `navy`, `nave`,
   `nabhi` y `navi asistente`.

> El standby consume solicitudes de transcripción en la nube aunque no digas nada
> (es un prototipo; una versión final usaría detección local).

---

## 5. Comandos de voz locales

Estos comandos se reconocen localmente **antes** de enviar nada al modelo, por lo
que no consumen consultas de razonamiento. Deben transcribirse primero (STT), así
que si el servicio de transcripción falla, el comando no podrá reconocerse.

| Comando | Efecto |
|---|---|
| `detente`, `para`, `alto`, `cállate`, `silencio`, `cancela` | Detiene la respuesta hablada y cancela la solicitud en curso |
| `pausa` | Pausa la respuesta actual |
| `reanuda`, `continúa`, `sigue hablando` | Reanuda la respuesta pausada |
| `repite`, `repetir`, `otra vez`, `vuelve a explicarlo`, `¿qué dijiste?`, `repítemelo` | Repite la última respuesta |
| `más despacio` (y variantes: `habla más despacio`, `explícamelo más despacio`, …) | Repite la última respuesta más lento (usa la voz del navegador) |
| `termina`, `finaliza`, `finalizar`, `cuelga`, `colgar`, `deja de escuchar`, `no escuches más` (y formas con «la llamada») | Termina la llamada |

**Durante la respuesta de Navi** (modo interrupción):

- Los comandos locales exactos de la tabla anterior funcionan sin palabra clave.
- Una **pregunta conversacional** nueva debe comenzar por `NAVI` (o variante),
  por ejemplo `NAVI, ¿y esto qué significa?`. El audio que no es comando ni
  comienza con NAVI se descarta.

---

## 6. Estados de la interfaz

El popup y el HUD flotante en la página (una píldora en la parte inferior) muestran
el estado actual:

| Estado | Etiqueta en el popup | HUD en la página | Significado |
|---|---|---|---|
| `idle` | Inactivo | (oculto) | Sin escucha activa |
| `standby` | En espera | «Di "Navi"» | Esperando la palabra clave |
| `listening` | Escuchando | «Escuchando…» | Capturando tu frase |
| `processing` | Procesando | «Procesando…» | Transcribiendo o consultando al agente |
| `speaking` | Hablando | «Hablando…» | Reproduciendo la respuesta |
| `paused` | En pausa | «En pausa» | Respuesta pausada (voz o gesto) |
| `error` | Error | «Algo salió mal» | Fallo al iniciar o mantener la voz |

El popup además muestra en tiempo real:

- **Actividad de voz**: barra de nivel del micrófono (0–100 %).
- **Ruido y umbral**: ruido base estimado y umbral de voz, útiles para saber si el
  micrófono capta ruido ambiental.
- La **última pregunta y respuesta**, también las dichas por voz.

En la consola de la página (F12) aparecen mensajes `[NRVI]` con los estados de
captura, transcripción y errores, útiles para depurar.

---

## 7. Cámara, presencia facial y gestos

La cámara es **opcional** y todo el procesamiento de imagen es **local** (los
frames nunca se envían al backend). No se inicia sola al abrir una página: se
activa al encender la palabra «NAVI», al iniciar una llamada o al pulsar
**Mostrar cámara** en el popup.

### 7.1 Presencia facial

- Usa el detector local `Tiny Face Detector` (face-api.js), ejecutado en un
  sandbox de la extensión por la política CSP.
- **En llamada**: si no se detecta tu rostro durante 7 segundos (sin que Navi
  esté hablando), Navi dice *«Usuario ausente, terminando llamada.»* y cuelga.
- **En espera**: si no se detecta rostro durante 7 segundos, la escucha de NAVI
  se pausa; cuando el rostro reaparece, la escucha se reactiva.
- Si el rostro se mantiene detectado 5 segundos en standby, Navi recuerda una
  sola vez: *«Usuario presente, diga Navi para activar el asistente»*.
- Si el detector tarda o no encuentra rostro, la escucha de NAVI **no se bloquea**.

### 7.2 Gestos de mano

Requieren buena iluminación y solo están activos **durante una llamada**. Cada
gesto debe mantenerse estable durante 4 segundos:

| Gesto | Efecto |
|---|---|
| Puño | Pausa la respuesta |
| Mano abierta | Reanuda una respuesta pausada |
| Pulgar arriba | Repite la última respuesta |
| Dos dedos extendidos (victoria) | Interrumpe la respuesta/solicitud actual y vuelve a la escucha |
| Dos palmas abiertas | Vuelve al inicio del sitio y confirma: *«He vuelto al inicio de la web.»* |
| Pulgar abajo / postura ambigua | Ninguna acción |

### 7.3 Vista de cámara y marcadores

- **Mostrar cámara**: muestra la vista previa con el estado de detección
  (rostro y mano por separado, y el gesto clasificado si existe).
- **Mostrar marcadores**: dibuja sobre la imagen el rectángulo y los 68 puntos
  del rostro y los 21 puntos de la mano.
- Ocultar la cámara solo cambia su visibilidad; puedes volver a mostrarla desde
  el popup.

---

## 8. Acciones sobre la página

Cuando preguntas algo como *«pulsa el botón de buscar»* o *«baja en la página»*,
el modelo puede devolver acciones que NRVI ejecuta de forma validada:

| Acción | Qué hace |
|---|---|
| Clic en un elemento | Activa un botón o enlace visible de la página |
| Enfocar un campo | Coloca el cursor en un campo visible |
| Rellenar un campo | Escribe texto en un campo, **sin enviar formularios** |
| Desplazar la página | Sube o baja aproximadamente una pantalla |

Detalles de seguridad del prototipo:

- Solo se usan IDs presentes en el contexto de la página (máx. 60 elementos
  interactivos y 30 campos visibles); no se inventan controles.
- Las acciones se filtran y validan antes de ejecutarse.
- Para acciones irreversibles (comprar, borrar, enviar formularios), el agente
  está instruido para explicar qué ocurrirá y pedir confirmación.

---

## 9. Sesión, historial y navegación

- Cada llamada crea un **identificador de sesión**; el historial conserva hasta 12
  intercambios.
- Si Navi responde con un **clic en un enlace**, la respuesta se guarda antes de
  navegar y se **reproduce en la nueva página** (restaurando la llamada y la
  sesión), en un plazo máximo de 60 segundos.
- La sesión sobrevive recargas y cambios de página **dentro de la misma pestaña**;
  no así al cambiar de pestaña o cerrar el navegador.
- El popup intenta reabrirse solo tras una navegación controlada (si el navegador
  lo permite).

---

## 10. Comportamientos automáticos

| Situación | Comportamiento |
|---|---|
| 3 minutos sin instrucciones válidas en llamada | La llamada se cierra automáticamente |
| Frase de más de 9 segundos | La captura se corta y se transcribe lo capturado |
| Audio vacío / demasiado corto | Se descarta sin crear ciclos de escucha |
| Groq devuelve límite de uso (HTTP 429) | NRVI lo informa y evita nuevos envíos durante 15 segundos |
| ElevenLabs sin saldo (HTTP 402) o sin clave | La respuesta se conserva y se usa la voz del navegador (`speechSynthesis`) |
| Deepgram falla | Groq Whisper transcribe como respaldo (si hay `GROQ_API_KEY`) |
| Permiso de micrófono denegado / página no compatible | Estado `error` con mensaje en el popup |

---

## 11. Registros y depuración

El backend escribe en `server/logs/` (nunca registra claves API):

| Archivo | Contenido |
|---|---|
| `nrvi.log` | Registro operativo (rotación cada 5 minutos o al superar ~2.000 caracteres) |
| `nrvi-errors.log` | Errores y advertencias deduplicados por firma dentro de una sesión |
| `nrvi-conversations.log` | Peticiones y respuestas del agente |

Pruebas del servidor (funciones puras de `server/lib.js`):

```powershell
cd server
npm test
```

---

## 12. Solución de problemas frecuentes

| Síntoma | Causa probable / solución |
|---|---|
| «No pude conectar con NRVI» | El backend no está corriendo. Ejecuta `npm start` en `server/` y pulsa **Probar conexión** |
| El popup dice «NRVI no está disponible en esta página» | Es una página interna del navegador (`chrome://…`) o restringida. Abre una página web normal y recárgala |
| No detecta mi voz | Concede permiso de micrófono a la página; revisa la barra de «Actividad de voz» y los valores de ruido/umbral del popup |
| La voz de Navi se transcribe como pregunta | Usa audífonos para separar el audio de salida del micrófono |
| Navi no responde tras un límite de Groq | Espera ~15 segundos; el aviso se pronuncia en voz |
| La voz suena «robótica» | Es la voz del navegador (`speechSynthesis`); ElevenLabs no está configurada o se quedó sin cuota |
| Los gestos no responden | Necesitan buena iluminación, una llamada activa y 4 segundos de estabilidad |
| Comandos como `detente` no funcionan | El servicio de transcripción (Deepgram/Groq) está fallando o limitado; revisa `server/logs/nrvi-errors.log` |

---

## 13. Privacidad y seguridad

- Las **claves API permanecen solo en `server/.env`**; no se incluyen en la
  extensión, ni en logs, ni en commits.
- El **audio de cada frase se mantiene en memoria** durante la transcripción y no
  se guarda en disco; el audio inferior a 1 KB se descarta.
- El **vídeo de la cámara nunca sale del equipo**: el detector facial y de manos
  corren localmente en un sandbox de la extensión.
- Los registros del servidor conservan preguntas y respuestas en
  `server/logs/` — revísalos si compartes el entorno.
- Si compartiste claves durante el desarrollo, **revócalas y regenera** las claves
  de Groq/Deepgram/ElevenLabs.

---

## Apéndice A. Variables de entorno (`server/.env`)

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del backend |
| `GROQ_API_KEY` | — | **Obligatoria.** Modelo conversacional (y STT de respaldo) |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Modelo de chat de Groq |
| `GROQ_MAX_COMPLETION_TOKENS` | `700` | Límite de tokens por respuesta |
| `GROQ_TIMEOUT_MS` | `20000` | Tiempo de espera del modelo |
| `DEEPGRAM_API_KEY` | — | Recomendada. STT principal (`nova-3`) |
| `DEEPGRAM_STT_MODEL` | `nova-3` | Modelo de transcripción |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | STT de respaldo |
| `ELEVENLABS_API_KEY` | — | Opcional. Voz de respuesta natural |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` | Voz de ElevenLabs |
| `ELEVENLABS_TIMEOUT_MS` | `15000` | Tiempo de espera de TTS |
| `ALLOWED_ORIGINS` | (todos) | Orígenes CORS permitidos, separados por comas |

## Apéndice B. Estructura del proyecto

```
Nrvi/
├─ manifest.json              # Extensión MV3 (nombre, permisos, atajos)
├─ background/service-worker.js# Puente extensión ↔ backend, navegación pendiente
├─ content/
│  ├─ context.js              # Contexto semántico de la página (botones, campos, texto)
│  ├─ vision.js               # Cámara, rostro, manos y gestos
│  ├─ voice.js                # Captura de voz, standby, comandos, estados, sesión
│  ├─ agent.js                # Consultas al agente, acciones, historial
│  └─ overlay.js              # HUD visual en la página
├─ popup/                      # UI de configuración y control
├─ sandbox/                    # Página sandbox para los detectores (CSP)
├─ vendor/                     # Modelos locales: face-api.js y MediaPipe Hands
├─ server/                     # Backend Express: Groq, Deepgram, ElevenLabs, logs
└─ notes/                      # Notas de ajustes y casos de excepción
```
