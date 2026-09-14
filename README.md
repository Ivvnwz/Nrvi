# NRVI

NRVI es un agente conversacional para navegar páginas web con apoyo de voz. La extensión observa la página actual, crea un contexto semántico pequeño y permite conversar con un backend que puede responder y proponer acciones.

## Arquitectura

- `content/`: contexto semántico, voz y ejecución segura de acciones.
- `background/`: transporte entre la extensión y el backend.
- `popup/`: configuración y pruebas de texto.
- `server/`: claves, Groq function calling y ElevenLabs.

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

## Fases recomendadas

1. Conversación textual con contexto semántico.
2. Function calling para enfocar, rellenar, desplazarse y activar controles.
3. Audio de respuesta con ElevenLabs.
4. STT del navegador para prototipar; luego Whisper o Deepgram desde el backend.
5. Captura de pantalla y modelo con visión como capacidad opcional y bajo demanda.
