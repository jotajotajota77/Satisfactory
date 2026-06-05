/* =================================================================
   COMPOSIÇÃO
   O Polar registra 2:30 do seu coração (RRs + amplitude do pico R via
   ECG bruto). Depois eu analiso: FC média, HRV, tendência (sobe/desce),
   frequência respiratória estimada, dinâmica dos R. Tudo isso vira a
   peça: modo, BPM, contorno melódico, tamanho das frases, dinâmica,
   ritmo. Toca no piano e libera download em MIDI (.mid).
   ================================================================= */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  const RECORD_MS = 150000; // 2:30

  // ---- canvas
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // ---- estado
  const STATE = { IDLE: 0, RECORDING: 1, COMPOSING: 2, READY: 3, PLAYING: 4 };
  let state = STATE.IDLE;
  let recordStart = 0;
  let beatPulse = 0;
  let recording = { rrs: [], times: [], hrs: [], amplitudes: [] };
  let composition = null;
  let playbackStart = 0;
  let scheduled = [];

  // ---- áudio
  let ctxA = null, master = null, verbBus = null;
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
    if (ctxA) { if (ctxA.state === 'suspended') ctxA.resume(); return; }
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
  }
  function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  function pianoAt(freq, vel, dur, when) {
    if (!ctxA) return [];
    const t0 = when;
    vel = clamp(vel == null ? 0.5 : vel, 0.02, 1);
    dur = dur || 0.6;
    const lp = ctxA.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1500 + vel * 4200, t0);
    lp.frequency.exponentialRampToValueAtTime(620, t0 + Math.max(0.5, dur * 0.6));
    lp.Q.value = 0.4;
    const bus = ctxA.createGain(); bus.gain.value = 1;
    lp.connect(bus); bus.connect(master); bus.connect(verbBus);
    const partials = [[1, 1.0, 0], [2, 0.4, 0.7], [3, 0.2, 1.8], [4, 0.09, 3.2]];
    const oscs = [];
    for (let pi = 0; pi < partials.length; pi++) {
      const mult = partials[pi][0], amp = partials[pi][1], inh = partials[pi][2];
      const o = ctxA.createOscillator();
      o.type = mult === 1 ? 'triangle' : 'sine';
      o.frequency.value = freq * mult * (1 + inh * 0.0007);
      o.detune.value = Math.random() * 8 - 4;
      const g = ctxA.createGain();
      const peak = Math.max(0.0003, vel * amp * 0.42);
      const d = Math.max(0.4, dur * (1 - (mult - 1) * 0.13));
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(g); g.connect(lp);
      try { o.start(t0); o.stop(t0 + d + 0.08); } catch (e) {}
      oscs.push(o);
    }
    return oscs;
  }

  // ---- DOM
  const statusEl = document.getElementById('status');
  const readoutEl = document.getElementById('readout');
  const connectBtn = document.getElementById('connect');
  const controlsEl = document.getElementById('controls');
  const playBtn = document.getElementById('play-btn');
  const downloadBtn = document.getElementById('download-btn');
  const restartBtn = document.getElementById('restart-btn');
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }

  // ---- conexão + gravação
  connectBtn.addEventListener('click', async () => {
    ensureAudio();
    const B = window.Bio;
    if (!B || !B.supported) { setStatus('Bluetooth indisponível neste navegador'); return; }
    setStatus('procurando…');
    try {
      await B.connect();
      if (B.data.connected) {
        connectBtn.classList.add('gone');
        beginRecording();
      } else {
        setStatus('conecte seu Polar');
      }
    } catch (e) {
      setStatus('falhou');
    }
  });

  function beginRecording() {
    state = STATE.RECORDING;
    recordStart = performance.now();
    recording = { rrs: [], times: [], hrs: [], amplitudes: [] };
    composition = null;
    controlsEl.classList.add('hidden');
    setStatus('registrando seu coração');
  }

  function handleBeat(rr) {
    beatPulse = 1;
    if (rr <= 0) return;
    if (state === STATE.RECORDING) {
      recording.rrs.push(rr);
      recording.times.push(performance.now() - recordStart);
      recording.hrs.push(60000 / rr);
      // amostra a amplitude do pico R no ECG bruto (janela de ~100 ms)
      const B = window.Bio.data;
      let amp = 0;
      if (B && B.ecgBuf && B.ecgOn && B.ecgBuf.length > 0) {
        const N = 14; // ~108 ms a 130 Hz
        const head = B.ecgHead;
        const buf = B.ecgBuf;
        for (let i = 0; i < N; i++) {
          const idx = (head - 1 - i + buf.length) % buf.length;
          const v = Math.abs(buf[idx]);
          if (v > amp) amp = v;
        }
      }
      recording.amplitudes.push(amp);
    }
  }

  // ---- análise
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
  function std(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / a.length);
  }
  function rmssd(rrs) {
    if (rrs.length < 2) return 0;
    let sq = 0;
    for (let i = 1; i < rrs.length; i++) { const d = rrs[i] - rrs[i - 1]; sq += d * d; }
    return Math.sqrt(sq / (rrs.length - 1));
  }
  function linearSlope(values, times) {
    const n = values.length;
    if (n < 3) return 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
      sumX += times[i]; sumY += values[i];
      sumXY += times[i] * values[i];
      sumXX += times[i] * times[i];
    }
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-9) return 0;
    return (n * sumXY - sumX * sumY) / denom;
  }
  function estimateRespiration(rrs) {
    if (rrs.length < 8) return 0;
    let peaks = 0;
    for (let i = 1; i < rrs.length - 1; i++) {
      if (rrs[i] > rrs[i - 1] && rrs[i] > rrs[i + 1]) peaks++;
    }
    let total = 0;
    for (const rr of rrs) total += rr;
    const minutes = total / 60000;
    if (minutes <= 0) return 0;
    return peaks / minutes;
  }

  function analyze(rec) {
    if (!rec || rec.rrs.length < 5) return null;
    // gate fisiológico
    const f = [], ft = [], fa = [];
    for (let i = 0; i < rec.rrs.length; i++) {
      const rr = rec.rrs[i];
      if (rr >= 300 && rr <= 2000) {
        f.push(rr); ft.push(rec.times[i]); fa.push(rec.amplitudes[i] || 0);
      }
    }
    if (f.length < 5) return null;
    // remove outliers (extrassístole, ruído)
    const sorted = f.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const clean = [], ct = [], ca = [];
    for (let i = 0; i < f.length; i++) {
      if (f[i] > med * 0.55 && f[i] < med * 1.8) {
        clean.push(f[i]); ct.push(ft[i]); ca.push(fa[i]);
      }
    }
    if (clean.length < 5) return null;
    const hrs = clean.map(rr => 60000 / rr);
    const hrMean = mean(hrs);
    const hrMin = Math.min.apply(null, hrs);
    const hrMax = Math.max.apply(null, hrs);
    const rrMean = mean(clean);
    const rrStd = std(clean);
    const hrv = rmssd(clean);
    const hrSlope = linearSlope(hrs, ct); // bpm por ms
    const respiration = estimateRespiration(clean);
    const ampMax = Math.max.apply(null, ca.concat([0.001]));
    const ampMean = mean(ca);
    let total = 0;
    for (const rr of clean) total += rr;
    return {
      rrs: clean, hrs, times: ct, amplitudes: ca,
      hrMean, hrMin, hrMax, rrMean, rrStd, hrv,
      hrSlope, respiration, ampMax, ampMean, totalMs: total,
    };
  }

  // ---- composição
  function compose(a) {
    if (!a) return null;
    const rrs = a.rrs;
    const N = rrs.length;

    // modo a partir da HRV
    let mode, scale, modeName;
    if (a.hrv > 60) { mode = 'major'; scale = [0, 2, 4, 5, 7, 9, 11]; modeName = 'maior'; }
    else if (a.hrv > 35) { mode = 'dorian'; scale = [0, 2, 3, 5, 7, 9, 10]; modeName = 'dórico'; }
    else { mode = 'minor'; scale = [0, 2, 3, 5, 7, 8, 10]; modeName = 'menor'; }

    const bpm = Math.round(clamp(a.hrMean, 40, 180));
    const rootMidi = 60; // C4

    // tamanho da frase a partir da respiração (se válida)
    let phraseLen = 8;
    if (a.respiration >= 6 && a.respiration <= 25) {
      phraseLen = Math.round(clamp(a.hrMean / a.respiration, 3, 16));
    }
    const numPhrases = Math.ceil(N / phraseLen);

    // progressão por modo
    let progression;
    if (mode === 'major') progression = [0, 4, 5, 3];     // I V vi IV
    else if (mode === 'minor') progression = [0, 6, 5, 4]; // i VII VI V
    else progression = [0, 3, 0, 4];                       // dórico: i IV i V

    function chordForPhrase(p) {
      if (p === 0) return 0; // estabelece a tônica
      if (p === numPhrases - 1) return 0; // resolve na tônica
      if (numPhrases > 2 && p === numPhrases - 2) return 4; // V antes do final (cadência V-I)
      return progression[(p - 1) % progression.length];
    }
    function chordTones(deg) {
      const len = scale.length;
      const r = scale[deg];
      const t = scale[(deg + 2) % len] + (deg + 2 >= len ? 12 : 0);
      const f = scale[(deg + 4) % len] + (deg + 4 >= len ? 12 : 0);
      return [r, t, f];
    }

    // contorno melódico a partir da tendência da FC (sobe/desce ao longo da peça)
    const trendNorm = clamp(a.hrSlope * a.totalMs / Math.max(1, a.hrMean), -1, 1);

    const rrMin = Math.min.apply(null, rrs);
    const rrMax = Math.max.apply(null, rrs);

    const melody = [];
    let currentTime = 0;

    for (let i = 0; i < N; i++) {
      const phraseIdx = Math.floor(i / phraseLen);
      const beatInPhrase = i % phraseLen;
      const chordDeg = chordForPhrase(phraseIdx);
      const tones = chordTones(chordDeg);

      // pitch base: RR mapeado em 2 oitavas da escala
      const tPosRaw = (rrMax - rrs[i]) / Math.max(1, rrMax - rrMin);
      const piecePos = N > 1 ? i / (N - 1) : 0;
      // bias do contorno: empurra agudo se FC subiu, grave se caiu
      const contourBias = trendNorm * (piecePos - 0.5) * 0.4;
      const tPos = clamp(tPosRaw + contourBias, 0, 1);
      const positions = scale.length * 2;
      const scalePos = Math.round(tPos * (positions - 1));
      const oct = Math.floor(scalePos / scale.length);
      const scaleIdx = scalePos % scale.length;
      let semi = oct * 12 + scale[scaleIdx];

      // batidas fortes (1 e meio da frase) puxam para nota do acorde
      const isStrong = beatInPhrase === 0 || (phraseLen >= 6 && beatInPhrase === Math.floor(phraseLen / 2));
      if (isStrong) {
        let best = semi, minDist = 99;
        for (let ti = 0; ti < tones.length; ti++) {
          for (let oc = oct - 1; oc <= oct + 1; oc++) {
            const cand = tones[ti] + oc * 12;
            const d = Math.abs(cand - semi);
            if (d < minDist) { minDist = d; best = cand; }
          }
        }
        semi = best;
      }

      // duração = RR real (preserva o ritmo natural)
      const dur = rrs[i] / 1000;

      // velocidade = amplitude do pico R (relativa ao máximo)
      const amp = a.amplitudes[i] || a.ampMean;
      const relAmp = amp / Math.max(a.ampMax, 0.01);
      const vel = clamp(0.35 + relAmp * 0.45, 0.2, 0.95);

      melody.push({
        pitch: rootMidi + semi,
        time: currentTime,
        duration: dur,
        vel: vel,
      });
      currentTime += dur;
    }

    // garante última nota = tônica (resolução)
    if (melody.length > 0) {
      const last = melody[melody.length - 1];
      const semi = last.pitch - rootMidi;
      const octShift = Math.round(semi / 12);
      last.pitch = rootMidi + octShift * 12;
    }

    // acordes de fundo (um por frase)
    const CHORD_NAMES = {
      major:  ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'B°'],
      minor:  ['Cm', 'D°', 'E♭', 'Fm', 'Gm', 'A♭', 'B♭'],
      dorian: ['Cm', 'Dm', 'E♭', 'F', 'Gm', 'A°', 'B♭'],
    };
    const chordNames = CHORD_NAMES[mode] || CHORD_NAMES.major;
    const chordBackings = [];
    for (let p = 0; p < numPhrases; p++) {
      const startBeat = p * phraseLen;
      const endBeat = Math.min(N, (p + 1) * phraseLen);
      if (startBeat >= melody.length) break;
      const t0 = melody[startBeat].time;
      const t1 = endBeat < melody.length ? melody[endBeat].time : currentTime;
      const dur = t1 - t0;
      const deg = chordForPhrase(p);
      const tones = chordTones(deg).map(s => rootMidi + s - 12); // uma oitava abaixo
      chordBackings.push({ time: t0, duration: dur, tones, name: chordNames[deg] || '' });
    }

    return {
      mode, modeName, bpm, rootMidi, scale, phraseLen, numPhrases,
      melody, chordBackings, totalDuration: currentTime, N,
      stats: {
        hrMean: Math.round(a.hrMean), hrMin: Math.round(a.hrMin), hrMax: Math.round(a.hrMax),
        hrv: Math.round(a.hrv), respiration: a.respiration > 0 ? +a.respiration.toFixed(1) : 0,
        trendBpmMin: +(a.hrSlope * 60000).toFixed(2),
      },
    };
  }

  // ---- transição
  function beginComposing() {
    state = STATE.COMPOSING;
    setStatus('compondo sua música');
    setTimeout(() => {
      const analysis = analyze(recording);
      composition = compose(analysis);
      if (!composition) {
        setStatus('precisa de mais batidas para compor');
        controlsEl.classList.remove('hidden');
        playBtn.style.display = 'none';
        downloadBtn.style.display = 'none';
        restartBtn.style.display = '';
        state = STATE.READY;
        return;
      }
      state = STATE.READY;
      setStatus('sua música está pronta');
      controlsEl.classList.remove('hidden');
      playBtn.style.display = '';
      downloadBtn.style.display = '';
      restartBtn.style.display = '';
      updateReadout();
    }, 1500);
  }
  function updateReadout() {
    if (!composition) { readoutEl.textContent = ''; return; }
    const s = composition.stats;
    const dur = composition.totalDuration;
    const m = Math.floor(dur / 60);
    const sec = Math.round(dur - m * 60);
    const trendArrow = s.trendBpmMin > 1 ? ' ↗' : s.trendBpmMin < -1 ? ' ↘' : '';
    readoutEl.textContent =
      composition.modeName + ' · ' + composition.bpm + ' bpm' + trendArrow +
      ' · ' + m + ':' + String(sec).padStart(2, '0') +
      ' · hrv ' + s.hrv + ' ms';
  }

  // ---- playback
  function play() {
    if (!composition || !ctxA) return;
    if (state === STATE.PLAYING) return;
    if (ctxA.state === 'suspended') ctxA.resume();
    state = STATE.PLAYING;
    playBtn.textContent = '■';
    const now = ctxA.currentTime + 0.05;
    playbackStart = performance.now();
    scheduled = [];
    // melodia
    for (let i = 0; i < composition.melody.length; i++) {
      const n = composition.melody[i];
      const oscs = pianoAt(midiToFreq(n.pitch), n.vel, n.duration + 0.5, now + n.time);
      for (let j = 0; j < oscs.length; j++) scheduled.push(oscs[j]);
    }
    // acordes
    for (let i = 0; i < composition.chordBackings.length; i++) {
      const c = composition.chordBackings[i];
      for (let j = 0; j < c.tones.length; j++) {
        const oscs = pianoAt(midiToFreq(c.tones[j]), 0.32, c.duration + 0.4, now + c.time);
        for (let k = 0; k < oscs.length; k++) scheduled.push(oscs[k]);
      }
    }
    const totalMs = composition.totalDuration * 1000 + 600;
    setTimeout(() => {
      if (state === STATE.PLAYING) {
        state = STATE.READY;
        playBtn.textContent = '▶';
      }
    }, totalMs);
  }
  function stopPlayback() {
    state = STATE.READY;
    playBtn.textContent = '▶';
    for (let i = 0; i < scheduled.length; i++) {
      try { scheduled[i].stop(0); } catch (e) {}
    }
    scheduled = [];
  }
  playBtn.addEventListener('click', () => {
    if (state === STATE.PLAYING) stopPlayback();
    else play();
  });
  restartBtn.addEventListener('click', () => {
    stopPlayback();
    composition = null;
    if (window.Bio && window.Bio.data && window.Bio.data.connected) {
      beginRecording();
    } else {
      state = STATE.IDLE;
      setStatus('conecte seu Polar');
      connectBtn.classList.remove('gone');
      controlsEl.classList.add('hidden');
    }
  });

  // ---- exportação MIDI
  function writeVarLen(n) {
    const out = [n & 0x7F];
    n >>= 7;
    while (n > 0) { out.unshift((n & 0x7F) | 0x80); n >>= 7; }
    return out;
  }
  function generateMIDI(comp) {
    const TPQ = 480;
    const usPerQ = Math.round(60000000 / comp.bpm);
    const events = [];
    events.push({ time: 0, kind: 'tempo' });
    function secToTicks(s) { return Math.max(0, Math.round(s * comp.bpm / 60 * TPQ)); }
    for (let i = 0; i < comp.melody.length; i++) {
      const n = comp.melody[i];
      const t0 = secToTicks(n.time);
      const t1 = secToTicks(n.time + n.duration);
      const vel = clamp(Math.round(30 + n.vel * 90), 1, 127);
      events.push({ time: t0, kind: 'on', pitch: n.pitch & 0x7F, vel: vel });
      events.push({ time: Math.max(t0 + 1, t1), kind: 'off', pitch: n.pitch & 0x7F });
    }
    for (let i = 0; i < comp.chordBackings.length; i++) {
      const c = comp.chordBackings[i];
      const t0 = secToTicks(c.time);
      const t1 = secToTicks(c.time + c.duration);
      for (let j = 0; j < c.tones.length; j++) {
        events.push({ time: t0, kind: 'on', pitch: c.tones[j] & 0x7F, vel: 55 });
        events.push({ time: Math.max(t0 + 1, t1), kind: 'off', pitch: c.tones[j] & 0x7F });
      }
    }
    events.sort((a, b) => {
      if (a.time !== b.time) return a.time - b.time;
      const w = e => e.kind === 'off' ? 0 : e.kind === 'tempo' ? 1 : 2;
      return w(a) - w(b);
    });
    const trk = [];
    let lastT = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const dt = ev.time - lastT;
      lastT = ev.time;
      const vl = writeVarLen(dt);
      for (let j = 0; j < vl.length; j++) trk.push(vl[j]);
      if (ev.kind === 'tempo') {
        trk.push(0xFF, 0x51, 0x03,
          (usPerQ >> 16) & 0xFF, (usPerQ >> 8) & 0xFF, usPerQ & 0xFF);
      } else if (ev.kind === 'on') {
        trk.push(0x90, ev.pitch, ev.vel);
      } else if (ev.kind === 'off') {
        trk.push(0x80, ev.pitch, 0);
      }
    }
    trk.push(0x00, 0xFF, 0x2F, 0x00); // end of track
    const file = [
      0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6,
      0, 0, // formato 0
      0, 1, // 1 track
      (TPQ >> 8) & 0xFF, TPQ & 0xFF,
      0x4D, 0x54, 0x72, 0x6B,
      (trk.length >> 24) & 0xFF, (trk.length >> 16) & 0xFF,
      (trk.length >> 8) & 0xFF, trk.length & 0xFF,
    ];
    for (let i = 0; i < trk.length; i++) file.push(trk[i]);
    return new Uint8Array(file);
  }
  // ---- partitura SVG (visual, bonitinha)
  // posição na pauta da clave de sol: 0 = linha de baixo (E4), 8 = linha de cima (F5)
  function midiToStaffPos(midi) {
    const LETTER = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
    const note = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return (oct - 4) * 7 + LETTER[note] - 2;
  }
  // posições das bemóis na pauta (ordem padrão Bb Eb Ab Db Gb Cb Fb)
  const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  const FLAT_POS = { B: 4, E: 8, A: 5, D: 7, G: 3, C: 6, F: 1 };
  function keyFlats(mode) {
    if (mode === 'minor') return ['B', 'E', 'A']; // C menor: 3 bemóis
    if (mode === 'dorian') return ['B', 'E'];      // C dórico: 2 bemóis
    return [];                                      // C maior: nenhum
  }
  function generateScoreSVG(comp) {
    const PAGE_W = 800;
    const MARGIN = 40;
    const STAFF_LH = 7;                // distância entre linhas adjacentes
    const STAFF_H = STAFF_LH * 4;       // 5 linhas = 4 espaços
    const STAFF_GAP = 64;               // distância entre pautas consecutivas
    const TITLE_BAND = 86;
    const PREFIX_W = 78;                // espaço pra clave + armadura + fórmula
    const MEASURES_PER_LINE = 4;
    const BEATS_PER_MEASURE = 4;

    // agrupa em compassos
    const measures = [];
    for (let i = 0; i < comp.melody.length; i += BEATS_PER_MEASURE) {
      const notes = comp.melody.slice(i, i + BEATS_PER_MEASURE);
      if (!notes.length) continue;
      const phraseIdx = Math.floor(i / comp.phraseLen);
      const chord = comp.chordBackings[Math.min(phraseIdx, comp.chordBackings.length - 1)];
      measures.push({ notes, chord });
    }
    const numLines = Math.max(1, Math.ceil(measures.length / MEASURES_PER_LINE));
    const PAGE_H = TITLE_BAND + numLines * STAFF_GAP + 50;

    const flats = keyFlats(comp.mode);
    const out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + PAGE_W + '" height="' + PAGE_H + '" viewBox="0 0 ' + PAGE_W + ' ' + PAGE_H + '" font-family="\'Iowan Old Style\', Palatino, Georgia, serif">');
    out.push('<rect width="100%" height="100%" fill="#fdfcf8"/>');
    // título e subtítulo
    out.push('<text x="' + (PAGE_W / 2) + '" y="38" text-anchor="middle" font-size="22" font-weight="600" fill="#1a1a1a">Sua música</text>');
    out.push('<text x="' + (PAGE_W / 2) + '" y="58" text-anchor="middle" font-size="12" fill="#444" font-style="italic">composta a partir do seu coração</text>');
    // marca de tempo (♩ = bpm)
    out.push('<text x="' + (MARGIN + 4) + '" y="' + (TITLE_BAND - 6) + '" font-size="14" fill="#1a1a1a">♩ = ' + comp.bpm + '</text>');
    // info do modo
    out.push('<text x="' + (PAGE_W - MARGIN) + '" y="' + (TITLE_BAND - 6) + '" text-anchor="end" font-size="11" fill="#666" font-style="italic">' + comp.modeName + '</text>');

    for (let line = 0; line < numLines; line++) {
      const staffTop = TITLE_BAND + line * STAFF_GAP;
      // linhas da pauta
      for (let i = 0; i < 5; i++) {
        const y = staffTop + i * STAFF_LH;
        out.push('<line x1="' + MARGIN + '" y1="' + y + '" x2="' + (PAGE_W - MARGIN) + '" y2="' + y + '" stroke="#1a1a1a" stroke-width="0.7"/>');
      }
      // clave de sol (glifo Unicode 𝄞)
      out.push('<text x="' + (MARGIN + 4) + '" y="' + (staffTop + STAFF_H + 6) + '" font-size="44" fill="#1a1a1a" font-family="\'Bravura\', \'Cambria Math\', serif">𝄞</text>');
      // armadura (bemóis)
      let kx = MARGIN + 38;
      for (const f of flats) {
        const fy = staffTop + (8 - FLAT_POS[f]) * STAFF_LH / 2;
        out.push('<text x="' + kx + '" y="' + (fy + 3) + '" font-size="20" text-anchor="middle" fill="#1a1a1a">♭</text>');
        kx += 8;
      }
      // fórmula de compasso (na primeira linha)
      if (line === 0) {
        const tsx = MARGIN + 50 + flats.length * 8;
        out.push('<text x="' + tsx + '" y="' + (staffTop + STAFF_LH * 1.5 + 3) + '" font-size="17" font-weight="bold" text-anchor="middle" fill="#1a1a1a">4</text>');
        out.push('<text x="' + tsx + '" y="' + (staffTop + STAFF_LH * 3.5 + 3) + '" font-size="17" font-weight="bold" text-anchor="middle" fill="#1a1a1a">4</text>');
      }
      // compassos
      const startM = line * MEASURES_PER_LINE;
      const endM = Math.min(startM + MEASURES_PER_LINE, measures.length);
      const usableW = PAGE_W - 2 * MARGIN - PREFIX_W;
      const measureW = (endM > startM) ? usableW / (endM - startM) : usableW;
      let lastChordName = '';
      for (let m = startM; m < endM; m++) {
        const mx = MARGIN + PREFIX_W + (m - startM) * measureW;
        const meas = measures[m];
        // cifra acima do compasso (só se mudou)
        if (meas.chord && meas.chord.name && meas.chord.name !== lastChordName) {
          out.push('<text x="' + (mx + 4) + '" y="' + (staffTop - 8) + '" font-size="13" font-weight="600" fill="#1a1a1a">' + meas.chord.name + '</text>');
          lastChordName = meas.chord.name;
        }
        // notas
        const ns = meas.notes.length;
        const noteSpacing = measureW / Math.max(ns, 1);
        for (let bi = 0; bi < ns; bi++) {
          const n = meas.notes[bi];
          const nx = mx + bi * noteSpacing + noteSpacing / 2;
          const pos = midiToStaffPos(n.pitch);
          const ny = staffTop + (8 - pos) * STAFF_LH / 2;
          // linhas suplementares acima
          if (pos > 8) {
            for (let lp = 10; lp <= pos; lp += 2) {
              const ly = staffTop + (8 - lp) * STAFF_LH / 2;
              out.push('<line x1="' + (nx - 7) + '" y1="' + ly + '" x2="' + (nx + 7) + '" y2="' + ly + '" stroke="#1a1a1a" stroke-width="0.7"/>');
            }
          } else if (pos < 0) {
            // linhas suplementares abaixo
            const lowest = Math.floor(pos / 2) * 2;
            for (let lp = -2; lp >= lowest; lp -= 2) {
              const ly = staffTop + (8 - lp) * STAFF_LH / 2;
              out.push('<line x1="' + (nx - 7) + '" y1="' + ly + '" x2="' + (nx + 7) + '" y2="' + ly + '" stroke="#1a1a1a" stroke-width="0.7"/>');
            }
          }
          // cabeça da nota (elipse ligeiramente inclinada)
          out.push('<ellipse cx="' + nx + '" cy="' + ny + '" rx="4.6" ry="3.3" fill="#1a1a1a" transform="rotate(-20 ' + nx + ' ' + ny + ')"/>');
          // haste
          const stemUp = pos < 4; // notas abaixo da linha do meio (B4) → haste pra cima
          const stemX = stemUp ? nx + 4.2 : nx - 4.2;
          const stemY1 = ny;
          const stemY2 = ny + (stemUp ? -22 : 22);
          out.push('<line x1="' + stemX + '" y1="' + stemY1 + '" x2="' + stemX + '" y2="' + stemY2 + '" stroke="#1a1a1a" stroke-width="1.2"/>');
        }
        // barra de compasso
        if (m < endM - 1 || line < numLines - 1) {
          out.push('<line x1="' + (mx + measureW) + '" y1="' + staffTop + '" x2="' + (mx + measureW) + '" y2="' + (staffTop + STAFF_H) + '" stroke="#1a1a1a" stroke-width="0.7"/>');
        }
      }
      // barra dupla final (na última linha)
      if (line === numLines - 1 && endM > startM) {
        const fbx = MARGIN + PREFIX_W + (endM - startM) * measureW;
        out.push('<line x1="' + (fbx - 4) + '" y1="' + staffTop + '" x2="' + (fbx - 4) + '" y2="' + (staffTop + STAFF_H) + '" stroke="#1a1a1a" stroke-width="0.7"/>');
        out.push('<line x1="' + (fbx - 1) + '" y1="' + staffTop + '" x2="' + (fbx - 1) + '" y2="' + (staffTop + STAFF_H) + '" stroke="#1a1a1a" stroke-width="2.5"/>');
      }
    }
    out.push('</svg>');
    return out.join('\n');
  }
  function downloadText(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  downloadBtn.addEventListener('click', () => {
    if (!composition) return;
    const svg = generateScoreSVG(composition);
    downloadText('sua-musica.svg', svg, 'image/svg+xml');
  });
  const midiBtn = document.getElementById('midi-btn');
  if (midiBtn) midiBtn.addEventListener('click', () => {
    if (!composition) return;
    downloadBlob('sua-musica.mid', new Blob([generateMIDI(composition)], { type: 'audio/midi' }));
  });

  // ---- poll do biossensor
  function poll() {
    const B = window.Bio;
    if (!B || !B.data) return;
    if ((state === STATE.RECORDING || state === STATE.COMPOSING) && !B.data.connected) {
      setStatus('Polar desconectou');
      state = STATE.IDLE;
      connectBtn.classList.remove('gone');
      return;
    }
    if (B.data.beatQueue && B.data.beatQueue.length) {
      while (B.data.beatQueue.length) {
        const b = B.data.beatQueue.shift();
        handleBeat(b.rr);
      }
    }
    if (state === STATE.RECORDING) {
      const elapsed = performance.now() - recordStart;
      const remaining = Math.max(0, RECORD_MS - elapsed);
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      readoutEl.textContent = '♥ ' + (B.data.hr || '--') + ' bpm · ' +
        m + ':' + String(s).padStart(2, '0') + ' restantes · ' +
        recording.rrs.length + ' batidas';
      if (elapsed >= RECORD_MS) beginComposing();
    }
  }

  // ---- loop
  let lastTs = 0;
  function frame(ts) {
    const dt = Math.min(60, ts - lastTs || 16);
    lastTs = ts;
    poll();
    beatPulse *= Math.pow(0.05, dt / 1000);
    render(ts);
    requestAnimationFrame(frame);
  }

  // ---- render
  function render(ts) {
    ctx.fillStyle = 'rgba(4, 8, 12, 0.35)';
    ctx.fillRect(0, 0, W, H);
    if (state === STATE.IDLE || state === STATE.RECORDING || state === STATE.COMPOSING) {
      drawHeart();
      if (state === STATE.RECORDING) drawRecordingRing(ts);
    } else {
      drawPianoRoll();
    }
  }

  function drawPianoRoll() {
    if (!composition) return;
    const padX = clamp(W * 0.05, 24, 60);
    const x0 = padX;
    const yTop = H * 0.18;
    const yBot = H * 0.74;
    const rollW = W - padX * 2;
    const rollH = yBot - yTop;
    let minP = 200, maxP = 0;
    for (let i = 0; i < composition.melody.length; i++) {
      const p = composition.melody[i].pitch;
      if (p < minP) minP = p; if (p > maxP) maxP = p;
    }
    for (let i = 0; i < composition.chordBackings.length; i++) {
      const tns = composition.chordBackings[i].tones;
      for (let j = 0; j < tns.length; j++) { if (tns[j] < minP) minP = tns[j]; if (tns[j] > maxP) maxP = tns[j]; }
    }
    minP -= 2; maxP += 2;
    const pr = Math.max(1, maxP - minP);
    const total = composition.totalDuration;
    function xFor(t) { return x0 + (t / total) * rollW; }
    function yFor(p) { return yTop + (1 - (p - minP) / pr) * rollH; }
    ctx.fillStyle = 'rgba(8, 14, 20, 0.45)';
    ctx.fillRect(x0, yTop, rollW, rollH);
    for (let i = 0; i < composition.chordBackings.length; i++) {
      const c = composition.chordBackings[i];
      const cx = xFor(c.time);
      const cw = Math.max(2, (c.duration / total) * rollW);
      for (let j = 0; j < c.tones.length; j++) {
        const cy = yFor(c.tones[j]);
        ctx.fillStyle = 'hsla(195, 50%, 45%, 0.35)';
        ctx.fillRect(cx, cy - 3, cw, 6);
      }
    }
    for (let i = 0; i < composition.melody.length; i++) {
      const n = composition.melody[i];
      const nx = xFor(n.time);
      const nw = Math.max(2, (n.duration / total) * rollW - 1);
      const ny = yFor(n.pitch);
      const tn = (n.pitch - minP) / pr;
      const a = 0.55 + n.vel * 0.35;
      ctx.fillStyle = 'hsla(' + (200 - tn * 80) + ', 78%, 62%, ' + a + ')';
      ctx.fillRect(nx, ny - 4, nw, 8);
    }
    if (state === STATE.PLAYING) {
      const elapsedSec = (performance.now() - playbackStart) / 1000;
      if (elapsedSec <= total) {
        const px = xFor(elapsedSec);
        ctx.strokeStyle = 'rgba(255, 210, 130, 0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, yTop);
        ctx.lineTo(px, yBot);
        ctx.stroke();
      }
    }
  }

  function drawHeart() {
    const cx = W / 2, cy = H / 2;
    const baseSize = Math.min(W, H) * 0.12;
    const size = baseSize * (1 + beatPulse * 0.35);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(size, size);
    ctx.beginPath();
    ctx.moveTo(0, -0.25);
    ctx.bezierCurveTo(-1.0, -1.25, -1.5, 0.0, 0, 1.0);
    ctx.bezierCurveTo(1.5, 0.0, 1.0, -1.25, 0, -0.25);
    ctx.closePath();
    const active = state !== STATE.IDLE;
    const hue = active ? 350 : 200;
    const sat = active ? 78 : 32;
    const lit = 38 + beatPulse * 30;
    ctx.fillStyle = 'hsla(' + hue + ', ' + sat + '%, ' + lit + '%, ' + (0.42 + beatPulse * 0.5) + ')';
    ctx.shadowColor = active ? 'rgba(255, 100, 130, 0.75)' : 'rgba(120, 220, 220, 0.32)';
    ctx.shadowBlur = 28 * (1 + beatPulse * 1.4);
    ctx.fill();
    ctx.restore();
  }
  function drawRecordingRing() {
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.18;
    const elapsed = performance.now() - recordStart;
    const progress = clamp(elapsed / RECORD_MS, 0, 1);
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * progress);
    ctx.strokeStyle = 'rgba(120, 220, 210, 0.65)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  setStatus('conecte seu Polar');
  requestAnimationFrame(frame);
})();
