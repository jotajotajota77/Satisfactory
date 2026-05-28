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
  if (typeof mem.seed !== 'number') mem.seed = (Math.random() * 0xffffffff) >>> 0;
  if (typeof mem.visits !== 'number') mem.visits = 0;
  if (typeof mem.arousalBase !== 'number') mem.arousalBase = 0.18;
  if (!Array.isArray(mem.garden)) mem.garden = [];
  const returning = mem.visits > 0;
  mem.visits += 1;
  const sinceLast = mem.lastVisit ? Date.now() - mem.lastVisit : 0;
  mem.lastVisit = Date.now();

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
  const field = Noise.create(mem.seed);
  const n2 = field.noise2D;
  const n3 = field.noise3D;
  const rngVisit = Noise.mulberry32(mem.seed ^ 0x9e3779b9);

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
    // coleções
    particles: [],
    creatures: [],
    garden: [],
    events: [],
    ripples: [],
    links: [],
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
    return arr[(seed | 0) % 3] + Math.sin(seed) * 8;
  }

  // ============================================================== ÁUDIO
  const Audio = (function () {
    let ctxA = null, master = null, wet = null, drone = null, droneFilter = null;
    let oscs = [], lfo = null, lfoGain = null, dragOsc = null, dragGain = null, dragFilter = null;
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

        // drone evolutivo
        droneFilter = ctxA.createBiquadFilter();
        droneFilter.type = 'lowpass';
        droneFilter.frequency.value = 480;
        droneFilter.Q.value = 6;
        drone = ctxA.createGain(); drone.gain.value = 0.0;
        droneFilter.connect(drone); drone.connect(master); drone.connect(verb);

        const detunes = [-7, 0, 5];
        for (let i = 0; i < 3; i++) {
          const o = ctxA.createOscillator();
          o.type = i === 0 ? 'sine' : 'triangle';
          o.frequency.value = root / (i === 2 ? 1 : 2);
          o.detune.value = detunes[i];
          o.connect(droneFilter);
          o.start();
          oscs.push(o);
        }
        lfo = ctxA.createOscillator(); lfo.frequency.value = 0.05;
        lfoGain = ctxA.createGain(); lfoGain.gain.value = 280;
        lfo.connect(lfoGain); lfoGain.connect(droneFilter.frequency); lfo.start();

        // voz de arraste (drone que segue o gesto)
        dragOsc = ctxA.createOscillator(); dragOsc.type = 'sawtooth'; dragOsc.frequency.value = root;
        dragFilter = ctxA.createBiquadFilter(); dragFilter.type = 'lowpass'; dragFilter.frequency.value = 700; dragFilter.Q.value = 8;
        dragGain = ctxA.createGain(); dragGain.gain.value = 0;
        dragOsc.connect(dragFilter); dragFilter.connect(dragGain); dragGain.connect(master); dragGain.connect(verb);
        dragOsc.start();

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
      drone.gain.linearRampToValueAtTime(0.12, now + 6);
    }

    function noteFreq(i) {
      const len = scale.length;
      const oct = Math.floor(i / len);
      let idx = ((i % len) + len) % len;
      const semi = scale[idx] + 12 * oct;
      return root * Math.pow(2, semi / 12);
    }

    function pluck(i, gain, dur, type) {
      if (!started || !ctxA || muted) return;
      const now = ctxA.currentTime;
      const o = ctxA.createOscillator();
      o.type = type || 'triangle';
      o.frequency.value = (typeof i === 'number' && i > 30) ? i : noteFreq(i);
      const g = ctxA.createGain();
      const peak = (gain || 0.18);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(peak, now + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + (dur || 1.6));
      o.connect(g); g.connect(master); g.connect(Audio.send);
      o.start(now); o.stop(now + (dur || 1.6) + 0.05);
    }

    function chord(indices, gain) {
      if (!started) return;
      indices.forEach((i, k) => setTimeout(() => pluck(i, (gain || 0.1) * (1 - k * 0.12), 2.6, 'sine'), k * 70));
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

    function dragMove(active, x) {
      if (!started || !ctxA) return;
      const now = ctxA.currentTime;
      if (active) {
        const i = Math.round(map(x, 0, W.w, 7, -2));
        dragOsc.frequency.setTargetAtTime(noteFreq(i), now, 0.08);
        dragFilter.frequency.setTargetAtTime(600 + W.speed * 60, now, 0.1);
        dragGain.gain.setTargetAtTime(muted ? 0 : 0.06, now, 0.1);
      } else {
        dragGain.gain.setTargetAtTime(0, now, 0.4);
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
      droneFilter.frequency.setTargetAtTime(360 + arousal * 900, now, 1.5);
      lfo.frequency.setTargetAtTime(0.03 + arousal * 0.25, now, 2);
      wet.gain.setTargetAtTime(0.6 - arousal * 0.3, now, 2);
    }

    function toggleMute() {
      muted = !muted;
      if (started && ctxA) {
        master.gain.setTargetAtTime(muted ? 0 : 0.55, ctxA.currentTime, 0.4);
      }
      return muted;
    }

    return { init, start, pluck, chord, thunder, shimmer, dragMove, setMood, toggleMute,
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

  function spawnParticle(x, y) {
    const r = Math.random();
    let type = TYPE.DRIFT;
    if (r > 0.55 && r <= 0.72) type = TYPE.FOLLOW;
    else if (r > 0.72 && r <= 0.9) type = TYPE.FLEE;
    else if (r > 0.9) type = TYPE.LEARN;
    return {
      x: x === undefined ? rand(W.w) : x,
      y: y === undefined ? rand(W.h) : y,
      vx: rand(-0.2, 0.2), vy: rand(-0.2, 0.2),
      type,
      size: rand(0.8, 2.6),
      hueSeed: (Math.random() * 3) | 0,
      phase: rand(TAU),
      pulse: rand(0.4, 1.4),
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
      // campo de fluxo orgânico
      const ang = n3(a.x * flow, a.y * flow, t * 0.00004) * TAU * 1.6;
      let fx = Math.cos(ang) * 0.04;
      let fy = Math.sin(ang) * 0.04;

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
        Audio.pluck(Math.round(map(cy, 0, W.h, 9, 0)), 0.05, 2.2, 'sine');
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
    // partículas
    for (let p = 0; p < W.particles.length; p++) {
      const a = W.particles[p];
      const pulse = 0.55 + 0.45 * Math.sin(a.phase);
      const hue = accentHue(a.hueSeed) + (a.type === TYPE.FLEE ? 18 : 0);
      const alpha = 0.38 + 0.32 * pulse;
      const r = a.size * (0.8 + 0.5 * pulse);
      ctx.fillStyle = hsla(hue, pal.sat, pal.light, alpha);
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, TAU);
      ctx.fill();
      // halo
      ctx.fillStyle = hsla(hue, pal.sat, pal.light + 8, alpha * 0.10);
      ctx.beginPath();
      ctx.arc(a.x, a.y, r * 3.2, 0, TAU);
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
    const struct = { branches: [], petals: 4 + (rng() * 5 | 0), height: 0.10 + rng() * 0.13 };
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
      hue: accentHue((Math.random() * 3) | 0) + rand(-12, 12),
      plantedWall: Date.now(),
      struct: buildPlantStruct(seed),
    };
    W.garden.push(p);
    if (W.garden.length > MAX_PLANTS) W.garden.shift();
    addRipple(x, y, 1);
    Audio.pluck(Math.round(map(y, 0, W.h, 9, 0)), 0.22, 2.0, 'triangle');
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

      // flor (quando maduro)
      if (g > 0.55) {
        const bloom = smooth(clamp((g - 0.55) / 0.45, 0, 1));
        const fr = H * 0.12 * bloom + lw;
        const petals = p.struct.petals;
        for (let i = 0; i < petals; i++) {
          const aa = (i / petals) * TAU + W.now * 0.0002;
          const px = topX + Math.cos(aa) * fr;
          const py = topY + Math.sin(aa) * fr;
          ctx.fillStyle = hsla(p.hue + 20, pal.sat, pal.light + 6, 0.4 * bloom);
          ctx.beginPath(); ctx.arc(px, py, fr * 0.5, 0, TAU); ctx.fill();
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
  function addRipple(x, y, strength) {
    W.ripples.push({ x, y, r: 2, max: W.min * (0.12 + 0.1 * (strength || 1)), a: 0.5, hue: accentHue(0) });
  }
  function updateRipples(dt) {
    const sec = dt / 1000;
    for (let i = W.ripples.length - 1; i >= 0; i--) {
      const r = W.ripples[i];
      r.r += (r.max - r.r) * 1.6 * sec;
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
    const aTarget = W.energy;
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

    if (W.pDown) {
      // arraste cria correntes de vento/água
      W.dragDist += inst;
      W.wind.x = clamp(W.wind.x + ndx * 0.04, -8, 8);
      W.wind.y = clamp(W.wind.y + ndy * 0.04, -8, 8);
      Audio.dragMove(true, x);
      if (inst > 3 && Math.random() < 0.3) addRipple(x, y, 0.4);
    }
    dismissInvite();
  }
  function onDown(x, y) {
    W.pDown = true; W.pActive = true;
    W.px = x; W.py = y; W.idle = 0;
    W.downX = x; W.downY = y; W.dragDist = 0;
    Audio.start();
    // movimento agressivo → caos
    if (W.speed > 16) W.arousal = clamp(W.arousal + 0.15, 0, 1);
    dismissInvite();
  }
  function onUp() {
    // um toque (pouco movimento) planta uma semente; arrastar apenas cria correntes
    if (W.pDown && W.dragDist < 14 && W.now - W.lastClick > 120) {
      plantSeed(W.px, W.py);
      W.lastClick = W.now;
    }
    W.pDown = false;
    Audio.dragMove(false, W.px);
  }

  function attachInput() {
    canvas.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', () => { W.pActive = false; W.pDown = false; Audio.dragMove(false, W.px); });

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
    updateMood(rawDt);
    updatePalette(rawDt);
    const dt = rawDt * W.timeScale;
    updateParticles(dt);
    updateCreatures(dt);
    updateRipples(dt);
    Events.update(dt);
    Events.maybeSpawn(rawDt);
    updateWeather(dt);

    // --- render ---
    ctx.save();
    if (W.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * W.shake, (Math.random() - 0.5) * W.shake);
    }
    drawBackground();
    Events.renderBackdrop();
    renderGarden();
    renderParticles();
    renderCreatures();
    renderRipples();
    Events.renderForeground();
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
      // mais espaçado na calma, mais denso no caos
      nextPad = lerp(9000, 2500, W.arousal) + rand(-800, 1500);
      const i = (Math.random() * 6 | 0) + (W.dream ? 2 : 0);
      Audio.pluck(i, lerp(0.03, 0.07, W.arousal), lerp(3.2, 1.6, W.arousal), 'sine');
    }
  }

  // ================================================================ INIT
  function init() {
    resize();
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

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
