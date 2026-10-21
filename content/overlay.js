(() => {
  if (window.__nrviOverlayLoaded) return;
  window.__nrviOverlayLoaded = true;

  const LABELS = {
    idle: '',
    standby: 'Di «Navi»',
    listening: 'Escuchando…',
    processing: 'Procesando…',
    speaking: 'Hablando…',
    paused: 'En pausa',
    error: 'Algo salió mal'
  };

  const BAR_FACTORS = [0.55, 0.8, 1, 0.8, 0.55];
  const WAKE_HINT = 'Te escucho, habla cuando quieras';

  let host;
  let root;
  let panel;
  let bars = [];
  let labelEl;
  let subEl;
  let iconEl;
  let visible = false;
  let state = 'idle';
  let wakeWordEnabled = false;
  let level = 0;
  let transcript = '';
  let rafId = null;
  let phase = 0;
  let hideTimer = null;
  let hideDelayTimer = null;

  const build = () => {
    if (host) return true;
    try {
      host = document.createElement('div');
      host.id = 'nrvi-hud-host';
      host.setAttribute('data-nrvi-hud', 'true');
      root = host.attachShadow({ mode: 'open' });
    } catch {
      host = null;
      return false;
    }

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .hud {
          position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(16px);
          z-index: 2147483647; pointer-events: none; opacity: 0;
          transition: opacity .18s ease, transform .18s ease;
          font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        .hud.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
        .hud.standby { opacity: .82; }
        .panel {
          display: flex; flex-direction: column; gap: 6px;
          padding: 12px 18px; border-radius: 999px;
          background: rgba(15, 23, 42, .92); color: #f8fafc;
          box-shadow: 0 10px 34px rgba(0, 0, 0, .38);
          border: 1px solid rgba(148, 163, 184, .28);
          backdrop-filter: blur(8px);
          max-width: min(78vw, 560px);
        }
        .row { display: flex; align-items: center; gap: 12px; }
        .icon {
          position: relative; display: grid; place-items: center;
          width: 34px; height: 34px; border-radius: 50%;
          background: rgba(56, 189, 248, .18); color: #38bdf8;
          transition: background .2s ease, color .2s ease;
        }
        .icon svg { width: 18px; height: 18px; display: block; }
        .icon::after {
          content: ""; position: absolute; inset: 0; border-radius: 50%;
          border: 2px solid currentColor; opacity: 0;
        }
        .hud.listening .icon::after { animation: nrvi-pulse 1.4s ease-out infinite; }
        .hud.standby .icon { background: rgba(148, 163, 184, .16); color: #94a3b8; }
        .hud.processing .icon { background: rgba(250, 204, 21, .18); color: #facc15; }
        .hud.speaking .icon { background: rgba(34, 197, 94, .18); color: #22c55e; }
        .hud.paused .icon { background: rgba(148, 163, 184, .18); color: #cbd5e1; }
        .hud.error .icon { background: rgba(248, 113, 113, .2); color: #f87171; }
        @keyframes nrvi-pulse {
          0% { transform: scale(1); opacity: .7; }
          100% { transform: scale(1.9); opacity: 0; }
        }
        .bars { display: flex; align-items: center; gap: 3px; height: 30px; }
        .bar {
          width: 4px; height: 100%; border-radius: 2px;
          background: linear-gradient(180deg, #22d3ee, #22c55e);
          transform: scaleY(.12); transform-origin: center;
          transition: transform .09s linear;
        }
        .text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .label { font-size: 14px; font-weight: 700; letter-spacing: .2px; }
        .sub {
          font-size: 13px; color: #cbd5e1; max-width: min(60vw, 420px);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .sub:empty { display: none; }
      </style>
      <div class="hud" part="hud">
        <div class="panel">
          <div class="row">
            <span class="icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3"></rect>
                <path d="M5 10a7 7 0 0 0 14 0"></path>
                <line x1="12" y1="17" x2="12" y2="21"></line>
                <line x1="8" y1="21" x2="16" y2="21"></line>
              </svg>
            </span>
            <div class="bars"></div>
            <span class="text">
              <span class="label" role="status" aria-live="polite"></span>
              <span class="sub"></span>
            </span>
          </div>
        </div>
      </div>
    `;

    panel = root.querySelector('.hud');
    iconEl = root.querySelector('.icon');
    labelEl = root.querySelector('.label');
    subEl = root.querySelector('.sub');
    const barsBox = root.querySelector('.bars');
    bars = BAR_FACTORS.map(() => {
      const bar = document.createElement('div');
      bar.className = 'bar';
      barsBox.appendChild(bar);
      return bar;
    });

    (document.documentElement || document.body || document).appendChild(host);
    return true;
  };

  const isAlive = () => state && state !== 'idle';

  const subText = () => {
    if (transcript) return transcript;
    if (state === 'standby') return 'Di «Navi» para activar la llamada';
    if (state === 'listening' && wakeWordEnabled) return WAKE_HINT;
    if (state === 'listening') return 'Dime lo que necesitas';
    return '';
  };

  const render = () => {
    if (!build()) return;

    if (!isAlive()) {
      if (visible && !hideDelayTimer) {
        hideDelayTimer = setTimeout(() => {
          hideDelayTimer = null;
          if (isAlive()) return;
          panel.classList.remove('visible');
          visible = false;
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
        }, 700);
      }
      return;
    }

    if (hideDelayTimer) {
      clearTimeout(hideDelayTimer);
      hideDelayTimer = null;
    }

    panel.className = `hud visible ${state}`;
    labelEl.textContent = LABELS[state] || '';
    subEl.textContent = subText();
    visible = true;

    if (!rafId) {
      phase = 0;
      rafId = requestAnimationFrame(tick);
    }
  };

  const tick = () => {
    phase += 0.08;
    for (let i = 0; i < bars.length; i++) {
      let scale;
      switch (state) {
        case 'listening':
          scale = 0.12 + level * 1.1 * BAR_FACTORS[i];
          break;
        case 'standby':
          scale = 0.14 + 0.1 * Math.abs(Math.sin(phase * 0.6 + i));
          break;
        case 'speaking':
          scale = 0.2 + 0.8 * Math.abs(Math.sin(phase * 1.3 + i * 0.9));
          break;
        case 'processing':
          scale = 0.18 + 0.5 * Math.abs(Math.sin(phase * 0.8 + i));
          break;
        case 'paused':
          scale = 0.3;
          break;
        case 'error':
          scale = 0.12 + 0.3 * Math.abs(Math.sin(phase * 2 + i));
          break;
        default:
          scale = 0.12;
      }
      bars[i].style.transform = `scaleY(${Math.max(0.08, Math.min(1, scale))})`;
    }
    if (isAlive()) rafId = requestAnimationFrame(tick);
    else rafId = null;
  };

  const scheduleTranscriptClear = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      transcript = '';
      render();
    }, 6000);
  };

  window.addEventListener('nrvi:state', event => {
    const detail = event.detail || {};
    state = detail.state || 'idle';
    if (typeof detail.wakeWordEnabled === 'boolean') wakeWordEnabled = detail.wakeWordEnabled;
    if (typeof detail.micLevel === 'number') level = detail.micLevel;
    if (state === 'speaking' || state === 'idle') transcript = '';
    render();
  });

  window.addEventListener('nrvi:miclevel', event => {
    level = Number(event.detail?.level) || 0;
  });

  window.addEventListener('nrvi:transcript', event => {
    transcript = String(event.detail?.text || '').trim();
    render();
    if (event.detail?.final) scheduleTranscriptClear();
    else clearTimeout(hideTimer);
  });

  const initialState = window.nrviVoice?.getState?.();
  if (initialState && initialState !== 'idle') {
    state = initialState;
    wakeWordEnabled = Boolean(window.nrviVoice?.isWakeWordEnabled?.());
    level = Number(window.nrviVoice?.getMicLevel?.()) || 0;
    render();
  }
})();
