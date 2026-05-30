/* ===================================================================
   ECOSSISTEMA EMOCIONAL
   Um ambiente vivo, generativo e contemplativo.
   Funciona em dois modos ao mesmo tempo:
     - contemplativo: continua vivendo sozinho;
     - interativo: cada toque altera o comportamento do ambiente.
   Sem build, sem dependências. Apenas Canvas + Web Audio + memória local.
   =================================================================== */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (x) => x * x * (3 - 2 * x);
  const map = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
  const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  const hsla = (h, s, l, a) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a})`;

  // -------------------------------------------------------------- memória
  const MEM_KEY = 'ecossistema.emocional.v1';
  function loadMem() {
    try { return JSON.parse(localStorage.getItem(MEM_KEY)) || {}; }
    catch (e) { return {}; }
  }
  const mem = loadMem();
  if (typeof mem.visits !== 'number') mem.visits = 0;
  if (typeof mem.arousalBase !== 'number') mem.arousalBase = 0.18;
  if (!Array.isArray(mem.garden)) mem.garden = [];
  const returning = mem.visits > 0;
  mem.visits += 1;
  const sinceLast = mem.lastVisit ? Date.now() - mem.lastVisit : 0;
  mem.lastVisit = Date.now();
  // semente do mundo é nova a cada abertura (o "como" do mundo é redesenhado),
  // a memória (jardim, personalidade) continua persistindo separadamente.
  const sessionSeed = (Math.random() * 0xffffffff) >>> 0;

  function saveMem() {
    try {
      mem.arousalBase = clamp(lerp(mem.arousalBase, W.arousal, 0.35), 0, 1);
      mem.garden = W.garden.slice(-MAX_PLANTS).map((p) => ({
        nx: +p.nx.toFixed(4), ny: +p.ny.toFixed(4),
        t: p.plantedWall, seed: p.seed, hue: Math.round(p.hue),
      }));
      mem.lastVisit = Date.now();
      localStorage.setItem(MEM_KEY, JSON.stringify(mem));
    } catch (e) { /* armazenamento indisponível: o mundo simplesmente esquece */ }
  }

  // ------------------------------------------------------------- ambiente
  const field = Noise.create(sessionSeed);
  const n2 = field.noise2D;
  const n3 = field.noise3D;
  const rngVisit = Noise.mulberry32(sessionSeed ^ 0x9e3779b9);

  const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const MAX_PLANTS = 48;
  const GROW_MS = 6 * 60 * 1000;

  const W = {
    w: 0, h: 0, dpr: 1, min: 0,
    now: 0, startTs: 0,
    timeScale: 1,
    // pointer
    px: -9999, py: -9999, ppx: -9999, ppy: -9999,
    pvx: 0, pvy: 0, speed: 0, pActive: false, pDown: false,
    lastMove: 0, idle: 99999, lastClick: 0,
    jitter: 0, lastSign: 0,
    downX: 0, downY: 0, dragDist: 0,
    // estado emocional
    energy: 0,                 // curto prazo
    arousal: mem.arousalBase,  // longo prazo (personalidade)
    climate: 'calmaria',
    climateHold: 0,
    dream: false,
    // forças
    wind: { x: 0, y: 0 },
    shake: 0,
    flash: 0,
    hueDrift: 0,   // evolução lenta da paleta (menos repetitivo)
    hueShift: 0,   // empurrão transitório de cor (toques)
    sessionHue: 0, // cor própria desta visita (nova a cada vez)
    breath: 0,     // respiração do tempo (desacelera e volta)
    bioPulse: 0,   // batimento cardíaco a fazer o ambiente pulsar
    bioPulseX: 0, bioPulseY: 0, // ponto (aleatório) do último batimento
    // coleções
    particles: [],
    creatures: [],
    garden: [],
    events: [],
    ripples: [],
    sparks: [],
    pulses: [],
    vortices: [],
    links: [],
    drag: null,
    dragField: { active: false, x: 0, y: 0, vx: 0, vy: 0, mode: 'corrente', swirl: 1, strength: 0 },
    // toques avançados
    downTime: 0, lastTapAt: 0, lastTapX: 0, lastTapY: 0,
    charge: { active: false, x: 0, y: 0, t: 0 },
    idleCalm: 0,
    // biossensor (Polar)
    bio: { active: false, beating: false, hr: 0, hrNorm: 0, hrv: 0, accMag: 0, gyroMag: 0, gyroZ: 0, _seen: 0 },
    // linha de osciloscópio / ECG de fundo
    scope: {
      hist: null, n: 0, step: 4, scroll: 0, head: 0,
      baseY: 0, amp: 0, alpha: 0, alphaTarget: 0,
      glitch: 0, beatClock: 9999, scopeT: 0, hue: 200,
      glitchCD: 0, explodeCD: 6000, beatDt: 11,
      timeWarp: 1, explodePhase: 0,
    },
    // render
    repaint: true,
  };

  // restaura jardim plantado em visitas anteriores (tempo absoluto de relógio)
  for (const g of mem.garden) {
    W.garden.push({
      nx: g.nx, ny: g.ny, seed: g.seed >>> 0, hue: g.hue,
      plantedWall: typeof g.t === 'number' ? g.t : Date.now() - 2 * GROW_MS,
      struct: null,
    });
  }

  // --------------------------------------------------------------- canvas
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });

  function resize() {
    W.dpr = Math.min(window.devicePixelRatio || 1, 2);
    W.w = window.innerWidth;
    W.h = window.innerHeight;
    W.min = Math.min(W.w, W.h);
    canvas.width = Math.floor(W.w * W.dpr);
    canvas.height = Math.floor(W.h * W.dpr);
    canvas.style.width = W.w + 'px';
    canvas.style.height = W.h + 'px';
    ctx.setTransform(W.dpr, 0, 0, W.dpr, 0, 0);
    W.repaint = true;
    rebalanceParticles();
    initScope();
  }

  // ============================================================== PALETA
  const PALETTES = {
    'calmaria':   { bgH: 205, bgS: 45, bgL: 6, h: [185, 200, 165], sat: 72, light: 62, fade: 0.075, veil: 0 },
    'névoa':      { bgH: 200, bgS: 18, bgL: 9, h: [195, 210, 180], sat: 32, light: 72, fade: 0.135, veil: 0.05 },
    'vento':      { bgH: 215, bgS: 42, bgL: 7, h: [200, 225, 168], sat: 66, light: 64, fade: 0.090, veil: 0 },
    'chuva':      { bgH: 218, bgS: 34, bgL: 7, h: [205, 215, 195], sat: 52, light: 66, fade: 0.105, veil: 0.02 },
    'tempestade': { bgH: 262, bgS: 38, bgL: 5, h: [282, 322, 205], sat: 80, light: 60, fade: 0.078, veil: 0 },
    'aurora':     { bgH: 165, bgS: 42, bgL: 5, h: [150, 285, 190], sat: 82, light: 64, fade: 0.065, veil: 0 },
    'sonho':      { bgH: 285, bgS: 48, bgL: 6, h: [305, 200, 332], sat: 84, light: 66, fade: 0.062, veil: 0 },
  };

  const pal = {
    bgH: 205, bgS: 45, bgL: 6, h0: 185, h1: 200, h2: 165,
    sat: 72, light: 62, fade: 0.05, veil: 0,
  };

  function paletteTarget() {
    let base = PALETTES[W.climate] || PALETTES.calmaria;
    // sobreposição de sonho (madrugada)
    if (W.dream) {
      const d = PALETTES['sonho'];
      base = {
        bgH: lerp(base.bgH, d.bgH, 0.6), bgS: lerp(base.bgS, d.bgS, 0.6), bgL: lerp(base.bgL, d.bgL, 0.5),
        h: [lerp(base.h[0], d.h[0], 0.5), lerp(base.h[1], d.h[1], 0.5), lerp(base.h[2], d.h[2], 0.5)],
        sat: lerp(base.sat, d.sat, 0.5), light: lerp(base.light, d.light, 0.5),
        fade: lerp(base.fade, d.fade, 0.5), veil: base.veil,
      };
    }
    return base;
  }

  function updatePalette(dt) {
    const t = paletteTarget();
    const k = 1 - Math.pow(0.0008, dt / 1000); // suave
    pal.bgH = lerp(pal.bgH, t.bgH, k);
    pal.bgS = lerp(pal.bgS, t.bgS, k);
    pal.bgL = lerp(pal.bgL, t.bgL, k);
    pal.h0 = lerp(pal.h0, t.h[0], k);
    pal.h1 = lerp(pal.h1, t.h[1], k);
    pal.h2 = lerp(pal.h2, t.h[2], k);
    pal.sat = lerp(pal.sat, t.sat, k);
    pal.light = lerp(pal.light, t.light, k);
    pal.fade = lerp(pal.fade, t.fade, k);
    pal.veil = lerp(pal.veil, t.veil, k);
  }

  function accentHue(seed) {
    const arr = [pal.h0, pal.h1, pal.h2];
    return arr[(seed | 0) % 3] + Math.sin(seed) * 14 + W.hueDrift + W.hueShift + W.sessionHue;
  }
  // de vez em quando, uma cor inesperada (complementar / fora da paleta)
  function rareHue() {
    const base = [pal.h0, pal.h1, pal.h2][(Math.random() * 3) | 0];
    return base + pick([150, 180, 210, -120]) + W.hueDrift;
  }

  // ============================================================== ÁUDIO
  const Audio = (function () {
    let ctxA = null, master = null, wet = null;
    let dragOsc = null, dragOsc2 = null, dragGain = null, dragFilter = null;
    let started = false, muted = false;
    let root = 196;
    let scale = [0, 2, 4, 7, 9];

    function makeReverb(seconds) {
      const rate = ctxA.sampleRate;
      const len = Math.max(1, Math.floor(rate * seconds));
      const buf = ctxA.createBuffer(2, len, rate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) {
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
        }
      }
      const conv = ctxA.createConvolver();
      conv.buffer = buf;
      return conv;
    }

    function init() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        ctxA = new AC();
        master = ctxA.createGain(); master.gain.value = 0.0;
        master.connect(ctxA.destination);

        const verb = makeReverb(4.5);
        wet = ctxA.createGain(); wet.gain.value = 0.5;
        verb.connect(wet); wet.connect(master);

        // (sem drone de fundo: só piano + sons de interação)

        // voz de arraste (sopro suave que segue o gesto — não mais áspero)
        dragOsc = ctxA.createOscillator(); dragOsc.type = 'triangle'; dragOsc.frequency.value = root;
        dragOsc2 = ctxA.createOscillator(); dragOsc2.type = 'sine'; dragOsc2.frequency.value = root * 2; dragOsc2.detune.value = 6;
        dragFilter = ctxA.createBiquadFilter(); dragFilter.type = 'lowpass'; dragFilter.frequency.value = 520; dragFilter.Q.value = 2;
        dragGain = ctxA.createGain(); dragGain.gain.value = 0;
        dragOsc.connect(dragFilter); dragOsc2.connect(dragFilter);
        dragFilter.connect(dragGain); dragGain.connect(master); dragGain.connect(verb);
        dragOsc.start(); dragOsc2.start();

        // bus de envio para plucks
        Audio.send = verb;
        return true;
      } catch (e) { ctxA = null; return false; }
    }

    function start() {
      if (started) return;
      if (!ctxA && !init()) return;
      if (ctxA.state === 'suspended') ctxA.resume();
      started = true;
      const now = ctxA.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(muted ? 0 : 0.55, now + 4);
    }

    function noteFreq(i) {
      const len = scale.length;
      const oct = Math.floor(i / len);
      let idx = ((i % len) + len) % len;
      const semi = scale[idx] + 12 * oct;
      return root * Math.pow(2, semi / 12);
    }

    // piano de feltro: parciais com leve inarmonicidade + envelope percussivo macio
    function piano(input, vel, dur) {
      if (!started || !ctxA || muted) return;
      const now = ctxA.currentTime;
      const f0 = (typeof input === 'number' && input > 30) ? input : noteFreq(input);
      vel = vel == null ? 0.5 : clamp(vel, 0.02, 1);
      dur = dur || 3.4;
      const lp = ctxA.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1400 + vel * 4200, now);
      lp.frequency.exponentialRampToValueAtTime(620, now + dur * 0.6);
      lp.Q.value = 0.4;
      const bus = ctxA.createGain();
      bus.gain.value = 1;
      lp.connect(bus); bus.connect(master); bus.connect(Audio.send);
      const partials = [[1, 1.0, 0], [2, 0.4, 0.7], [3, 0.2, 1.8], [4, 0.09, 3.2]];
      for (let pi = 0; pi < partials.length; pi++) {
        const mult = partials[pi][0], amp = partials[pi][1], inh = partials[pi][2];
        const o = ctxA.createOscillator();
        o.type = mult === 1 ? 'triangle' : 'sine';
        o.frequency.value = f0 * mult * (1 + inh * 0.0007);
        o.detune.value = rand(-4, 4);
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

    function arp(indices, vel, spacing) {
      if (!started) return;
      indices.forEach((i, k) => setTimeout(() => piano(i, (vel == null ? 0.4 : vel) * (1 - k * 0.05), 3.0), k * (spacing || 130)));
    }

    function chord(indices, vel) {
      if (!started) return;
      indices.forEach((i, k) => setTimeout(() => piano(i, (vel == null ? 0.4 : vel) * (1 - k * 0.1), 3.6), k * 45));
    }

    function thunder() {
      if (!started || !ctxA || muted) return;
      const now = ctxA.currentTime;
      const len = Math.floor(ctxA.sampleRate * 1.2);
      const buf = ctxA.createBuffer(1, len, ctxA.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      const src = ctxA.createBufferSource(); src.buffer = buf;
      const f = ctxA.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 220;
      const g = ctxA.createGain(); g.gain.value = 0.0;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.4, now + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
      src.connect(f); f.connect(g); g.connect(master); g.connect(Audio.send);
      src.start(now);
    }

    function shimmer() {
      if (!started) return;
      chord([7, 9, 11, 14], 0.08);
    }

    // batida cardíaca: um "tum" grave e macio
    function heartbeat(vel) {
      if (!started || !ctxA || muted) return;
      const now = ctxA.currentTime;
      const o = ctxA.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(108, now);
      o.frequency.exponentialRampToValueAtTime(46, now + 0.16);
      const g = ctxA.createGain();
      const peak = (vel == null ? 0.4 : vel) * 0.5;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
      o.connect(g); g.connect(master);
      o.start(now); o.stop(now + 0.55);
    }

    function dragMove(active, x) {
      if (!started || !ctxA) return;
      const now = ctxA.currentTime;
      if (active) {
        const i = Math.round(map(x, 0, W.w, 7, -2));
        const f = noteFreq(i);
        dragOsc.frequency.setTargetAtTime(f, now, 0.12);
        dragOsc2.frequency.setTargetAtTime(f * 2, now, 0.12);
        dragFilter.frequency.setTargetAtTime(420 + W.speed * 24, now, 0.15);
        dragGain.gain.setTargetAtTime(muted ? 0 : 0.038, now, 0.15);
      } else {
        dragGain.gain.setTargetAtTime(0, now, 0.5);
      }
    }

    function setMood(energy, arousal, dream) {
      if (!ctxA) return;
      // escala muda conforme o humor
      if (dream) { scale = [0, 2, 4, 6, 8, 10]; root = 174.6; }
      else if (arousal > 0.7) { scale = [0, 1, 3, 6, 7, 10]; root = 174.6; }
      else if (arousal > 0.4) { scale = [0, 2, 3, 7, 10]; root = 196; }
      else { scale = [0, 2, 4, 7, 9]; root = 196; }
      if (!started) return;
      const now = ctxA.currentTime;
      wet.gain.setTargetAtTime(0.6 - arousal * 0.3, now, 2);
    }

    function toggleMute() {
      muted = !muted;
      if (started && ctxA) {
        master.gain.setTargetAtTime(muted ? 0 : 0.55, ctxA.currentTime, 0.4);
      }
      return muted;
    }

    return { init, start, piano, arp, chord, thunder, shimmer, heartbeat, dragMove, setMood, toggleMute,
      get started() { return started; }, get muted() { return muted; }, send: null };
  })();

  // ============================================================ PARTÍCULAS
  const TYPE = { DRIFT: 0, FOLLOW: 1, FLEE: 2, LEARN: 3 };

  function targetParticleCount() {
    let base = (W.w * W.h) / 12000;
    if (isTouch) base *= 0.6;
    if (reduceMotion) base *= 0.5;
    return clamp(Math.round(base), 60, 320);
  }

  // formas: 0 ponto · 1 anel · 2 risco · 3 faísca · 4 névoa
  const SHAPES = [0, 0, 0, 1, 1, 2, 2, 3, 4];
  // distribuição: 30% atração · 30% repulsão · 20% indiferente · 20% aprendiz
  function pickType() {
    const r = Math.random();
    if (r < 0.30) return TYPE.FOLLOW;
    if (r < 0.60) return TYPE.FLEE;
    if (r < 0.80) return TYPE.DRIFT;
    return TYPE.LEARN;
  }
  function spawnParticle(x, y) {
    const isRare = Math.random() < 0.05;
    return {
      x: x === undefined ? rand(W.w) : x,
      y: y === undefined ? rand(W.h) : y,
      vx: rand(-0.2, 0.2), vy: rand(-0.2, 0.2),
      type: pickType(),
      switchIn: rand(4000, 16000),
      size: rand(0.8, 2.8),
      hueSeed: (Math.random() * 3) | 0,
      hueOff: isRare ? pick([150, 180, -120]) + rand(-10, 10) : rand(-22, 22),
      lightOff: rand(-10, 12),
      shape: pick(SHAPES),
      phase: rand(TAU),
      pulse: rand(0.4, 1.5),
      ang: rand(TAU),
      spin: rand(-0.05, 0.05),
      // ~1/3 têm movimento-base em espiral, com velocidade própria
      spiral: Math.random() < 0.32,
      spinRate: rand(0.03, 0.13),
      spinDir: Math.random() < 0.5 ? 1 : -1,
      lvx: 0, lvy: 0,
    };
  }

  function rebalanceParticles() {
    const target = targetParticleCount();
    const cur = W.particles.length;
    if (cur < target) for (let i = cur; i < target; i++) W.particles.push(spawnParticle());
    else if (cur > target) W.particles.length = target;
  }

  // grade espacial para constelações + detecção de aglomerados
  let clusterTimer = 0;
  function updateParticles(dt) {
    const t = W.now;
    const sec = dt / 1000;
    const flow = 0.0013;
    const speedCap = lerp(0.9, 3.4, W.arousal);
    const followR = W.min * 0.22, followR2 = followR * followR;
    const fleeR = W.min * 0.16, fleeR2 = fleeR * fleeR;
    const cell = Math.max(40, W.min * 0.06);
    const grid = new Map();
    W.links.length = 0;

    for (let p = 0; p < W.particles.length; p++) {
      const a = W.particles[p];
      // movimento-base: espiral (para algumas) ou campo de fluxo orgânico
      let fx, fy;
      if (a.spiral) {
        const rx = a.x - W.w * 0.5, ry = a.y - W.h * 0.5;
        const d = Math.hypot(rx, ry) || 1;
        const rate = a.spinRate * (0.6 + 0.8 * (0.5 + 0.5 * Math.sin(t * 0.0004 + a.phase)));
        const radial = Math.sin(t * 0.0003 + a.phase) * 0.02; // sopro pra dentro/fora → espiral
        fx = (-ry / d) * rate * a.spinDir + (rx / d) * radial + n2(a.x * flow, a.y * flow + 9) * 0.012;
        fy = (rx / d) * rate * a.spinDir + (ry / d) * radial + n2(a.y * flow, a.x * flow + 9) * 0.012;
      } else {
        const ang = n3(a.x * flow, a.y * flow, t * 0.00004) * TAU * 1.6;
        fx = Math.cos(ang) * 0.04;
        fy = Math.sin(ang) * 0.04;
      }

      // vento global (arraste do usuário)
      fx += W.wind.x * 0.06;
      fy += W.wind.y * 0.06;

      if (W.pActive) {
        const dx = W.px - a.x, dy = W.py - a.y;
        const d2 = dx * dx + dy * dy;
        if (a.type === TYPE.FOLLOW && d2 < followR2) {
          const d = Math.sqrt(d2) || 1;
          const f = (1 - d / followR) * 0.10;
          fx += (dx / d) * f; fy += (dy / d) * f;
        } else if (a.type === TYPE.FLEE && d2 < fleeR2) {
          const d = Math.sqrt(d2) || 1;
          const f = (1 - d / fleeR) * 0.42;
          fx -= (dx / d) * f; fy -= (dy / d) * f;
        }
      }
      if (a.type === TYPE.LEARN) {
        // aprende lentamente o movimento do cursor
        a.lvx = lerp(a.lvx, W.pvx * 0.5, 0.01);
        a.lvy = lerp(a.lvy, W.pvy * 0.5, 0.01);
        fx += a.lvx * 0.05; fy += a.lvy * 0.05;
      }

      // pulsos de toque: atração/repulsão radial com envelope no tempo
      for (let q = 0; q < W.pulses.length; q++) {
        const pu = W.pulses[q];
        const dxq = a.x - pu.x, dyq = a.y - pu.y;
        const dq = Math.sqrt(dxq * dxq + dyq * dyq) || 1;
        if (dq < pu.radius) {
          const env = 1 - pu.age / pu.dur;
          const f = pu.force * (1 - dq / pu.radius) * env;
          fx += (dxq / dq) * f; fy += (dyq / dq) * f;
        }
      }

      // pincel de arraste: cada modo molda o movimento de forma diferente
      if (W.dragField.active) {
        const df = W.dragField;
        const dxd = a.x - df.x, dyd = a.y - df.y;
        const dd = Math.sqrt(dxd * dxd + dyd * dyd) || 1;
        const R = W.min * 0.30;
        if (dd < R) {
          const fall = (1 - dd / R) * df.strength;
          if (df.mode === 'corrente') { fx += df.vx * 0.06 * fall; fy += df.vy * 0.06 * fall; }
          else if (df.mode === 'vortice') { fx += (-dyd / dd) * df.swirl * 0.5 * fall; fy += (dxd / dd) * df.swirl * 0.5 * fall; }
          else if (df.mode === 'atrair') { fx -= (dxd / dd) * 0.45 * fall; fy -= (dyd / dd) * 0.45 * fall; }
          else if (df.mode === 'espalhar') { fx += (dxd / dd) * 0.55 * fall; fy += (dyd / dd) * 0.55 * fall; }
          else if (df.mode === 'tinta') { fx += (-(dxd / dd) * 0.12 + df.vx * 0.02) * fall; fy += (-(dyd / dd) * 0.12 + df.vy * 0.02) * fall; }
        }
      }

      // vórtices persistentes: atraem e giram (pequenas galáxias)
      for (let q = 0; q < W.vortices.length; q++) {
        const v = W.vortices[q];
        const dxv = a.x - v.x, dyv = a.y - v.y;
        const dv = Math.sqrt(dxv * dxv + dyv * dyv) || 1;
        if (dv < v.radius) {
          const env = clamp(Math.min(v.age, v.dur - v.age) / 2000, 0, 1);
          const fall = (1 - dv / v.radius) * env;
          fx += (-dyv / dv) * v.swirl * 0.5 * fall - (dxv / dv) * 0.12 * fall;
          fy += (dxv / dv) * v.swirl * 0.5 * fall - (dyv / dv) * 0.12 * fall;
        }
      }

      // biossensor: giroscópio cria redemoinho global; acelerômetro turbulência
      if (W.bio.active) {
        if (Math.abs(W.bio.gyroZ) > 0.002) {
          const rx = a.x - W.w * 0.5, ry = a.y - W.h * 0.5;
          const rl = Math.hypot(rx, ry) || 1;
          const sw = clamp(W.bio.gyroZ, -1, 1) * 0.5;
          fx += (-ry / rl) * sw; fy += (rx / rl) * sw;
        }
        if (W.bio.accMag > 0.015) {
          const tn = n3(a.x * 0.004, a.y * 0.004, t * 0.0003) * TAU;
          fx += Math.cos(tn) * W.bio.accMag * 0.4;
          fy += Math.sin(tn) * W.bio.accMag * 0.4;
          // sem giroscópio (H10): o próprio movimento gera um leve redemoinho
          if (!W.bio.gyroMag) {
            const rx = a.x - W.w * 0.5, ry = a.y - W.h * 0.5, rl = Math.hypot(rx, ry) || 1;
            const sw = W.bio.accMag * 0.22 * Math.sin(t * 0.0003);
            fx += (-ry / rl) * sw; fy += (rx / rl) * sw;
          }
        }
      }

      a.vx = (a.vx + fx) * 0.96;
      a.vy = (a.vy + fy) * 0.96;
      const sp = Math.hypot(a.vx, a.vy);
      if (sp > speedCap) { a.vx = (a.vx / sp) * speedCap; a.vy = (a.vy / sp) * speedCap; }

      a.x += a.vx * sec * 60;
      a.y += a.vy * sec * 60;

      // mundo toroidal: nunca há borda
      if (a.x < -10) a.x += W.w + 20; else if (a.x > W.w + 10) a.x -= W.w + 20;
      if (a.y < -10) a.y += W.h + 20; else if (a.y > W.h + 10) a.y -= W.h + 20;

      a.phase += sec * a.pulse;
      a.ang += a.spin * sec * 60;

      // o comportamento oscila: às vezes troca atração/repulsão/indiferença
      a.switchIn -= dt;
      if (a.switchIn <= 0) { a.type = pickType(); a.switchIn = rand(4000, 16000); }

      // insere na grade
      const cx = (a.x / cell) | 0, cy = (a.y / cell) | 0;
      const key = cx + ',' + cy;
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push(a);
    }

    // constelações: ligações esparsas entre vizinhos (mais visíveis em calma)
    if (W.arousal < 0.55 && W.links.length < 150) {
      const linkD = cell * 0.9, linkD2 = linkD * linkD;
      grid.forEach((bucket, key) => {
        const parts = key.split(',');
        const cx = +parts[0], cy = +parts[1];
        for (let bi = 0; bi < bucket.length; bi++) {
          const a = bucket[bi];
          for (let oy = 0; oy <= 1; oy++) for (let ox = (oy === 0 ? 1 : -1); ox <= 1; ox++) {
            const nb = grid.get((cx + ox) + ',' + (cy + oy));
            if (!nb) continue;
            for (let bj = 0; bj < nb.length; bj++) {
              const b = nb[bj];
              if (a === b) continue;
              const dd = dist2(a.x, a.y, b.x, b.y);
              if (dd < linkD2) {
                W.links.push(a.x, a.y, b.x, b.y, 1 - dd / linkD2);
                if (W.links.length >= 750) return;
              }
            }
          }
        }
      });
    }

    // harmonia de aglomerado: vez ou outra, partículas juntas "cantam"
    clusterTimer -= dt;
    if (clusterTimer <= 0 && Audio.started && !Audio.muted) {
      clusterTimer = rand(2200, 5200);
      let best = 0, bk = null;
      grid.forEach((b) => { if (b.length > best) { best = b.length; bk = b; } });
      if (best >= 6 && bk) {
        const cy = bk[0].y;
        Audio.piano(Math.round(map(cy, 0, W.h, 9, 0)), 0.06, 2.8);
      }
    }
  }

  function renderParticles() {
    ctx.globalCompositeOperation = 'lighter';
    // ligações
    if (W.links.length) {
      ctx.lineWidth = 0.6;
      for (let i = 0; i < W.links.length; i += 5) {
        const a = W.links[i + 4];
        ctx.strokeStyle = hsla(pal.h1, pal.sat, pal.light, 0.06 * a);
        ctx.beginPath();
        ctx.moveTo(W.links[i], W.links[i + 1]);
        ctx.lineTo(W.links[i + 2], W.links[i + 3]);
        ctx.stroke();
      }
    }
    // partículas (formas e cores variadas)
    for (let p = 0; p < W.particles.length; p++) {
      const a = W.particles[p];
      const pulse = 0.55 + 0.45 * Math.sin(a.phase);
      const hue = accentHue(a.hueSeed) + a.hueOff + (a.type === TYPE.FLEE ? 18 : 0);
      const li = clamp(pal.light + a.lightOff, 30, 86);
      const alpha = 0.34 + 0.30 * pulse;
      const r = a.size * (0.8 + 0.5 * pulse);
      ctx.fillStyle = hsla(hue, pal.sat, li, alpha);
      ctx.strokeStyle = hsla(hue, pal.sat, li, alpha);
      switch (a.shape) {
        case 1: // anel
          ctx.lineWidth = Math.max(0.6, r * 0.5);
          ctx.beginPath(); ctx.arc(a.x, a.y, r * 1.5, 0, TAU); ctx.stroke();
          break;
        case 2: { // risco (alinhado ao movimento)
          const sp = Math.hypot(a.vx, a.vy);
          const ang = sp > 0.05 ? Math.atan2(a.vy, a.vx) : a.ang;
          const len = r * (2 + Math.min(sp, 4));
          ctx.lineWidth = Math.max(0.7, r * 0.8);
          ctx.beginPath();
          ctx.moveTo(a.x - Math.cos(ang) * len, a.y - Math.sin(ang) * len);
          ctx.lineTo(a.x + Math.cos(ang) * len, a.y + Math.sin(ang) * len);
          ctx.stroke();
          break;
        }
        case 3: { // faísca (estrela de 4 pontas)
          const len = r * 2.2;
          ctx.lineWidth = Math.max(0.6, r * 0.5);
          ctx.beginPath();
          for (let s = 0; s < 4; s++) {
            const aa = a.ang + (s * Math.PI) / 2;
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(a.x + Math.cos(aa) * len, a.y + Math.sin(aa) * len);
          }
          ctx.stroke();
          break;
        }
        case 4: // névoa (núcleo fraco, halo amplo)
          ctx.fillStyle = hsla(hue, pal.sat, li + 6, alpha * 0.5);
          ctx.beginPath(); ctx.arc(a.x, a.y, r * 0.7, 0, TAU); ctx.fill();
          ctx.fillStyle = hsla(hue, pal.sat, li + 8, alpha * 0.07);
          ctx.beginPath(); ctx.arc(a.x, a.y, r * 4.5, 0, TAU); ctx.fill();
          continue;
        default: // ponto
          ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, TAU); ctx.fill();
      }
      // halo comum
      ctx.fillStyle = hsla(hue, pal.sat, li + 8, alpha * 0.09);
      ctx.beginPath();
      ctx.arc(a.x, a.y, r * 3, 0, TAU);
      ctx.fill();
    }
  }

  // ============================================================ CRIATURAS
  function spawnCreature(rare) {
    const segs = rare ? 26 : (6 + (Math.random() * 7 | 0));
    const body = [];
    const x = rand(W.w), y = rand(W.h);
    for (let i = 0; i < segs; i++) body.push({ x, y });
    return {
      body, segs,
      hue: accentHue((Math.random() * 3) | 0),
      noiseOff: rand(1000),
      speed: rare ? 0.4 : rand(0.5, 1.1),
      size: rare ? rand(10, 16) : rand(2.5, 6),
      life: 0,
      maxLife: rare ? rand(40000, 70000) : rand(45000, 120000),
      born: W.now,
      fade: 0,
      rare: !!rare,
      hideT: 0,
    };
  }

  function initCreatures() {
    const count = isTouch ? 3 : 5;
    for (let i = 0; i < count; i++) W.creatures.push(spawnCreature(false));
  }

  function updateCreatures(dt) {
    const sec = dt / 1000;
    for (let i = W.creatures.length - 1; i >= 0; i--) {
      const c = W.creatures[i];
      c.life += dt;
      // nascimento/morte (fade suave)
      const fadeIn = clamp(c.life / 4000, 0, 1);
      const fadeOut = clamp((c.maxLife - c.life) / 5000, 0, 1);
      c.fade = Math.min(fadeIn, fadeOut);
      if (c.life > c.maxLife) {
        W.creatures.splice(i, 1);
        if (!c.rare && W.creatures.length < (isTouch ? 3 : 5)) {
          setTimeout(() => W.creatures.push(spawnCreature(false)), rand(3000, 12000));
        }
        continue;
      }
      // durante tempestade, criaturas se escondem
      const hide = W.climate === 'tempestade' ? 1 : 0;
      c.hideT = lerp(c.hideT, hide, 0.02);

      const head = c.body[0];
      const t = (W.now + c.noiseOff * 1000) * 0.0001;
      const ang = n2(c.noiseOff, t) * TAU * 2;
      const sp = c.speed * (1 + W.arousal * 0.6) * (1 - c.hideT * 0.7);
      head.x += Math.cos(ang) * sp * sec * 60 + W.wind.x * 0.4;
      head.y += Math.sin(ang) * sp * sec * 60 + W.wind.y * 0.4;
      // mantém dentro com retorno suave
      const m = 40;
      if (head.x < m) head.x += (m - head.x) * 0.02;
      if (head.x > W.w - m) head.x -= (head.x - (W.w - m)) * 0.02;
      if (head.y < m) head.y += (m - head.y) * 0.02;
      if (head.y > W.h - m) head.y -= (head.y - (W.h - m)) * 0.02;
      // corpo segue (mola)
      for (let s = 1; s < c.body.length; s++) {
        const seg = c.body[s], prev = c.body[s - 1];
        seg.x = lerp(seg.x, prev.x, 0.35);
        seg.y = lerp(seg.y, prev.y, 0.35);
      }
    }
  }

  function renderCreatures() {
    for (const c of W.creatures) {
      const a = c.fade * (1 - c.hideT * 0.85);
      if (a <= 0.01) continue;
      const dream = W.dream ? 1.4 : 1;
      // corpo: source-over (organismos lentos não devem acumular/saturar)
      ctx.globalCompositeOperation = 'source-over';
      for (let s = c.body.length - 1; s >= 0; s--) {
        const seg = c.body[s];
        const k = 1 - s / c.body.length;
        const r = c.size * (0.35 + k) * dream;
        const al = a * (0.10 + 0.45 * k);
        ctx.fillStyle = hsla(c.hue, pal.sat, pal.light + (c.rare ? 10 : 0), al);
        ctx.beginPath();
        ctx.arc(seg.x, seg.y, r, 0, TAU);
        ctx.fill();
      }
      // brilho aditivo suave e limitado só na cabeça
      ctx.globalCompositeOperation = 'lighter';
      const head = c.body[0];
      ctx.fillStyle = hsla(c.hue, pal.sat, pal.light + 12, a * 0.035);
      ctx.beginPath();
      ctx.arc(head.x, head.y, c.size * dream * 4.2, 0, TAU);
      ctx.fill();
    }
  }

  // ============================================================== JARDIM
  function buildPlantStruct(seed) {
    const rng = Noise.mulberry32(seed >>> 0);
    const branches = 2 + (rng() * 4 | 0);
    const struct = {
      branches: [], petals: 3 + (rng() * 7 | 0), height: 0.10 + rng() * 0.14,
      style: (rng() * 3) | 0,            // 0 redonda · 1 pontiaguda · 2 anelar
      bloomAt: 0.45 + rng() * 0.22,      // quando a flor abre
    };
    for (let i = 0; i < branches; i++) {
      struct.branches.push({
        at: 0.3 + rng() * 0.6,
        ang: (rng() - 0.5) * 1.4,
        len: 0.25 + rng() * 0.5,
        side: rng() < 0.5 ? -1 : 1,
      });
    }
    return struct;
  }

  function plantSeed(x, y) {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const p = {
      nx: x / W.w, ny: y / W.h, seed,
      hue: Math.random() < 0.28 ? rareHue() : accentHue((Math.random() * 3) | 0) + rand(-20, 20),
      plantedWall: Date.now(),
      struct: buildPlantStruct(seed),
    };
    W.garden.push(p);
    if (W.garden.length > MAX_PLANTS) W.garden.shift();
    addRipple(x, y, 1, p.hue);
  }

  function plantGrowth(p) {
    const age = Date.now() - p.plantedWall;
    return clamp(age / GROW_MS, 0.0, 1.0);
  }

  function renderGarden() {
    // source-over: plantas são estáticas, evitam acúmulo aditivo
    ctx.globalCompositeOperation = 'source-over';
    for (const p of W.garden) {
      if (!p.struct) p.struct = buildPlantStruct(p.seed);
      const g = plantGrowth(p);
      if (g <= 0) continue;
      const bx = p.nx * W.w, by = p.ny * W.h;
      const sway = n2(p.seed * 0.001, W.now * 0.0002) * 0.25 * (1 + W.arousal);
      const H = W.min * p.struct.height * smooth(g);
      const topX = bx + Math.sin(sway) * H * 0.4;
      const topY = by - H;
      const lw = clamp(H * 0.02, 0.6, 2.4);

      // caule
      ctx.lineWidth = lw;
      ctx.strokeStyle = hsla(p.hue, pal.sat * 0.7, pal.light, 0.4 * g);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(lerp(bx, topX, 0.5) + Math.sin(sway) * 6, lerp(by, topY, 0.5), topX, topY);
      ctx.stroke();

      // ramos
      for (const b of p.struct.branches) {
        if (g < b.at * 0.6) continue;
        const ax = lerp(bx, topX, b.at);
        const ay = lerp(by, topY, b.at);
        const bl = H * b.len * smooth(clamp((g - b.at * 0.5) / 0.5, 0, 1));
        const ang = -Math.PI / 2 + b.ang * b.side + sway;
        const ex = ax + Math.cos(ang) * bl;
        const ey = ay + Math.sin(ang) * bl;
        ctx.strokeStyle = hsla(p.hue, pal.sat * 0.7, pal.light, 0.3 * g);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        // ponta luminosa
        const tipR = lw * (0.8 + g);
        ctx.fillStyle = hsla(p.hue, pal.sat, pal.light + 10, 0.5 * g);
        ctx.beginPath(); ctx.arc(ex, ey, tipR, 0, TAU); ctx.fill();
      }

      // flor (quando maduro) — estilo varia por planta
      const bAt = p.struct.bloomAt;
      if (g > bAt) {
        const bloom = smooth(clamp((g - bAt) / (1 - bAt), 0, 1));
        const fr = H * 0.12 * bloom + lw;
        const petals = p.struct.petals;
        const spin = W.now * 0.0002;
        if (p.struct.style === 1) {
          // pontiaguda: pétalas como raios
          ctx.lineWidth = Math.max(0.8, fr * 0.18);
          for (let i = 0; i < petals; i++) {
            const aa = (i / petals) * TAU + spin;
            ctx.strokeStyle = hsla(p.hue + 18, pal.sat, pal.light + 6, 0.45 * bloom);
            ctx.beginPath();
            ctx.moveTo(topX, topY);
            ctx.lineTo(topX + Math.cos(aa) * fr * 1.6, topY + Math.sin(aa) * fr * 1.6);
            ctx.stroke();
          }
        } else if (p.struct.style === 2) {
          // anelar: dois anéis de pontos
          for (let ring = 1; ring <= 2; ring++) {
            for (let i = 0; i < petals; i++) {
              const aa = (i / petals) * TAU + spin * ring;
              const rr = fr * (0.7 + ring * 0.5);
              ctx.fillStyle = hsla(p.hue + 14 * ring, pal.sat, pal.light + 6, 0.32 * bloom);
              ctx.beginPath(); ctx.arc(topX + Math.cos(aa) * rr, topY + Math.sin(aa) * rr, fr * 0.32, 0, TAU); ctx.fill();
            }
          }
        } else {
          // redonda: pétalas suaves
          for (let i = 0; i < petals; i++) {
            const aa = (i / petals) * TAU + spin;
            ctx.fillStyle = hsla(p.hue + 20, pal.sat, pal.light + 6, 0.4 * bloom);
            ctx.beginPath(); ctx.arc(topX + Math.cos(aa) * fr, topY + Math.sin(aa) * fr, fr * 0.5, 0, TAU); ctx.fill();
          }
        }
        // núcleo
        ctx.fillStyle = hsla(p.hue + 40, pal.sat, pal.light + 18, 0.7 * bloom);
        ctx.beginPath(); ctx.arc(topX, topY, fr * 0.5, 0, TAU); ctx.fill();
      }

      // brilho da base
      ctx.fillStyle = hsla(p.hue, pal.sat, pal.light, 0.12 * g);
      ctx.beginPath(); ctx.arc(bx, by, H * 0.18 + 4, 0, TAU); ctx.fill();
    }
  }

  // ============================================================= RIPPLES
  function addRipple(x, y, strength, hue, speed) {
    W.ripples.push({
      x, y, r: 2,
      max: W.min * (0.12 + 0.12 * (strength || 1)),
      a: 0.4 + 0.2 * (strength || 1),
      sp: speed || 1.6,
      hue: hue == null ? accentHue(0) : hue,
    });
  }
  function updateRipples(dt) {
    const sec = dt / 1000;
    for (let i = W.ripples.length - 1; i >= 0; i--) {
      const r = W.ripples[i];
      r.r += (r.max - r.r) * r.sp * sec;
      r.a -= 0.45 * sec;
      if (r.a <= 0.01) W.ripples.splice(i, 1);
    }
  }
  function renderRipples() {
    ctx.globalCompositeOperation = 'lighter';
    for (const r of W.ripples) {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = hsla(r.hue, pal.sat, pal.light, r.a * 0.5);
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke();
    }
  }

  // ============================================================== FAÍSCAS
  function spawnBurst(x, y, count, opts) {
    opts = opts || {};
    const spread = opts.spread == null ? 0.6 : opts.spread;
    const n = Math.min(count, 440 - W.sparks.length);
    for (let i = 0; i < n; i++) {
      const ang = opts.dir != null ? opts.dir + rand(-spread, spread) : rand(TAU);
      const sp = rand(opts.spMin || 1, opts.spMax || 6);
      W.sparks.push({
        x, y,
        vx: Math.cos(ang) * sp + (opts.vx || 0),
        vy: Math.sin(ang) * sp + (opts.vy || 0),
        life: 0, maxLife: rand(opts.lifeMin || 600, opts.lifeMax || 1800),
        size: rand(opts.sizeMin || 0.8, opts.sizeMax || 2.4),
        hue: opts.hue == null ? accentHue((Math.random() * 3) | 0) : opts.hue + rand(-12, 12),
        drag: opts.drag == null ? 0.94 : opts.drag,
        grav: opts.grav || 0,
      });
    }
  }
  function updateSparks(dt) {
    const sec = dt / 1000;
    for (let i = W.sparks.length - 1; i >= 0; i--) {
      const s = W.sparks[i];
      s.life += dt;
      s.vx *= s.drag; s.vy = s.vy * s.drag + s.grav * sec * 60;
      s.x += s.vx * sec * 60; s.y += s.vy * sec * 60;
      if (s.life > s.maxLife) W.sparks.splice(i, 1);
    }
  }
  function renderSparks() {
    ctx.globalCompositeOperation = 'lighter';
    for (const s of W.sparks) {
      const k = clamp(1 - s.life / s.maxLife, 0, 1);
      ctx.fillStyle = hsla(s.hue, pal.sat, pal.light + 6, k * 0.7);
      ctx.beginPath(); ctx.arc(s.x, s.y, s.size * (0.4 + k), 0, TAU); ctx.fill();
    }
  }

  // ============================================================== PULSOS
  function addPulse(x, y, force, radius, hue) {
    W.pulses.push({
      x, y, age: 0, dur: 900, r: 2,
      radius: radius || W.min * 0.22, force,
      hue: hue == null ? accentHue(0) : hue,
    });
    if (W.pulses.length > 8) W.pulses.shift();
  }
  function updatePulses(dt) {
    const sec = dt / 1000;
    for (let i = W.pulses.length - 1; i >= 0; i--) {
      const pu = W.pulses[i];
      pu.age += dt;
      pu.r += (pu.radius - pu.r) * 3.2 * sec;
      if (pu.age > pu.dur) W.pulses.splice(i, 1);
    }
  }
  function renderPulses() {
    ctx.globalCompositeOperation = 'lighter';
    for (const pu of W.pulses) {
      const k = 1 - pu.age / pu.dur;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = hsla(pu.hue, pal.sat, pal.light + 6, k * 0.4);
      ctx.beginPath(); ctx.arc(pu.x, pu.y, pu.r, 0, TAU); ctx.stroke();
    }
  }

  // ========================================================= VÓRTICES (galáxias)
  function addVortex(x, y, swirl, hue) {
    W.vortices.push({
      x, y, age: 0, dur: rand(9000, 16000),
      radius: W.min * rand(0.28, 0.42),
      swirl: swirl || (Math.random() < 0.5 ? 1 : -1),
      hue: hue == null ? accentHue((Math.random() * 3) | 0) : hue,
      spin: rand(TAU),
    });
    if (W.vortices.length > 4) W.vortices.shift();
    addRipple(x, y, 1, hue, 1.0);
    Audio.chord([0, 4, 7, 11], 0.1);
  }
  function updateVortices(dt) {
    for (let i = W.vortices.length - 1; i >= 0; i--) {
      const v = W.vortices[i];
      v.age += dt;
      v.spin += (v.swirl * 0.0015) * dt;
      if (v.age > v.dur) W.vortices.splice(i, 1);
    }
  }
  function renderVortices() {
    ctx.globalCompositeOperation = 'lighter';
    for (const v of W.vortices) {
      const k = clamp(Math.min(v.age, v.dur - v.age) / 2500, 0, 1);
      const arms = 2;
      ctx.lineWidth = 1;
      for (let a = 0; a < arms; a++) {
        ctx.strokeStyle = hsla(v.hue + a * 16, pal.sat, pal.light + 6, 0.10 * k);
        ctx.beginPath();
        for (let s = 0; s <= 60; s++) {
          const tt = s / 60;
          const ar = tt * v.radius;
          const aa = v.spin + a * Math.PI + v.swirl * tt * 7;
          const px = v.x + Math.cos(aa) * ar, py = v.y + Math.sin(aa) * ar;
          if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      // núcleo
      ctx.fillStyle = hsla(v.hue, pal.sat, pal.light + 12, 0.16 * k);
      ctx.beginPath(); ctx.arc(v.x, v.y, 6, 0, TAU); ctx.fill();
    }
  }

  // ===================================================== LINHA / OSCILOSCÓPIO
  const SCOPE_RATE = 90; // amostras por segundo de varredura

  function initScope() {
    const s = W.scope;
    s.step = Math.max(3, Math.round(W.w / 360));
    s.n = Math.ceil(W.w / s.step) + 2;
    s.hist = new Float32Array(s.n);
    s.head = s.n - 1;
    s.baseY = W.h * 0.62;
    if (s.amp === 0) s.amp = W.h * 0.06;
    if (s.alpha === 0) { s.alpha = 0.8; s.alphaTarget = 0.8; }
    if (!s.scopeT) s.scopeT = rand(1000);
  }

  // ECG estilizado (PQRST sintético, com licenças poéticas)
  function ecgTemplate(t) {
    if (t > 900) return 0;
    const g = (c, w, a) => a * Math.exp(-((t - c) * (t - c)) / (2 * w * w));
    return g(60, 18, 0.12) - g(110, 8, 0.12) + g(135, 7, 1.0) - g(160, 9, 0.28) + g(300, 40, 0.30);
  }

  function newScopeSample() {
    const s = W.scope;
    let v;
    if (W.bio.beating) {
      v = ecgTemplate(s.beatClock) + n2(s.scopeT * 0.7, 11.3) * 0.05;
    } else {
      v = n2(s.scopeT * 0.25, 3.1) * 0.6 + n2(s.scopeT * 0.9, 7.7) * 0.25 + Math.sin(s.scopeT * 0.7) * 0.12;
    }
    if (s.glitch > 0.01) v += (Math.random() * 2 - 1) * s.glitch * 1.3 + Math.sin(s.scopeT * 6) * s.glitch * 0.6;
    v += n2(s.scopeT * 4.0, 1.2) * 0.04;
    return clamp(v, -3, 3);
  }

  function scopeBeat() { W.scope.beatClock = 0; }
  function scopeGlitch(intensity) { W.scope.glitch = Math.min(1.6, W.scope.glitch + intensity); }
  // pedido de explosão: primeiro a linha desacelera no tempo até parar
  function scopeExplode() { if (W.scope.explodePhase === 0) W.scope.explodePhase = 1; }
  // a explosão em si (quando a varredura já parou)
  function doExplodeBurst() {
    const s = W.scope;
    const count = 6 + (Math.random() * 8 | 0);
    for (let k = 0; k < count; k++) {
      const x = rand(W.w);
      const idx = (s.head + 1 + Math.round(x / s.step)) % s.n;
      const y = s.baseY - (s.hist[idx] || 0) * s.amp * s.alpha;
      spawnBurst(x, y, 3 + (Math.random() * 4 | 0), { hue: s.hue, spMax: 4, lifeMax: 1600 });
      if (Math.random() < 0.3 && W.garden.length < MAX_PLANTS) plantSeed(x, clamp(y, W.h * 0.2, W.h * 0.9));
    }
    addRipple(W.w * 0.5, s.baseY, 1.4, s.hue, 1.6);
    Audio.chord([0, 4, 7, 11], 0.1);
    s.alpha = 0.04; s.alphaTarget = 0.04; // some e reaparece sutilmente
  }

  function updateScope(dt) {
    const s = W.scope;
    if (!s.hist) initScope();
    // a cor do traçado oscila
    s.hue = pal.h1 + Math.sin(W.now * 0.0007) * 50 + Math.sin(W.now * 0.00017) * 18 + W.hueDrift;
    s.beatDt = 1000 / SCOPE_RATE;

    // distorção no tempo: desacelera até parar, explode, depois volta ao normal
    if (s.explodePhase === 1) {
      s.timeWarp = Math.max(0, s.timeWarp - dt / 1800);
      s.glitch = Math.max(s.glitch, (1 - s.timeWarp) * 0.5); // treme ao desacelerar
      if (s.timeWarp <= 0.001) { doExplodeBurst(); s.explodePhase = 2; }
    } else if (s.explodePhase === 2) {
      s.timeWarp = Math.min(1, s.timeWarp + dt / 1400);
      if (s.timeWarp >= 1) s.explodePhase = 0;
    } else {
      s.timeWarp = Math.min(1, s.timeWarp + dt / 600);
    }

    const baseAmp = (W.bio.beating ? W.h * 0.11 : W.h * 0.07);
    const ampTarget = baseAmp * (0.55 + 0.6 * (0.5 + 0.5 * n2(W.now * 0.00004, 50))) * (1 + s.glitch * 1.4);
    s.amp = lerp(s.amp, ampTarget, 1 - Math.pow(0.2, dt / 1000));
    const normalAlpha = W.bio.beating ? 0.95 : 0.75;
    s.alphaTarget = lerp(s.alphaTarget, normalAlpha, 1 - Math.pow(0.85, dt / 1000));
    s.alpha = lerp(s.alpha, s.alphaTarget, 1 - Math.pow(0.25, dt / 1000));
    s.glitch *= Math.pow(0.06, dt / 1000);
    s.glitchCD -= dt; s.explodeCD -= dt;
    if (s.glitchCD <= 0 && Math.random() < dt / 9000) { scopeGlitch(rand(0.4, 1)); s.glitchCD = rand(2500, 7000); }
    if (s.explodePhase === 0 && s.explodeCD <= 0 && Math.random() < dt / 22000) { scopeExplode(); s.explodeCD = rand(14000, 30000); }

    // a varredura desacelera junto com o time-warp
    s.scroll += SCOPE_RATE * dt / 1000 * s.timeWarp;
    let add = Math.floor(s.scroll); s.scroll -= add;
    if (add > s.n) add = s.n;
    for (let i = 0; i < add; i++) {
      s.beatClock += s.beatDt;
      s.scopeT += 0.06;
      s.head = (s.head + 1) % s.n;
      s.hist[s.head] = newScopeSample();
    }
  }

  function renderScope() {
    const s = W.scope;
    if (!s.hist || s.alpha <= 0.01) return;
    const hue = s.hue;
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let i = 0; i < s.n; i++) {
        const idx = (s.head + 1 + i) % s.n;
        const x = i * s.step;
        const y = s.baseY - s.hist[idx] * s.amp * s.alpha;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (pass === 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineWidth = 5;
        ctx.strokeStyle = hsla(hue, 90, 60, 0.035 * s.alpha);
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = hsla(hue, 95, 68, 0.6 * s.alpha);
      }
      ctx.stroke();
    }
  }

  // =============================================================== EVENTOS
  const Events = (function () {
    let cooldowns = { eclipse: 0, mandala: 0, rare: 0, bloom: 0, ghost: 0 };

    function spawn(type, opts) {
      const e = Object.assign({ type, t: 0, dur: 6000 }, opts || {});
      W.events.push(e);
      announceEvent(type);
      if (type === 'eclipse') Audio.chord([0, 3, 5], 0.12);
      else if (type === 'mandala') Audio.shimmer();
      else if (type === 'bloom') Audio.chord([4, 7, 9, 11], 0.12);
      else if (type === 'aurora') Audio.shimmer();
      else if (type === 'rare') Audio.chord([-2, 2, 5], 0.1);
      return e;
    }

    function maybeSpawn(dt) {
      for (const k in cooldowns) cooldowns[k] = Math.max(0, cooldowns[k] - dt);
      const nightBoost = W.dream ? 2.4 : 1;

      // meteoros: frequentes mas sutis
      if (Math.random() < dt / 9000 * nightBoost) {
        spawnMeteor();
      }
      // aurora: surge na calma
      if (W.arousal < 0.25 && cooldowns.bloom <= 0 && Math.random() < dt / 60000) {
        spawn('aurora', { dur: 22000 });
        cooldowns.bloom = 40000;
      }
      // floração: rara, premia a calma
      if (W.arousal < 0.3 && W.garden.length > 2 && cooldowns.bloom <= 0 && Math.random() < dt / 90000) {
        spawn('bloom', { dur: 9000 });
        cooldowns.bloom = 60000;
      }
      // mandala geométrica: rara
      if (cooldowns.mandala <= 0 && Math.random() < dt / 110000 * nightBoost) {
        spawn('mandala', { dur: 16000, rot: rand(TAU), sides: 3 + (Math.random() * 6 | 0) });
        cooldowns.mandala = 90000;
      }
      // eclipse: muito raro
      if (cooldowns.eclipse <= 0 && Math.random() < dt / 240000) {
        spawn('eclipse', { dur: 18000 });
        cooldowns.eclipse = 180000;
      }
      // entidade rara: muito rara, mais provável de madrugada
      if (cooldowns.rare <= 0 && Math.random() < dt / 200000 * nightBoost) {
        const c = spawnCreature(true);
        W.creatures.push(c);
        announceEvent('rare');
        Audio.chord([-5, 0, 3, 7], 0.1);
        cooldowns.rare = 150000;
      }
      // presença fantasma (outro visitante): ocasional
      if (cooldowns.ghost <= 0 && Math.random() < dt / 130000) {
        spawnGhost();
        cooldowns.ghost = 90000;
      }
    }

    function spawnMeteor() {
      const fromLeft = Math.random() < 0.5;
      const y0 = rand(-0.1, 0.5) * W.h;
      W.events.push({
        type: 'meteor', t: 0, dur: rand(1200, 2200),
        x: fromLeft ? -40 : W.w + 40, y: y0,
        vx: (fromLeft ? 1 : -1) * rand(6, 11), vy: rand(2, 5),
        hue: accentHue((Math.random() * 3) | 0),
        trail: [],
      });
    }

    function spawnGhost() {
      W.events.push({
        type: 'ghost', t: 0, dur: rand(12000, 22000),
        x: rand(W.w), y: rand(W.h), off: rand(1000), planted: false,
        hue: accentHue((Math.random() * 3) | 0),
      });
    }

    function update(dt) {
      for (let i = W.events.length - 1; i >= 0; i--) {
        const e = W.events[i];
        e.t += dt;
        if (e.type === 'meteor') {
          e.x += e.vx; e.y += e.vy;
          e.trail.push(e.x, e.y);
          if (e.trail.length > 24) e.trail.splice(0, 2);
          if (e.x < -60 || e.x > W.w + 60 || e.y > W.h + 60) { W.events.splice(i, 1); continue; }
        } else if (e.type === 'ghost') {
          const t = (W.now + e.off * 1000) * 0.0002;
          e.x += n2(e.off, t) * 2.2;
          e.y += n2(e.off + 50, t) * 2.2;
          e.x = clamp(e.x, 0, W.w); e.y = clamp(e.y, 0, W.h);
          // o outro visitante às vezes planta algo
          if (!e.planted && e.t > e.dur * 0.5 && Math.random() < 0.01 && W.garden.length < MAX_PLANTS) {
            plantSeed(e.x, e.y); e.planted = true;
            Audio.piano(Math.round(map(e.y, 0, W.h, 8, 0)), 0.1, 3.2);
          }
        } else if (e.type === 'bloom') {
          // acelera o crescimento do jardim durante a floração
          const boost = dt * 8;
          for (const p of W.garden) p.plantedWall -= boost;
        }
        if (e.t > e.dur) W.events.splice(i, 1);
      }
    }

    function renderBackdrop() {
      // camadas que ficam atrás dos organismos
      for (const e of W.events) {
        const k = clamp(Math.min(e.t, e.dur - e.t) / 3000, 0, 1);
        if (e.type === 'aurora') {
          ctx.globalCompositeOperation = 'source-over';
          const bands = 3;
          for (let b = 0; b < bands; b++) {
            const yy = W.h * (0.1 + b * 0.12);
            const grad = ctx.createLinearGradient(0, yy - 80, 0, yy + 120);
            const hue = [pal.h0, pal.h1, pal.h2][b % 3];
            grad.addColorStop(0, hsla(hue, pal.sat, pal.light, 0));
            grad.addColorStop(0.5, hsla(hue, pal.sat, pal.light, 0.10 * k));
            grad.addColorStop(1, hsla(hue, pal.sat, pal.light, 0));
            ctx.fillStyle = grad;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(0, yy);
            for (let x = 0; x <= W.w; x += 40) {
              ctx.lineTo(x, yy + Math.sin(x * 0.01 + W.now * 0.0006 + b) * 40 + n2(x * 0.002, W.now * 0.0003 + b) * 30);
            }
            ctx.lineTo(W.w, yy + 200); ctx.lineTo(0, yy + 200); ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        } else if (e.type === 'mandala') {
          ctx.globalCompositeOperation = 'source-over';
          ctx.save();
          ctx.translate(W.w / 2, W.h / 2);
          ctx.rotate(e.rot + W.now * 0.00008);
          const R = W.min * 0.42 * smooth(k);
          ctx.strokeStyle = hsla(pal.h1, pal.sat, pal.light, 0.10 * k);
          ctx.lineWidth = 1;
          const rings = 6;
          for (let r = 1; r <= rings; r++) {
            const rr = (R / rings) * r;
            ctx.beginPath();
            for (let s = 0; s <= e.sides; s++) {
              const aa = (s / e.sides) * TAU;
              const px = Math.cos(aa) * rr, py = Math.sin(aa) * rr;
              if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
          }
          for (let s = 0; s < e.sides; s++) {
            const aa = (s / e.sides) * TAU;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(aa) * R, Math.sin(aa) * R);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    function renderForeground() {
      for (const e of W.events) {
        const k = clamp(Math.min(e.t, e.dur - e.t) / 3000, 0, 1);
        if (e.type === 'meteor') {
          ctx.globalCompositeOperation = 'lighter';
          ctx.lineCap = 'round';
          for (let i = 0; i < e.trail.length - 2; i += 2) {
            const a = i / e.trail.length;
            ctx.strokeStyle = hsla(e.hue, pal.sat, pal.light + 10, a * 0.6);
            ctx.lineWidth = a * 2.4;
            ctx.beginPath();
            ctx.moveTo(e.trail[i], e.trail[i + 1]);
            ctx.lineTo(e.trail[i + 2], e.trail[i + 3]);
            ctx.stroke();
          }
          ctx.fillStyle = hsla(e.hue, pal.sat, pal.light + 20, 0.9);
          ctx.beginPath(); ctx.arc(e.x, e.y, 2.4, 0, TAU); ctx.fill();
        } else if (e.type === 'ghost') {
          ctx.globalCompositeOperation = 'lighter';
          const pr = 6 + Math.sin(W.now * 0.004) * 2;
          ctx.fillStyle = hsla(e.hue, pal.sat, pal.light + 10, 0.10 * k);
          ctx.beginPath(); ctx.arc(e.x, e.y, pr * 3, 0, TAU); ctx.fill();
          ctx.fillStyle = hsla(e.hue, pal.sat, pal.light + 20, 0.3 * k);
          ctx.beginPath(); ctx.arc(e.x, e.y, pr, 0, TAU); ctx.fill();
        } else if (e.type === 'eclipse') {
          // escurece tudo, com um anel de luz
          ctx.globalCompositeOperation = 'source-over';
          const cx = W.w * 0.5, cy = W.h * 0.42;
          const R = W.min * 0.22;
          const veil = 0.72 * k;
          const grad = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, Math.max(W.w, W.h));
          grad.addColorStop(0, `rgba(2,3,8,${veil})`);
          grad.addColorStop(0.4, `rgba(2,3,8,${veil * 0.7})`);
          grad.addColorStop(1, `rgba(2,3,8,0)`);
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, W.w, W.h);
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = hsla(pal.h2, pal.sat, 78, 0.6 * k);
          ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
          ctx.strokeStyle = hsla(pal.h2, pal.sat, 85, 0.18 * k);
          ctx.lineWidth = 10;
          ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
        }
      }
    }

    function active(type) { return W.events.some((e) => e.type === type); }

    return { maybeSpawn, update, renderBackdrop, renderForeground, active, spawn };
  })();

  // ================================================================ CLIMA
  const RAIN = [];
  function ensureRain() {
    const want = (W.climate === 'chuva' || W.climate === 'tempestade')
      ? Math.round(W.w / 6) : 0;
    while (RAIN.length < want) {
      RAIN.push({ x: rand(W.w), y: rand(W.h), len: rand(8, 22), sp: rand(9, 18) });
    }
    if (RAIN.length > want) RAIN.length = want;
  }
  function updateWeather(dt) {
    ensureRain();
    const sec = dt / 1000;
    const slant = W.wind.x * 0.5 + (W.climate === 'tempestade' ? 2 : 0.5);
    for (const d of RAIN) {
      d.y += d.sp * sec * 60;
      d.x += slant * sec * 60;
      if (d.y > W.h) { d.y = -10; d.x = rand(W.w); }
      if (d.x > W.w) d.x -= W.w; else if (d.x < 0) d.x += W.w;
    }
    // relâmpagos durante tempestade
    if (W.climate === 'tempestade' && Math.random() < dt / 4500) {
      W.flash = 1;
      W.shake = reduceMotion ? 0 : Math.max(W.shake, 6);
      Audio.thunder();
    }
    W.flash = Math.max(0, W.flash - sec * 3.2);
    W.shake = Math.max(0, W.shake - sec * 14);
  }
  function renderWeather() {
    if (RAIN.length) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1;
      ctx.strokeStyle = hsla(pal.h1, 40, 80, 0.10);
      const slant = W.wind.x * 0.5 + (W.climate === 'tempestade' ? 2 : 0.5);
      ctx.beginPath();
      for (const d of RAIN) {
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - slant * 1.2, d.y - d.len);
      }
      ctx.stroke();
    }
    // névoa: véu suave
    if (pal.veil > 0.005) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = hsla(pal.bgH, pal.bgS, pal.bgL + 26, pal.veil);
      ctx.fillRect(0, 0, W.w, W.h);
    }
    // relâmpago
    if (W.flash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(150,160,210,${W.flash * 0.35})`;
      ctx.fillRect(0, 0, W.w, W.h);
    }
  }

  // =========================================================== INTERPRETE
  let wasDream = false;
  function updateMood(dt) {
    // hora local → sonho de madrugada
    const hour = new Date().getHours();
    const nightDream = hour >= 0 && hour < 6;
    // raríssimo "sonho acordado" em momentos de calma profunda
    if (!W.dream && !nightDream && W.arousal < 0.2 && Math.random() < dt / 600000) W.dream = true;
    // o sonho persiste enquanto houver calma
    W.dream = nightDream || (W.dream && W.arousal < 0.35);
    if (W.dream && !wasDream) showWhisper('sonho', 7000);
    wasDream = W.dream;

    // evolução lenta da paleta + decaimentos transitórios (menos repetitivo)
    W.hueDrift = Math.sin(W.now * 0.00002) * 20 + Math.sin(W.now * 0.000071) * 10;
    W.hueShift *= Math.pow(0.2, dt / 1000);
    W.breath *= Math.pow(0.12, dt / 1000);
    W.bioPulse *= Math.pow(0.012, dt / 1000);
    if (!W.pDown) W.dragField.active = false;

    // idle
    W.idle += dt;

    // o ponteiro perde "velocidade" quando não há movimento (só onMove a reaviva)
    const vDecay = 1 - Math.pow(0.0015, dt / 1000);
    W.speed = lerp(W.speed, 0, vDecay);
    W.pvx = lerp(W.pvx, 0, vDecay);
    W.pvy = lerp(W.pvy, 0, vDecay);

    // energia de curto prazo a partir da velocidade do ponteiro
    const energyTarget = clamp(W.speed / 22, 0, 1);
    W.energy = lerp(W.energy, energyTarget, 1 - Math.pow(0.001, dt / 1000));
    // o ponteiro parado relaxa o sistema
    if (W.idle > 1500) W.energy *= Math.pow(0.6, dt / 1000);

    // excitação de longo prazo (a "personalidade" que persiste)
    let aTarget = W.energy;
    if (W.bio.active) {
      // a frequência cardíaca define um "humor de base"; o movimento corporal agita
      const bioFloor = lerp(0.10, 0.95, W.bio.hrNorm) + W.bio.accMag * 0.35;
      aTarget = clamp(Math.max(aTarget, bioFloor), 0, 1);
    }
    const rate = aTarget > W.arousal ? 0.6 : 0.12; // sobe rápido, desce devagar
    W.arousal += (aTarget - W.arousal) * (1 - Math.pow(1 - rate, dt / 1000));
    W.arousal = clamp(W.arousal, 0, 1);

    // hesitação relaxa para zero
    W.jitter *= Math.pow(0.4, dt / 1000);

    // tempo desacelera na calma (sensação meditativa)
    const tsTarget = lerp(0.6, 1.15, clamp(W.arousal * 1.4, 0, 1));
    W.timeScale = lerp(W.timeScale, tsTarget, 1 - Math.pow(0.2, dt / 1000));

    // escolha de clima com histerese
    W.climateHold -= dt;
    if (W.climateHold <= 0) {
      let next;
      if (W.arousal >= 0.72) next = 'tempestade';
      else if (W.arousal >= 0.46) next = 'chuva';
      else if (W.pDown && W.speed > 4) next = 'vento';
      else if (W.arousal >= 0.24) next = 'vento';
      else if (W.jitter > 1.2) next = 'névoa';
      else next = 'calmaria';
      // aurora como estado especial de profunda calma
      if (next === 'calmaria' && Events.active('aurora')) next = 'aurora';
      if (next !== W.climate) {
        W.climate = next;
        W.climateHold = 2500; // evita oscilação
        announceClimate(next);
      } else {
        W.climateHold = 1200;
      }
    }

    // vento decai
    W.wind.x *= Math.pow(0.05, dt / 1000);
    W.wind.y *= Math.pow(0.05, dt / 1000);
    // movimento corporal (acelerômetro) sopra o ambiente
    if (W.bio.active && W.bio.accMag > 0.015) {
      const ang = W.now * 0.0013;
      W.wind.x += Math.cos(ang) * W.bio.accMag * 1.1;
      W.wind.y += Math.sin(ang) * W.bio.accMag * 1.1;
    }

    // recompensa da contemplação: ficar em calma profunda revela algo sereno
    if (W.arousal < 0.18 && W.idle > 4000 && !W.pDown) {
      W.idleCalm += dt;
      if (W.idleCalm > 22000) {
        W.idleCalm = -30000; // descanso antes de repetir
        if (W.garden.length > 1 && Math.random() < 0.5) Events.spawn('bloom', { dur: 9000 });
        else Events.spawn('aurora', { dur: 24000 });
        showWhisper('quietude', 6000);
      }
    } else {
      W.idleCalm = Math.max(0, W.idleCalm - dt * 0.5);
    }

    Audio.setMood(W.energy, W.arousal, W.dream);
  }

  // ============================================================ BACKDROP
  function drawBackground() {
    // fade com motion-blur (rastros vivos)
    ctx.globalCompositeOperation = 'source-over';
    if (W.repaint) {
      ctx.fillStyle = hsla(pal.bgH, pal.bgS, pal.bgL, 1);
      ctx.fillRect(0, 0, W.w, W.h);
      W.repaint = false;
    } else {
      ctx.fillStyle = hsla(pal.bgH, pal.bgS, pal.bgL, pal.fade);
      ctx.fillRect(0, 0, W.w, W.h);
    }
    // brilho de fundo lento (campo de luz) — source-over para não saturar com o tempo
    ctx.globalCompositeOperation = 'source-over';
    const gx = W.w * (0.5 + 0.35 * Math.sin(W.now * 0.00006));
    const gy = W.h * (0.45 + 0.3 * Math.cos(W.now * 0.00005));
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, W.min * 0.7);
    grad.addColorStop(0, hsla(pal.h0, pal.sat, pal.light, 0.05));
    grad.addColorStop(1, hsla(pal.h0, pal.sat, pal.light, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W.w, W.h);
    // batimento cardíaco: pulsa de leve a partir do ponto da última batida
    if (W.bioPulse > 0.01) {
      const cx = W.bioPulseX, cy = W.bioPulseY;
      const rr = W.min * (0.2 + 0.4 * (1 - W.bioPulse));
      const gg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
      gg.addColorStop(0, hsla(pal.h0, pal.sat, pal.light + 10, 0.12 * W.bioPulse));
      gg.addColorStop(1, hsla(pal.h0, pal.sat, pal.light, 0));
      ctx.fillStyle = gg;
      ctx.fillRect(0, 0, W.w, W.h);
    }
  }

  function renderCharge() {
    if (!W.charge.active) return;
    // source-over: cresce sem saturar enquanto segura
    ctx.globalCompositeOperation = 'source-over';
    const p = W.charge.t;
    const r = lerp(10, 62, p) * (1 + 0.1 * Math.sin(W.now * 0.02));
    const hue = accentHue(0);
    const g = ctx.createRadialGradient(W.charge.x, W.charge.y, 0, W.charge.x, W.charge.y, r);
    g.addColorStop(0, hsla(hue, pal.sat, pal.light + 14, 0.5));
    g.addColorStop(0.5, hsla(hue, pal.sat, pal.light, 0.18));
    g.addColorStop(1, hsla(hue, pal.sat, pal.light, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(W.charge.x, W.charge.y, r, 0, TAU); ctx.fill();
  }

  function drawCursorGlow() {
    if (!W.pActive) return;
    // source-over + raio limitado: nunca acumula nem satura, mesmo parado
    ctx.globalCompositeOperation = 'source-over';
    const pulse = 1 + 0.15 * Math.sin(W.now * 0.004);
    const move = clamp(W.speed / 9, 0, 1);
    const r = clamp(9 + W.speed * 0.5, 9, 44) * pulse;
    const grad = ctx.createRadialGradient(W.px, W.py, 0, W.px, W.py, r);
    const hue = pal.h0;
    grad.addColorStop(0, hsla(hue, pal.sat, pal.light + 16, 0.06 + 0.5 * move));
    grad.addColorStop(0.5, hsla(hue, pal.sat, pal.light, 0.02 + 0.14 * move));
    grad.addColorStop(1, hsla(hue, pal.sat, pal.light, 0));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(W.px, W.py, r, 0, TAU); ctx.fill();
  }

  // ============================================================ SUSSURROS
  const whisperEl = document.getElementById('whisper');
  let whisperTimer = null;
  function showWhisper(text, hold) {
    whisperEl.textContent = text;
    whisperEl.classList.add('show');
    whisperEl.style.color = hsla(pal.h1, 50, 70, 0.5);
    clearTimeout(whisperTimer);
    whisperTimer = setTimeout(() => whisperEl.classList.remove('show'), hold || 5200);
  }
  const CLIMATE_WORDS = {
    'calmaria': 'calmaria', 'névoa': 'névoa', 'vento': 'vento',
    'chuva': 'chuva', 'tempestade': 'tempestade', 'aurora': 'aurora',
  };
  function announceClimate(name) {
    if (W.dream) return; // o sonho tem suas próprias palavras
    if (CLIMATE_WORDS[name]) showWhisper(CLIMATE_WORDS[name]);
  }
  const EVENT_WORDS = {
    eclipse: 'eclipse', mandala: 'um padrão se abre', bloom: 'floração',
    aurora: 'aurora', rare: 'algo raro atravessa', meteor: '',
  };
  function announceEvent(type) {
    const w = EVENT_WORDS[type];
    if (w) showWhisper(w, 6500);
  }

  // ===================================================== TOQUES (efeitos)
  function bloomNearby(x, y, radius) {
    radius = radius || W.min * 0.28;
    const r2 = radius * radius;
    for (const p of W.garden) {
      if (dist2(p.nx * W.w, p.ny * W.h, x, y) < r2) p.plantedWall -= 45000;
    }
  }

  const TAP_PRIMARIES = ['semente', 'semente', 'semente', 'estrela', 'pulso', 'eco', 'broto', 'cardume', 'galaxia'];
  function tapEffect(x, y) {
    const hue = Math.random() < 0.25 ? rareHue() : accentHue((Math.random() * 3) | 0);
    switch (pick(TAP_PRIMARIES)) {
      case 'galaxia':
        addVortex(x, y, Math.random() < 0.5 ? 1 : -1, hue);
        break;
      case 'semente':
        plantSeed(x, y);
        break;
      case 'broto':
        plantSeed(x, y);
        bloomNearby(x, y, W.min * 0.2);
        spawnBurst(x, y, 10, { hue, spMax: 3, lifeMax: 1400 });
        break;
      case 'estrela':
        spawnBurst(x, y, 18 + (Math.random() * 16 | 0), { hue, spMin: 2, spMax: 7, sizeMax: 2.8 });
        addPulse(x, y, -1.0, W.min * 0.18, hue);
        addRipple(x, y, 0.8, hue, 2.6);
        break;
      case 'pulso':
        addPulse(x, y, 1.4, W.min * 0.30, hue);
        addRipple(x, y, 0.6, hue, 1.2);
        addRipple(x, y, 1.0, hue, 0.9);
        break;
      case 'eco':
        for (let i = 0; i < 3; i++) addRipple(x, y, 0.6 + i * 0.3, hue + i * 12, 0.8 + i * 0.5);
        break;
      case 'cardume':
        for (let i = 0; i < 10; i++) {
          if (W.particles.length < 360) W.particles.push(spawnParticle(x + rand(-20, 20), y + rand(-20, 20)));
        }
        spawnBurst(x, y, 8, { hue });
        break;
    }
    // efeitos secundários que se combinam aleatoriamente
    if (Math.random() < 0.40) spawnBurst(x, y, 6 + (Math.random() * 8 | 0), { hue: rareHue(), spMax: 5, lifeMax: 1200 });
    if (Math.random() < 0.35) addPulse(x, y, Math.random() < 0.5 ? 0.8 : -0.8, W.min * 0.2, hue);
    if (Math.random() < 0.30) W.hueShift = clamp(W.hueShift + rand(-40, 40), -60, 60);
    if (Math.random() < 0.22) W.breath = clamp(W.breath + 0.4, 0, 0.55);
    if (Math.random() < 0.30) addRipple(x, y, 0.5, rareHue(), rand(0.8, 2.4));
    // a linha às vezes reage ao toque (ou não)
    if (Math.random() < 0.45) scopeGlitch(rand(0.3, 0.9));
    else if (Math.random() < 0.18) scopeExplode();
    tapSound(x, y);
  }

  function tapSound(x, y) {
    const deg = Math.round(map(x, 0, W.w, 0, 7));
    const oct = Math.round(map(y, 0, W.h, 2, -1));
    const base = deg + oct * (W.dream ? 6 : 5);
    const vel = rand(0.3, 0.7);
    const kind = Math.random();
    if (kind < 0.4) {
      Audio.piano(base, vel, rand(2.6, 4.2));
    } else if (kind < 0.62) {
      Audio.piano(base, vel, 3.4);
      setTimeout(() => Audio.piano(base + pick([2, 3, 4]), vel * 0.8, 3.0), rand(40, 120));
    } else if (kind < 0.84) {
      const up = Math.random() < 0.5 ? 1 : -1;
      Audio.arp([base, base + 2 * up, base + 4 * up], vel * 0.8, rand(90, 150));
    } else {
      Audio.chord([base, base + 2, base + 4], vel * 0.7);
    }
  }

  // um ser nasce onde você toca duas vezes
  function birthCreature(x, y) {
    const c = spawnCreature(false);
    for (const seg of c.body) { seg.x = x; seg.y = y; }
    c.born = W.now; c.life = 0;
    W.creatures.push(c);
    spawnBurst(x, y, 14, { hue: c.hue, spMax: 4, lifeMax: 1500 });
    addRipple(x, y, 0.8, c.hue, 1.6);
    Audio.arp([0, 4, 7], 0.32, 90);
  }

  // segurar carrega energia; ao soltar, libera uma explosão proporcional
  function chargeRelease(x, y, power) {
    const hue = accentHue((Math.random() * 3) | 0);
    const n = Math.round(lerp(14, 70, power));
    spawnBurst(x, y, n, { hue, spMin: 1, spMax: 3 + power * 9, sizeMax: 2.4 + power * 2, lifeMax: 1400 + power * 1800 });
    addPulse(x, y, -1.2 - power * 1.6, W.min * (0.2 + power * 0.4), hue);
    for (let i = 0; i < 2 + (power * 3 | 0); i++) addRipple(x, y, 0.6 + power, hue + i * 14, 1 + i * 0.6);
    if (power > 0.7) { plantSeed(x, y); bloomNearby(x, y, W.min * 0.3); }
    Audio.chord([0, 4, 7, 11, 14], 0.12 + power * 0.1);
    W.arousal = clamp(W.arousal + power * 0.2, 0, 1);
  }

  // ----------------------------------------------------- biossensor (Polar)
  function onHeartbeat() {
    // cada batida pulsa num ponto diferente da tela
    const cx = rand(W.w * 0.12, W.w * 0.88), cy = rand(W.h * 0.14, W.h * 0.86);
    const hue = accentHue(0);
    addPulse(cx, cy, -0.7, W.min * 0.55, hue);
    addRipple(cx, cy, 1.3, hue, 1.3);
    W.bioPulse = 1;
    W.bioPulseX = cx; W.bioPulseY = cy;
    scopeBeat();
    Audio.heartbeat(0.3 + W.bio.hrNorm * 0.4);
  }
  function pollBio() {
    const B = window.Bio;
    if (!B || !B.data || !B.data.connected) { W.bio.active = false; W.bio.beating = false; return; }
    const d = B.data;
    W.bio.active = true;
    // só há ECG/batimento se chegou batida há pouco (strap removido → para)
    W.bio.beating = (W.now - (d.lastBeatAt || 0)) < 6000;
    W.bio.hr = d.hr || 0;
    W.bio.hrNorm = clamp((W.bio.hr - 55) / (150 - 55), 0, 1);
    W.bio.hrv = d.hrv || 0;
    W.bio.accMag = lerp(W.bio.accMag, d.accMag || 0, 0.2);
    W.bio.gyroMag = lerp(W.bio.gyroMag, d.gyroMag || 0, 0.2);
    W.bio.gyroZ = lerp(W.bio.gyroZ, d.gyroZ || 0, 0.2);
    if (d.beats - W.bio._seen > 6) W.bio._seen = d.beats - 1;
    while (W.bio._seen < d.beats) { W.bio._seen++; onHeartbeat(); }
  }

  // long-press: acompanha o carregamento enquanto o dedo fica parado
  function updateCharge() {
    if (W.pDown && W.dragDist < 16) {
      const held = W.now - W.downTime;
      if (held > 450) {
        W.charge.active = true;
        W.charge.x = W.px; W.charge.y = W.py;
        W.charge.t = clamp((held - 450) / 2500, 0, 1);
        if (Math.random() < 0.5) {
          const ang = rand(TAU), r = lerp(70, 14, W.charge.t);
          spawnBurst(W.charge.x + Math.cos(ang) * r, W.charge.y + Math.sin(ang) * r, 1,
            { hue: accentHue(0), dir: ang + Math.PI, spread: 0.2, spMin: 0.6, spMax: 1.6, lifeMax: 700 });
        }
      }
    }
  }

  const DRAG_MODES = ['corrente', 'vortice', 'atrair', 'espalhar', 'tinta'];
  const DRAG_SECONDARIES = ['faiscar', 'plantar', 'cantar', 'cor', null, null];

  // ============================================================== INPUT
  function onMove(x, y) {
    W.ppx = W.px === -9999 ? x : W.px;
    W.ppy = W.py === -9999 ? y : W.py;
    W.px = x; W.py = y; W.pActive = true;
    const ndx = x - W.ppx, ndy = y - W.ppy;
    W.pvx = lerp(W.pvx, ndx, 0.4);
    W.pvy = lerp(W.pvy, ndy, 0.4);
    const inst = Math.hypot(ndx, ndy);
    W.speed = lerp(W.speed, inst, 0.5);
    // hesitação: mudanças de direção
    const sign = Math.sign(ndx);
    if (sign !== 0 && sign !== W.lastSign) { W.jitter += 0.4; W.lastSign = sign; }
    W.idle = 0; W.lastMove = W.now;

    if (W.pDown && W.drag) {
      // arraste: cada modo molda o mundo de forma diferente
      W.dragDist += inst;
      const d = W.drag;
      // acumula curvatura para detectar um gesto circular (→ galáxia)
      if (inst > 1.5) {
        const dir = Math.atan2(ndy, ndx);
        if (d.lastDir != null) {
          let da = dir - d.lastDir;
          while (da > Math.PI) da -= TAU;
          while (da < -Math.PI) da += TAU;
          d.turn += da;
        }
        d.lastDir = dir;
        d.cx += x; d.cy += y; d.n++;
      }
      W.dragField.active = true;
      W.dragField.x = x; W.dragField.y = y;
      W.dragField.vx = W.pvx; W.dragField.vy = W.pvy;
      W.dragField.strength = clamp(W.dragField.strength + 0.08, 0, 1);
      // vento global suave (criaturas e ambiente também sentem)
      W.wind.x = clamp(W.wind.x + ndx * 0.03, -7, 7);
      W.wind.y = clamp(W.wind.y + ndy * 0.03, -7, 7);
      Audio.dragMove(true, x);

      // rastro orgânico conforme o modo
      if (d.mode === 'tinta' && inst > 1) {
        spawnBurst(x, y, 2, { hue: d.hue, spMin: 0.2, spMax: 1.2, drag: 0.9, lifeMin: 1400, lifeMax: 3200, sizeMax: 2.2 });
      } else if (inst > 4 && Math.random() < 0.25) {
        spawnBurst(x, y, 2, { hue: d.hue, dir: Math.atan2(ndy, ndx) + Math.PI, spread: 0.5, spMax: 3 });
      }
      // efeito secundário do arraste (combina com o primário)
      if (d.secondary === 'faiscar' && inst > 2 && Math.random() < 0.3) {
        spawnBurst(x, y, 3, { hue: rareHue(), spMax: 4, lifeMax: 1000 });
      } else if (d.secondary === 'plantar' && W.now - d.inkAt > 900 && W.garden.length < MAX_PLANTS && inst > 1) {
        d.inkAt = W.now;
        if (Math.random() < 0.5) { plantSeed(x, y); Audio.piano(Math.round(map(y, 0, W.h, 8, 0)), 0.12, 2.8); }
      } else if (d.secondary === 'cantar' && W.now - d.noteAt > 220 && inst > 2) {
        d.noteAt = W.now; Audio.piano(Math.round(map(y, 0, W.h, 7, -2)), rand(0.12, 0.3), 2.2);
      } else if (d.secondary === 'cor' && inst > 2 && Math.random() < 0.2) {
        spawnBurst(x, y, 2, { hue: rareHue(), spMax: 2, lifeMax: 1600 });
      }
      if (inst > 3 && Math.random() < 0.15) addRipple(x, y, 0.3, d.hue, 2.2);
      if (inst > 12 && Math.random() < 0.08) scopeGlitch(rand(0.3, 0.8));
    }
    dismissInvite();
  }
  function onDown(x, y) {
    W.pDown = true; W.pActive = true;
    W.px = x; W.py = y; W.idle = 0;
    W.downX = x; W.downY = y; W.dragDist = 0; W.downTime = W.now;
    Audio.start();
    // escolhe um "modo" de arraste aleatório a cada gesto
    W.drag = {
      mode: pick(DRAG_MODES),
      swirl: Math.random() < 0.5 ? 1 : -1,
      hue: Math.random() < 0.3 ? rareHue() : accentHue((Math.random() * 3) | 0),
      secondary: pick(DRAG_SECONDARIES),
      noteAt: 0, inkAt: 0,
      turn: 0, lastDir: null, cx: 0, cy: 0, n: 0,
    };
    W.dragField.mode = W.drag.mode;
    W.dragField.swirl = W.drag.swirl;
    W.dragField.strength = 0;
    // movimento agressivo → caos
    if (W.speed > 16) W.arousal = clamp(W.arousal + 0.15, 0, 1);
    dismissInvite();
  }
  function onUp() {
    const d = W.drag;
    if (W.charge.active) {
      // soltou após segurar → explosão proporcional
      chargeRelease(W.px, W.py, W.charge.t);
      W.charge.active = false;
    } else if (W.pDown && W.dragDist < 14 && W.now - W.lastClick > 120) {
      // toque curto → efeito; toque duplo → nasce um ser
      const dbl = (W.now - W.lastTapAt < 360) && Math.hypot(W.px - W.lastTapX, W.py - W.lastTapY) < 60;
      if (dbl) { birthCreature(W.px, W.py); W.lastTapAt = 0; }
      else { tapEffect(W.px, W.py); W.lastTapAt = W.now; W.lastTapX = W.px; W.lastTapY = W.py; }
      W.lastClick = W.now;
    } else if (d && d.n > 4 && Math.abs(d.turn) > 5.0 && W.dragDist > W.min * 0.3) {
      // gesto circular → uma pequena galáxia nasce no centro
      addVortex(d.cx / d.n, d.cy / d.n, Math.sign(d.turn) || 1);
    }
    W.pDown = false;
    W.charge.active = false;
    W.dragField.active = false;
    W.drag = null;
    Audio.dragMove(false, W.px);
  }

  function attachInput() {
    canvas.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', () => { W.pActive = false; W.pDown = false; W.charge.active = false; W.dragField.active = false; W.drag = null; Audio.dragMove(false, W.px); });
    const bioBtn = document.getElementById('bio-btn');
    if (bioBtn) bioBtn.addEventListener('click', () => Audio.start());

    canvas.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; onDown(t.clientX, t.clientY);
    }, { passive: true });
    canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0]; onMove(t.clientX, t.clientY);
    }, { passive: true });
    canvas.addEventListener('touchend', () => { onUp(); W.pActive = false; }, { passive: true });

    // som
    const soundBtn = document.getElementById('sound');
    soundBtn.classList.toggle('muted', false);
    soundBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Audio.start();
      const m = Audio.toggleMute();
      soundBtn.classList.toggle('muted', m);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'm' || e.key === 'M') {
        Audio.start();
        const m = Audio.toggleMute();
        soundBtn.classList.toggle('muted', m);
      }
    });
  }

  // convite inicial
  const inviteEl = document.getElementById('invite');
  let inviteDismissed = false;
  function dismissInvite() {
    if (inviteDismissed) return;
    inviteDismissed = true;
    inviteEl.classList.add('gone');
    setTimeout(() => { if (inviteEl.parentNode) inviteEl.parentNode.removeChild(inviteEl); }, 2800);
  }

  // ================================================================ LOOP
  let last = 0;
  function frame(ts) {
    if (!W.startTs) W.startTs = ts;
    const rawDt = Math.min(50, ts - last || 16);
    last = ts;
    W.now = ts;

    // --- atualização ---
    pollBio();
    updateCharge();
    updateMood(rawDt);
    updatePalette(rawDt);
    const dt = rawDt * W.timeScale * (1 - W.breath);
    updateParticles(dt);
    updateCreatures(dt);
    updateRipples(dt);
    updateSparks(dt);
    updatePulses(dt);
    updateVortices(dt);
    updateScope(dt);
    Events.update(dt);
    Events.maybeSpawn(rawDt);
    updateWeather(dt);

    // --- render ---
    ctx.save();
    if (W.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * W.shake, (Math.random() - 0.5) * W.shake);
    }
    drawBackground();
    renderScope();
    Events.renderBackdrop();
    renderVortices();
    renderGarden();
    renderParticles();
    renderSparks();
    renderCreatures();
    renderRipples();
    renderPulses();
    Events.renderForeground();
    renderCharge();
    drawCursorGlow();
    renderWeather();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.restore();

    // ambiente sonoro generativo: notas esparsas de "piano distante"
    ambientAudio(rawDt);

    requestAnimationFrame(frame);
  }

  let nextPad = 4000;
  function ambientAudio(dt) {
    if (!Audio.started || Audio.muted) return;
    nextPad -= dt;
    if (nextPad <= 0) {
      // piano distante: notas esparsas, mais espaço na calma
      nextPad = lerp(11000, 3500, W.arousal) + rand(-1000, 2500);
      const oct = Math.random() < 0.5 ? 0 : 1;
      const i = ((Math.random() * 5) | 0) + oct * (W.dream ? 6 : 5);
      if (Math.random() < 0.25) {
        Audio.arp([i, i + 2, i + 4], 0.12, rand(160, 260));
      } else {
        Audio.piano(i, lerp(0.08, 0.16, W.arousal), lerp(4.2, 2.6, W.arousal));
      }
    }
  }

  // ================================================================ INIT
  function init() {
    resize();
    W.sessionHue = rand(-40, 40); // cada visita tem sua própria cor
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) saveMem();
    });
    window.addEventListener('pagehide', saveMem);
    window.addEventListener('beforeunload', saveMem);
    setInterval(saveMem, 15000);

    rebalanceParticles();
    initCreatures();

    // o mundo já estava vivo: simula um passado breve para não "começar do zero"
    for (let i = 0; i < 120; i++) updateParticles(16);

    attachInput();
    Audio.init(); // prepara (suspenso até o primeiro gesto)
    Audio.setMood(W.energy, W.arousal, W.dream);

    // convite suave
    setTimeout(() => inviteEl.classList.add('show'), 600);
    setTimeout(() => { if (!inviteDismissed) dismissInvite(); }, 9000);

    // boas-vindas de retorno
    if (returning) {
      const msg = sinceLast > 36e5 ? 'você voltou' : 'continuamos de onde paramos';
      setTimeout(() => showWhisper(msg, 6000), 2200);
    }

    // ritual de chegada: a cada visita, algo novo começa a existir
    setTimeout(() => {
      const ax = rand(W.w * 0.2, W.w * 0.8), ay = rand(W.h * 0.32, W.h * 0.72);
      plantSeed(ax, ay);
      addRipple(ax, ay, 1.2, accentHue(0), 1.2);
      if (Math.random() < 0.6) {
        birthCreature(rand(W.w * 0.3, W.w * 0.7), rand(W.h * 0.3, W.h * 0.7));
      } else {
        Events.spawn('aurora', { dur: 18000 });
      }
      setTimeout(() => showWhisper(returning ? 'algo novo nasce' : 'bem-vindo', 6000), 1200);
    }, 3200);

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
