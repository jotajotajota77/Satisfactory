/* ===================================================================
   CORAÇÃO TOCA
   Conecta no Polar, coleta os intervalos RR por 30 segundos, descobre o
   RR mais longo (nota mais grave) e o mais curto (nota mais aguda). A
   partir daí, cada batida toca uma nota na escala derivada do seu próprio
   coração. Se um novo RR ultrapassar os limites, a escala se expande em
   tempo real para incluí-lo.
   =================================================================== */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- canvas
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // ---- estado
  const STATE = { IDLE: 0, CALIBRATING: 1, PLAYING: 2 };
  let state = STATE.IDLE;
  let calibrationStart = 0;
  let CALIBRATION_MS = 30000;
  let calibrationExtensions = 0;
  let rrMin = Infinity, rrMax = -Infinity;
  let beatPulse = 0;
  let lastNoteKeys = [];   // teclas iluminadas no último ataque (1 ou 4)
  let lastNoteAt = -9e9;
  let lastChordName = '';  // nome do acorde tocado (modo acordes)
  let longNotes = false;   // toggle: nota normal × nota longa
  let chordMode = false;   // toggle: notas soltas × acordes diatônicos

  // C maior: I=C, ii=Dm, iii=Em, IV=F, V=G, vi=Am, vii°=B°
  const SCALE_C_MAJOR = [0, 2, 4, 5, 7, 9, 11]; // semitons a partir de C
  const NOTE_LETTERS_C = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

  function snapToScale(key) {
    // encontra a tecla mais próxima que pertence a C maior
    const semiFromC = ((key + 9) % 12 + 12) % 12;
    let best = SCALE_C_MAJOR[0], minDist = 99;
    for (const s of SCALE_C_MAJOR) {
      const d = Math.abs(s - semiFromC);
      if (d < minDist) { minDist = d; best = s; }
    }
    return key + (best - semiFromC);
  }

  function chordFromRoot(rootKey) {
    const semiFromC = ((rootKey + 9) % 12 + 12) % 12;
    let degree = SCALE_C_MAJOR.indexOf(semiFromC);
    if (degree < 0) degree = 0;
    const thirdIdx = degree + 2;
    const fifthIdx = degree + 4;
    const thirdSemi = SCALE_C_MAJOR[thirdIdx % 7] + (thirdIdx >= 7 ? 12 : 0) - SCALE_C_MAJOR[degree];
    const fifthSemi = SCALE_C_MAJOR[fifthIdx % 7] + (fifthIdx >= 7 ? 12 : 0) - SCALE_C_MAJOR[degree];
    // baixo + tríade fechada
    const all = [rootKey - 12, rootKey, rootKey + thirdSemi, rootKey + fifthSemi];
    const keys = all.filter(k => k >= 0 && k <= KEY_COUNT - 1);
    const isDim = degree === 6;
    const isMinor = degree === 1 || degree === 2 || degree === 5;
    const quality = isDim ? '°' : (isMinor ? 'm' : '');
    return { keys: keys, name: NOTE_LETTERS_C[degree] + quality };
  }
  // ---- filtragem de RR (ignora outliers/extrassístoles)
  const RR_HARD_MIN = 300;  // < 300 ms (> 200 bpm): ruído
  const RR_HARD_MAX = 2000; // > 2000 ms (< 30 bpm): batida perdida / artefato
  const RR_BUF_MAX = 80;    // últimos ~80 RRs aceitos (rolante)
  const rrBuf = [];
  function updateRangeFromBuf() {
    if (rrBuf.length < 2) return;
    const sorted = rrBuf.slice().sort(function (a, b) { return a - b; });
    const lo = Math.max(0, Math.round((sorted.length - 1) * 0.05));
    const hi = Math.min(sorted.length - 1, Math.round((sorted.length - 1) * 0.95));
    rrMin = sorted[lo];
    rrMax = sorted[hi];
  }

  // ---- piano completo: 88 teclas (A0 a C8), cromático
  const KEY_COUNT = 88;
  const A4_KEY = 48; // A0 = 0, A4 = 48
  function isBlackKey(n) { const m = n % 12; return m === 1 || m === 4 || m === 6 || m === 9 || m === 11; }
  function keyToFreq(key) { return 440 * Math.pow(2, (key - A4_KEY) / 12); }
  function rrToKey(rr) {
    if (!isFinite(rrMin) || !isFinite(rrMax) || rrMax - rrMin < 1) return Math.floor(KEY_COUNT / 2);
    const t = clamp((rrMax - rr) / (rrMax - rrMin), 0, 1);
    return clamp(Math.round(t * (KEY_COUNT - 1)), 0, KEY_COUNT - 1);
  }
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function keyName(key) {
    const idx = (key + 9) % 12;
    const oct = Math.floor((key + 9) / 12);
    return NOTE_NAMES[idx] + oct;
  }

  // ---- áudio (piano de feltro)
  let ctxA = null, master = null, verbBus = null, audioStarted = false;
  function makeReverb(seconds) {
    const rate = ctxA.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctxA.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    const conv = ctxA.createConvolver();
    conv.buffer = buf;
    return conv;
  }
  function ensureAudio() {
    if (audioStarted) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctxA = new AC();
    master = ctxA.createGain(); master.gain.value = 0.55;
    master.connect(ctxA.destination);
    const v = makeReverb(3.8);
    const wet = ctxA.createGain(); wet.gain.value = 0.5;
    v.connect(wet); wet.connect(master);
    verbBus = v;
    if (ctxA.state === 'suspended') ctxA.resume();
    audioStarted = true;
  }
  function piano(freq, vel, dur) {
    if (!audioStarted || !ctxA) return;
    const now = ctxA.currentTime;
    vel = vel == null ? 0.55 : clamp(vel, 0.02, 1);
    dur = dur || 3.2;
    const lp = ctxA.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1500 + vel * 4200, now);
    lp.frequency.exponentialRampToValueAtTime(620, now + dur * 0.6);
    lp.Q.value = 0.4;
    const bus = ctxA.createGain(); bus.gain.value = 1;
    lp.connect(bus); bus.connect(master); bus.connect(verbBus);
    const partials = [[1, 1.0, 0], [2, 0.4, 0.7], [3, 0.2, 1.8], [4, 0.09, 3.2]];
    for (let pi = 0; pi < partials.length; pi++) {
      const mult = partials[pi][0], amp = partials[pi][1], inh = partials[pi][2];
      const o = ctxA.createOscillator();
      o.type = mult === 1 ? 'triangle' : 'sine';
      o.frequency.value = freq * mult * (1 + inh * 0.0007);
      o.detune.value = Math.random() * 8 - 4;
      const g = ctxA.createGain();
      const peak = Math.max(0.0003, vel * amp * 0.42);
      const d = Math.max(0.4, dur * (1 - (mult - 1) * 0.13));
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(peak, now + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d);
      o.connect(g); g.connect(lp);
      o.start(now); o.stop(now + d + 0.08);
    }
  }

  // ---- DOM
  const statusEl = document.getElementById('status');
  const readoutEl = document.getElementById('readout');
  const connectBtn = document.getElementById('connect');
  const durToggle = document.getElementById('dur-toggle');
  const modeToggle = document.getElementById('mode-toggle');
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function setLongNotes(on) {
    longNotes = !!on;
    if (durToggle) {
      durToggle.classList.toggle('on', longNotes);
      durToggle.textContent = longNotes ? 'nota longa' : 'nota normal';
      durToggle.setAttribute('aria-pressed', longNotes ? 'true' : 'false');
    }
  }
  function setChordMode(on) {
    chordMode = !!on;
    if (modeToggle) {
      modeToggle.classList.toggle('on', chordMode);
      modeToggle.textContent = chordMode ? 'acordes' : 'notas';
      modeToggle.setAttribute('aria-pressed', chordMode ? 'true' : 'false');
    }
  }
  if (durToggle) durToggle.addEventListener('click', () => setLongNotes(!longNotes));
  if (modeToggle) modeToggle.addEventListener('click', () => setChordMode(!chordMode));
  setLongNotes(false);
  setChordMode(false);

  // ---- conexão
  connectBtn.addEventListener('click', async () => {
    ensureAudio();
    const B = window.Bio;
    if (!B || !B.supported) { setStatus('Bluetooth indisponível neste navegador'); return; }
    setStatus('procurando…');
    try {
      await B.connect();
      if (B.data.connected) {
        connectBtn.classList.add('gone');
        beginCalibration();
      } else {
        setStatus('conecte seu Polar');
      }
    } catch (e) {
      setStatus('falhou');
    }
  });

  function beginCalibration() {
    state = STATE.CALIBRATING;
    calibrationStart = performance.now();
    CALIBRATION_MS = 30000;
    calibrationExtensions = 0;
    rrMin = Infinity; rrMax = -Infinity;
    rrBuf.length = 0;
    setStatus('afinando ao seu coração');
  }
  function beginPlaying() {
    state = STATE.PLAYING;
    setStatus('seu coração está tocando');
  }
  function backToIdle() {
    state = STATE.IDLE;
    connectBtn.classList.remove('gone');
    setStatus('conecte seu Polar');
    if (readoutEl) readoutEl.textContent = '';
  }

  // ---- cada batida
  function handleBeat(rr) {
    beatPulse = 1;
    if (rr <= 0) return; // só usamos batidas com RR para a música
    // descarta RRs fora da faixa fisiológica (ruído / batida perdida)
    if (rr < RR_HARD_MIN || rr > RR_HARD_MAX) return;
    rrBuf.push(rr);
    if (rrBuf.length > RR_BUF_MAX) rrBuf.shift();
    // limites = percentil 5 / 95 do buffer (outliers/extrassístoles ignorados)
    updateRangeFromBuf();
    if (state === STATE.PLAYING) {
      // o RR é clampado nos limites P5/P95 para mapear na escala
      const rrC = clamp(rr, rrMin, rrMax);
      const key = rrToKey(rrC);
      if (chordMode) {
        // quantiza pra C maior e toca a tríade diatônica + baixo (1 oitava abaixo)
        const root = snapToScale(key);
        const ch = chordFromRoot(root);
        const tPos = clamp(root / (KEY_COUNT - 1), 0, 1);
        const vel = 0.32 + 0.45 * tPos;
        const dur = longNotes ? lerp(11, 5, tPos) : lerp(4.6, 1.7, tPos);
        // stagger mínimo (≈6 ms) imita o ataque de uma mão real
        ch.keys.forEach((k, i) => {
          const f = keyToFreq(k);
          const v = vel * (i === 0 ? 0.55 : 0.45); // baixo um pouco mais forte
          setTimeout(() => piano(f, v, dur), i * 6);
        });
        lastNoteKeys = ch.keys.slice();
        lastChordName = ch.name;
      } else {
        const freq = keyToFreq(key);
        const tPos = key / (KEY_COUNT - 1);
        const vel = 0.32 + 0.45 * tPos;
        const dur = longNotes ? lerp(11, 5, tPos) : lerp(4.6, 1.7, tPos);
        piano(freq, vel, dur);
        lastNoteKeys = [key];
        lastChordName = '';
      }
      lastNoteAt = performance.now();
    }
  }

  // ---- poll do biossensor
  function poll() {
    const B = window.Bio;
    if (!B || !B.data) return;
    if (state !== STATE.IDLE && !B.data.connected) { backToIdle(); return; }
    if (B.data.beatQueue && B.data.beatQueue.length) {
      while (B.data.beatQueue.length) {
        const b = B.data.beatQueue.shift();
        handleBeat(b.rr);
      }
    }
    if (B.data.connected) {
      if (state === STATE.CALIBRATING) {
        const left = Math.max(0, CALIBRATION_MS - (performance.now() - calibrationStart));
        const min = isFinite(rrMin) ? (rrMin | 0) : '--';
        const max = isFinite(rrMax) ? (rrMax | 0) : '--';
        readoutEl.textContent = `♥ ${B.data.hr || '--'} bpm · coletando ${Math.ceil(left / 1000)}s · ${min}–${max} ms`;
      } else if (state === STATE.PLAYING) {
        let note = '';
        if (chordMode && lastChordName) note = ' · ' + lastChordName;
        else if (lastNoteKeys.length > 0) note = ' · ' + keyName(lastNoteKeys[0]);
        readoutEl.textContent = `♥ ${B.data.hr || '--'} bpm${note} · ${rrMin | 0}–${rrMax | 0} ms`;
      } else {
        readoutEl.textContent = '';
      }
    } else if (readoutEl) {
      readoutEl.textContent = '';
    }
  }

  // ---- loop
  let lastTs = 0;
  function frame(ts) {
    const dt = Math.min(60, ts - lastTs || 16);
    lastTs = ts;
    poll();
    if (state === STATE.CALIBRATING && ts - calibrationStart >= CALIBRATION_MS) {
      const hasRange = isFinite(rrMin) && isFinite(rrMax) && rrMax - rrMin >= 1;
      if (rrBuf.length >= 5 && hasRange) {
        beginPlaying();
      } else if (calibrationExtensions < 3) {
        CALIBRATION_MS += 15000;
        calibrationExtensions++;
        setStatus('precisa de mais um pouco · afinando');
      } else {
        if (!isFinite(rrMin)) { rrMin = 600; rrMax = 1000; }
        else if (!hasRange) { rrMin -= 100; rrMax += 100; }
        beginPlaying();
      }
    }
    beatPulse *= Math.pow(0.05, dt / 1000);
    render(ts);
    requestAnimationFrame(frame);
  }

  // ---- render
  function render(ts) {
    // fade com persistência
    ctx.fillStyle = 'rgba(4, 8, 12, 0.32)';
    ctx.fillRect(0, 0, W, H);
    drawHeart();
    if (state !== STATE.IDLE) drawPiano();
    if (state === STATE.CALIBRATING) drawCalibrationRing(ts);
  }

  function drawHeart() {
    const cx = W / 2, cy = H / 2;
    const baseSize = Math.min(W, H) * 0.12;
    const size = baseSize * (1 + beatPulse * 0.35);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(size, size);
    ctx.beginPath();
    // coração: duas bezier simétricas
    ctx.moveTo(0, -0.25);
    ctx.bezierCurveTo(-1.0, -1.25, -1.5, 0.0, 0, 1.0);
    ctx.bezierCurveTo(1.5, 0.0, 1.0, -1.25, 0, -0.25);
    ctx.closePath();
    const active = state !== STATE.IDLE;
    const hue = active ? 350 : 200;
    const sat = active ? 78 : 32;
    const lit = 38 + beatPulse * 30;
    ctx.fillStyle = `hsla(${hue}, ${sat}%, ${lit}%, ${0.42 + beatPulse * 0.5})`;
    ctx.shadowColor = active ? 'rgba(255, 100, 130, 0.75)' : 'rgba(120, 220, 220, 0.32)';
    ctx.shadowBlur = 28 * (1 + beatPulse * 1.4);
    ctx.fill();
    ctx.restore();
  }

  function drawPiano() {
    const padX = 8;
    const whiteCount = 52; // 88 teclas têm 52 brancas
    const whiteWidth = Math.max(2.4, (W - padX * 2) / whiteCount);
    const whiteHeight = clamp(Math.min(W, H) * 0.11, 60, 110);
    const blackWidth = whiteWidth * 0.6;
    const blackHeight = whiteHeight * 0.62;
    const yBottom = H - 10;
    const yTop = yBottom - whiteHeight;
    const now = performance.now();
    const litAge = (now - lastNoteAt) / 1100;
    const litT = lastNoteKeys.length > 0 ? Math.max(0, 1 - litAge) : 0;
    const litSet = lastNoteKeys; // 1 ou 4 teclas
    // teclas brancas
    let wi = 0;
    for (let k = 0; k < KEY_COUNT; k++) {
      if (!isBlackKey(k)) {
        const x = padX + wi * whiteWidth;
        const lit = (litSet.indexOf(k) >= 0) ? litT : 0;
        const tn = k / (KEY_COUNT - 1);
        const hue = 198 - tn * 90; // grave (azul) → aguda (verde-amarelo)
        ctx.fillStyle = lit > 0
          ? `hsla(${hue}, 78%, ${62 + lit * 24}%, ${0.55 + lit * 0.4})`
          : 'rgba(230, 240, 240, 0.16)';
        ctx.fillRect(x, yTop, Math.max(1, whiteWidth - 1), whiteHeight);
        wi++;
      }
    }
    // teclas pretas (por cima)
    wi = 0;
    for (let k = 0; k < KEY_COUNT; k++) {
      if (isBlackKey(k)) {
        const x = padX + wi * whiteWidth - blackWidth / 2;
        const lit = (litSet.indexOf(k) >= 0) ? litT : 0;
        const tn = k / (KEY_COUNT - 1);
        const hue = 198 - tn * 90;
        ctx.fillStyle = lit > 0
          ? `hsla(${hue}, 82%, ${56 + lit * 24}%, ${0.85 + lit * 0.15})`
          : 'rgba(8, 14, 18, 0.92)';
        ctx.fillRect(x, yTop, blackWidth, blackHeight);
      } else {
        wi++;
      }
    }
  }

  function drawCalibrationRing(ts) {
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.18;
    const progress = clamp((ts - calibrationStart) / CALIBRATION_MS, 0, 1);
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * progress);
    ctx.strokeStyle = 'rgba(120, 220, 210, 0.65)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  setStatus('conecte seu Polar');
  requestAnimationFrame(frame);
})();
