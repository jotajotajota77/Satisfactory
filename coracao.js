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
  let lastNoteIdx = -1, lastNoteAt = -9e9;
  const recentBeats = []; // { rr, time }

  // ---- escala: pentatônica em duas oitavas
  const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
  const ROOT = 196; // ~G3

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
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }

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
    recentBeats.length = 0;
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
    recentBeats.push({ rr, time: performance.now() });
    if (recentBeats.length > 96) recentBeats.shift();
    if (state === STATE.CALIBRATING) {
      if (rr < rrMin) rrMin = rr;
      if (rr > rrMax) rrMax = rr;
    } else if (state === STATE.PLAYING) {
      // se o RR estourar os limites, a escala se expande em tempo real
      if (rr < rrMin) rrMin = rr;
      if (rr > rrMax) rrMax = rr;
      let t;
      if (rrMax - rrMin < 1) t = 0.5;
      else t = (rrMax - rr) / (rrMax - rrMin); // 0 = grave (RR longo), 1 = aguda (RR curto)
      const idx = clamp(Math.floor(t * SCALE.length), 0, SCALE.length - 1);
      const freq = ROOT * Math.pow(2, SCALE[idx] / 12);
      const vel = 0.34 + 0.42 * t;
      piano(freq, vel, 3.0);
      lastNoteIdx = idx;
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
        readoutEl.textContent = `♥ ${B.data.hr || '--'} bpm · ${rrMin | 0}–${rrMax | 0} ms`;
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
      if (recentBeats.length >= 5 && hasRange) {
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
    if (state !== STATE.IDLE) {
      drawScale();
      drawTimeline();
    }
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

  function drawScale() {
    const x = W - clamp(W * 0.07, 40, 72);
    const top = H * 0.18, bot = H * 0.82;
    const n = SCALE.length;
    for (let i = 0; i < n; i++) {
      const tNorm = i / (n - 1);
      const y = lerp(top, bot, tNorm);
      const scaleIdx = (n - 1) - i; // topo = nota mais aguda
      const isLast = scaleIdx === lastNoteIdx;
      const age = (performance.now() - lastNoteAt) / 900;
      const glow = isLast ? Math.max(0, 1 - age) : 0;
      const r = 4 + glow * 5.5;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = `hsla(180, 80%, ${52 + glow * 28}%, ${0.22 + glow * 0.7})`;
      ctx.fill();
    }
  }

  function drawTimeline() {
    if (recentBeats.length === 0) return;
    const x0 = W * 0.12, x1 = W * 0.88;
    const yBase = H * 0.92;
    const range = Math.max(1, rrMax - rrMin);
    for (let i = 0; i < recentBeats.length; i++) {
      const t = i / (recentBeats.length - 1 || 1);
      const x = lerp(x0, x1, t);
      const b = recentBeats[i];
      const tn = clamp((rrMax - b.rr) / range, 0, 1);
      const h = 4 + tn * 32;
      ctx.fillStyle = `hsla(${180 + tn * 30}, 70%, ${52 + tn * 10}%, 0.45)`;
      ctx.fillRect(x, yBase - h, 3, h);
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
