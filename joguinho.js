/* ============================================================
   JOGUINHO DE EVOLUÇÃO
   Desenhe sua criatura (pontos + ossos + músculos). Ao "começar",
   N organismos aparecem com parâmetros de oscilação aleatórios.
   Cada músculo é um par (frequência, fase, amplitude) — esse é o
   "cérebro" que evolui. BOOM pega o que foi mais longe e gera N
   cópias com mutações sutis. Auto-BOOM repete a cada X segundos.
   ============================================================ */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));

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

  // ---- constantes da física
  const GRAVITY = 0.45;
  const VELOCITY_DAMPING = 0.985;
  const ITERATIONS = 8;
  const FRICTION_GROUND = 0.42; // 0 = escorregadio, 1 = grudado
  const VERTEX_R = 6;
  const POP_SIZE = 6;
  const FLOOR_PAD = 150; // pixels do chão até a borda inferior (espaço pra régua + controles)
  const STEP_DT = 0.6;   // dt do mundo por quadro real (slower = menos louco)
  const MUSCLE_K = 0.35; // força do músculo na restrição
  const START_X = 180;
  // rede neural feedforward: entradas -> camada escondida -> ativação por músculo
  // entradas: [sin(t·ω), cos(t·ω), %articulações no chão, altura média, inclinação, bias]
  const NN_INPUTS = 6;
  const NN_HIDDEN = 6;

  // ---- estado
  const STATE = { DRAWING: 0, EVOLVING: 1 };
  let state = STATE.DRAWING;

  // template (desenho do usuário)
  let tVertices = []; // [{x, y}] articulações
  let tBones = [];    // [{a, b}] (índices de articulação)
  let tMuscles = [];  // [{ba, bb}] (índices de ossos)
  let history = [];   // pra desfazer (pilha de ações)
  let placementMode = 'joint'; // 'joint' | 'bone' | 'muscle'

  // interação com mouse/toque
  let dragStart = null;     // {x, y} ponto inicial do drag
  let dragStartV = -1;      // índice de articulação se drag de joint
  let dragStartB = -1;      // índice de osso se drag de bone (modo músculo)
  let dragEnd = null;       // {x, y} atual durante drag
  let hoverV = -1;
  let hoverB = -1;

  // organismos
  let organisms = [];
  let generation = 0;
  let bestEverDistance = 0;
  let flagX = START_X; // posição X (mundo) da bandeira: o mais longe já alcançado nesta sessão

  // auto-boom
  let autoBoom = false;
  let autoBoomNext = 0;
  let autoBoomLastShown = 0;

  // velocidade da simulação
  let speedMult = 1;

  // câmera (rola na evolução, com zoom out)
  let camX = 0;
  let camScale = 0.55; // zoom out: vê quase 2x mais área que sem zoom
  function projX(wx) { return W / 2 + (wx - camX) * camScale; }
  function projY(wy) { const fy = H - FLOOR_PAD; return fy + (wy - fy) * camScale; }

  // ---- DOM
  const infoEl = document.getElementById('info');
  const drawCtrl = document.getElementById('draw-controls');
  const evolCtrl = document.getElementById('evol-controls');
  const modeJoint = document.getElementById('mode-joint');
  const modeBone = document.getElementById('mode-bone');
  const modeMuscle = document.getElementById('mode-muscle');
  const undoBtn = document.getElementById('undo-btn');
  const clearBtn = document.getElementById('clear-btn');
  const startBtn = document.getElementById('start-btn');
  const boomBtn = document.getElementById('boom-btn');
  const autoToggle = document.getElementById('auto-toggle');
  const autoSecs = document.getElementById('auto-secs');
  const backBtn = document.getElementById('back-btn');
  const speedToggle = document.getElementById('speed-toggle');

  function setMode(m) {
    placementMode = m;
    modeJoint.classList.toggle('on', m === 'joint');
    modeBone.classList.toggle('on', m === 'bone');
    modeMuscle.classList.toggle('on', m === 'muscle');
  }
  modeJoint.addEventListener('click', () => setMode('joint'));
  modeBone.addEventListener('click', () => setMode('bone'));
  modeMuscle.addEventListener('click', () => setMode('muscle'));
  undoBtn.addEventListener('click', undo);
  clearBtn.addEventListener('click', clearTemplate);
  startBtn.addEventListener('click', start);
  boomBtn.addEventListener('click', boom);
  autoToggle.addEventListener('click', () => setAutoBoom(!autoBoom));
  backBtn.addEventListener('click', backToDrawing);
  speedToggle.addEventListener('click', () => setSpeed(speedMult === 1 ? 5 : 1));

  function setSpeed(mult) {
    speedMult = mult;
    speedToggle.classList.toggle('on', mult > 1);
    speedToggle.textContent = mult > 1 ? 'rápido ×' + mult : 'rápido';
  }

  function setAutoBoom(on) {
    autoBoom = !!on;
    autoToggle.classList.toggle('on', autoBoom);
    autoToggle.textContent = autoBoom ? 'auto on' : 'auto';
    if (autoBoom) autoBoomNext = performance.now() + (+autoSecs.value || 12) * 1000;
  }

  // ---- desenho da criatura
  function vertexNear(x, y) {
    for (let i = tVertices.length - 1; i >= 0; i--) {
      const v = tVertices[i];
      const dx = v.x - x, dy = v.y - y;
      if (dx * dx + dy * dy < (VERTEX_R + 6) * (VERTEX_R + 6)) return i;
    }
    return -1;
  }
  function ptSegDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1) { const ex = px - x1, ey = py - y1; return Math.sqrt(ex * ex + ey * ey); }
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = clamp(t, 0, 1);
    const cx = x1 + dx * t, cy = y1 + dy * t;
    const ex = px - cx, ey = py - cy;
    return Math.sqrt(ex * ex + ey * ey);
  }
  function boneNear(x, y) {
    let best = -1, bestD = 12;
    for (let i = 0; i < tBones.length; i++) {
      const v1 = tVertices[tBones[i].a], v2 = tVertices[tBones[i].b];
      const d = ptSegDist(x, y, v1.x, v1.y, v2.x, v2.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  function boneMid(boneIdx) {
    const b = tBones[boneIdx];
    const v1 = tVertices[b.a], v2 = tVertices[b.b];
    return { x: (v1.x + v2.x) * 0.5, y: (v1.y + v2.y) * 0.5 };
  }
  function addVertex(x, y) {
    tVertices.push({ x, y });
    history.push({ kind: 'v' });
    return tVertices.length - 1;
  }
  function addBone(a, b) {
    if (a === b || a < 0 || b < 0) return false;
    // evita duplicata
    for (const ex of tBones) if ((ex.a === a && ex.b === b) || (ex.a === b && ex.b === a)) return false;
    tBones.push({ a, b });
    history.push({ kind: 'b' });
    return true;
  }
  function addMuscle(ba, bb) {
    if (ba === bb || ba < 0 || bb < 0) return false;
    for (const ex of tMuscles) if ((ex.ba === ba && ex.bb === bb) || (ex.ba === bb && ex.bb === ba)) return false;
    tMuscles.push({ ba, bb });
    history.push({ kind: 'm' });
    return true;
  }
  function undo() {
    if (state !== STATE.DRAWING || !history.length) return;
    const h = history.pop();
    if (h.kind === 'v') tVertices.pop();
    else if (h.kind === 'b') tBones.pop();
    else if (h.kind === 'm') tMuscles.pop();
  }
  function clearTemplate() {
    if (state !== STATE.DRAWING) return;
    tVertices = []; tBones = []; tMuscles = []; history = [];
  }

  // ---- início da simulação
  function start() {
    if (state !== STATE.DRAWING) return;
    if (tVertices.length < 2) { flash('coloque ao menos 2 articulações'); return; }
    if (tBones.length < 2) { flash('coloque ao menos 2 ossos'); return; }
    if (tMuscles.length === 0) { flash('sem músculos não há movimento — adicione pelo menos 1'); return; }
    state = STATE.EVOLVING;
    drawCtrl.classList.add('hidden');
    evolCtrl.classList.remove('hidden');
    if (infoEl) infoEl.style.display = 'none';
    generation = 1;
    bestEverDistance = 0;
    flagX = START_X; // bandeira começa na linha de partida
    camX = START_X;
    organisms = [];
    for (let i = 0; i < POP_SIZE; i++) organisms.push(makeOrganism(randomGenome(), i));
    if (autoBoom) autoBoomNext = performance.now() + (+autoSecs.value || 12) * 1000;
  }

  function backToDrawing() {
    state = STATE.DRAWING;
    organisms = [];
    drawCtrl.classList.remove('hidden');
    evolCtrl.classList.add('hidden');
    if (infoEl) infoEl.style.display = '';
    setAutoBoom(false);
    setSpeed(1);
  }

  // ---- genoma e organismo
  function randomGenome() {
    const M = tMuscles.length;
    const W1 = new Array(NN_INPUTS * NN_HIDDEN);
    for (let i = 0; i < W1.length; i++) W1[i] = (Math.random() - 0.5) * 1.6;
    const W2 = new Array(NN_HIDDEN * M);
    for (let i = 0; i < W2.length; i++) W2[i] = (Math.random() - 0.5) * 1.6;
    const amp = new Array(M);
    for (let i = 0; i < M; i++) amp[i] = rand(0.10, 0.28);
    return {
      baseFreq: rand(0.04, 0.13), // relógio interno (ω) que vira sin/cos de entrada
      amp, W1, W2,
    };
  }
  function mutateGenome(g, strength) {
    function jit(x, scale) {
      const big = Math.random() < 0.04;
      return x + (Math.random() - 0.5) * strength * (big ? scale * 4 : scale);
    }
    return {
      baseFreq: clamp(jit(g.baseFreq, 0.03), 0.01, 0.3),
      amp: g.amp.map(a => clamp(jit(a, 0.10), 0.04, 0.5)),
      W1: g.W1.map(w => jit(w, 0.25)),
      W2: g.W2.map(w => jit(w, 0.25)),
    };
  }

  function makeOrganism(genome, idx) {
    // normaliza o template (apoia no chão) e copia
    let minY = Infinity, maxY = -Infinity, sumX = 0;
    for (const v of tVertices) {
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
      sumX += v.x;
    }
    const centerX = sumX / tVertices.length;
    const floorY = H - FLOOR_PAD;
    const startX = START_X;
    const dx = startX - centerX;
    const dy = (floorY - 4) - maxY;
    const vertices = tVertices.map(t => {
      const x = t.x + dx, y = t.y + dy;
      return { x, y, px: x, py: y };
    });
    const bones = tBones.map(b => ({
      a: b.a, b: b.b,
      length: dist(tVertices[b.a], tVertices[b.b]),
    }));
    // músculos ligam dois ossos; o "comprimento" é a distância entre os
    // midpoints dos dois ossos no descanso
    function midOf(boneIdx) {
      const bb = tBones[boneIdx];
      return { x: (tVertices[bb.a].x + tVertices[bb.b].x) * 0.5, y: (tVertices[bb.a].y + tVertices[bb.b].y) * 0.5 };
    }
    const muscles = tMuscles.map((m) => {
      const m1 = midOf(m.ba), m2 = midOf(m.bb);
      const base = Math.max(2, dist(m1, m2));
      return { ba: m.ba, bb: m.bb, base };
    });
    return {
      vertices, bones, muscles,
      time: 0, startX,
      genome,
      activations: new Array(muscles.length).fill(0),
      hue: (idx * 53) % 360,
    };
  }
  function cloneGenome(g) {
    return {
      baseFreq: g.baseFreq,
      amp: g.amp.slice(),
      W1: g.W1.slice(),
      W2: g.W2.slice(),
    };
  }
  // forward pass da rede: lê o estado do organismo, produz ativações [-1,1] dos músculos
  function controllerActivations(org, floorY) {
    let groundCount = 0, sumHeight = 0, sumVert = 0;
    for (const v of org.vertices) {
      if (v.y >= floorY - 2) groundCount++;
      sumHeight += (floorY - v.y);
    }
    for (const b of org.bones) {
      const v1 = org.vertices[b.a], v2 = org.vertices[b.b];
      const dx = v2.x - v1.x, dy = v2.y - v1.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0.01) sumVert += dy / len;
    }
    const groundFrac = groundCount / org.vertices.length;
    const avgHeight = sumHeight / Math.max(1, org.vertices.length);
    const tilt = sumVert / Math.max(1, org.bones.length);
    const omega = org.genome.baseFreq;
    const sensors = [
      Math.sin(org.time * omega),
      Math.cos(org.time * omega),
      groundFrac * 2 - 1,                    // [-1,1]
      clamp(avgHeight / 200, 0, 1) * 2 - 1,  // altura média normalizada
      clamp(tilt, -1, 1),                    // inclinação média dos ossos
      1,                                     // bias
    ];
    const W1 = org.genome.W1, W2 = org.genome.W2;
    const hidden = new Array(NN_HIDDEN);
    for (let h = 0; h < NN_HIDDEN; h++) {
      let s = 0;
      for (let i = 0; i < NN_INPUTS; i++) s += sensors[i] * W1[i * NN_HIDDEN + h];
      hidden[h] = Math.tanh(s);
    }
    const M = org.muscles.length;
    const acts = new Array(M);
    for (let m = 0; m < M; m++) {
      let s = 0;
      for (let h = 0; h < NN_HIDDEN; h++) s += hidden[h] * W2[h * M + m];
      acts[m] = Math.tanh(s);
    }
    return acts;
  }
  function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  // ---- física (Verlet)
  function step(org, dt) {
    org.time += dt;
    const floorY = H - FLOOR_PAD;
    // rede neural calcula a ativação de cada músculo a partir do estado atual
    org.activations = controllerActivations(org, floorY);
    // integração
    for (const v of org.vertices) {
      const vx = (v.x - v.px) * VELOCITY_DAMPING;
      const vy = (v.y - v.py) * VELOCITY_DAMPING;
      v.px = v.x; v.py = v.y;
      v.x += vx;
      v.y += vy + GRAVITY * dt;
    }
    // restrições
    for (let it = 0; it < ITERATIONS; it++) {
      for (const b of org.bones) satisfyDistance(org.vertices[b.a], org.vertices[b.b], b.length, 0.5);
      for (let mi = 0; mi < org.muscles.length; mi++) {
        const m = org.muscles[mi];
        const amp = org.genome.amp[mi];
        const target = Math.max(2, m.base * (1 + amp * org.activations[mi]));
        satisfyMuscle(org, m, target, MUSCLE_K);
      }
      // chão + atrito
      for (const v of org.vertices) {
        if (v.y > floorY) {
          v.y = floorY;
          v.px += (v.x - v.px) * FRICTION_GROUND;
        }
      }
    }
  }
  function satisfyDistance(v1, v2, target, k) {
    const dx = v2.x - v1.x;
    const dy = v2.y - v1.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.0001) return;
    const factor = (d - target) / d * k;
    v1.x += dx * factor; v1.y += dy * factor;
    v2.x -= dx * factor; v2.y -= dy * factor;
  }
  function satisfyMuscle(org, m, target, k) {
    const b1 = org.bones[m.ba], b2 = org.bones[m.bb];
    const v1a = org.vertices[b1.a], v1b = org.vertices[b1.b];
    const v2a = org.vertices[b2.a], v2b = org.vertices[b2.b];
    const m1x = (v1a.x + v1b.x) * 0.5, m1y = (v1a.y + v1b.y) * 0.5;
    const m2x = (v2a.x + v2b.x) * 0.5, m2y = (v2a.y + v2b.y) * 0.5;
    const dx = m2x - m1x, dy = m2y - m1y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.0001) return;
    const factor = (d - target) / d * k;
    const fx = dx * factor, fy = dy * factor;
    // move o midpoint de b1 em direção a b2: aplica o mesmo delta nos dois vértices de b1
    v1a.x += fx; v1a.y += fy;
    v1b.x += fx; v1b.y += fy;
    v2a.x -= fx; v2a.y -= fy;
    v2b.x -= fx; v2b.y -= fy;
  }

  function orgCenterX(org) {
    let s = 0;
    for (const v of org.vertices) s += v.x;
    return s / org.vertices.length;
  }

  // ---- BOOM (seleção + reprodução com mutação)
  function boom() {
    if (state !== STATE.EVOLVING) return;
    // melhor = quem foi mais à direita (a partir do startX)
    let bestIdx = 0, bestDist = -Infinity;
    for (let i = 0; i < organisms.length; i++) {
      const d = orgCenterX(organisms[i]) - organisms[i].startX;
      if (d > bestDist) { bestDist = d; bestIdx = i; }
    }
    const baseGenome = cloneGenome(organisms[bestIdx].genome);
    if (bestDist > bestEverDistance) bestEverDistance = bestDist;
    generation++;
    // nova geração: 1 elite + (POP_SIZE-1) mutações
    organisms = [];
    organisms.push(makeOrganism(baseGenome, 0)); // elite (sem mutação)
    for (let i = 1; i < POP_SIZE; i++) {
      const strength = i === POP_SIZE - 1 ? 0.6 : 0.22; // último é explorador (mutação alta)
      organisms.push(makeOrganism(mutateGenome(baseGenome, strength), i));
    }
    camX = START_X;
    if (autoBoom) autoBoomNext = performance.now() + (+autoSecs.value || 12) * 1000;
  }

  // ---- input
  function eventXY(e) {
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX, y: t.clientY };
  }
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); onDown(e); }, { passive: false });
  canvas.addEventListener('touchmove', (e) => { e.preventDefault(); onMove(e); }, { passive: false });
  canvas.addEventListener('touchend', (e) => { e.preventDefault(); onUp(e); }, { passive: false });

  function onDown(e) {
    if (state !== STATE.DRAWING) return;
    const p = eventXY(e);
    dragStart = { x: p.x, y: p.y };
    dragEnd = { x: p.x, y: p.y };
    dragStartV = -1; dragStartB = -1;
    if (placementMode === 'joint') {
      // só vai adicionar no onUp se for um clique (sem arrastar)
    } else if (placementMode === 'bone') {
      // tenta começar de uma articulação
      dragStartV = vertexNear(p.x, p.y);
    } else if (placementMode === 'muscle') {
      // tenta começar de um osso
      dragStartB = boneNear(p.x, p.y);
    }
  }
  function onMove(e) {
    const p = eventXY(e);
    if (state === STATE.DRAWING) {
      hoverV = vertexNear(p.x, p.y);
      hoverB = (placementMode === 'muscle') ? boneNear(p.x, p.y) : -1;
      if (dragStart) dragEnd = { x: p.x, y: p.y };
    }
  }
  function onUp(e) {
    if (state !== STATE.DRAWING || !dragStart) {
      dragStart = null; dragStartV = -1; dragStartB = -1; dragEnd = null; return;
    }
    const p = e && (e.changedTouches ? e.changedTouches[0] : e);
    const px = p ? (p.clientX != null ? p.clientX : dragEnd.x) : dragEnd.x;
    const py = p ? (p.clientY != null ? p.clientY : dragEnd.y) : dragEnd.y;
    const dx = px - dragStart.x, dy = py - dragStart.y;
    const dragLen = Math.sqrt(dx * dx + dy * dy);
    if (placementMode === 'joint') {
      // clique simples (sem arrastar muito) adiciona uma articulação
      if (dragLen < 10) addVertex(px, py);
      else flash('no modo articulação, só clique pra colocar pontos');
    } else if (placementMode === 'bone') {
      // arrasta de articulação para articulação
      if (dragStartV < 0) flash('osso precisa começar numa articulação');
      else if (dragLen > 10) {
        const endV = vertexNear(px, py);
        if (endV < 0) flash('osso precisa terminar numa articulação');
        else if (endV === dragStartV) flash('articulações precisam ser diferentes');
        else if (!addBone(dragStartV, endV)) flash('esse osso já existe');
      }
    } else if (placementMode === 'muscle') {
      // arrasta de osso para osso
      if (dragStartB < 0) flash('músculo precisa começar num osso');
      else if (dragLen > 10) {
        const endB = boneNear(px, py);
        if (endB < 0) flash('músculo precisa terminar num osso');
        else if (endB === dragStartB) flash('ossos precisam ser diferentes');
        else if (!addMuscle(dragStartB, endB)) flash('esse músculo já existe');
      }
    }
    dragStart = null; dragStartV = -1; dragStartB = -1; dragEnd = null;
  }

  // ---- render
  function render() {
    ctx.fillStyle = '#04080c';
    ctx.fillRect(0, 0, W, H);
    const floorY = H - FLOOR_PAD;

    // chão (com marcas de distância em EVOLVING para sentir progresso)
    ctx.strokeStyle = 'rgba(120, 220, 210, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, floorY);
    ctx.lineTo(W, floorY);
    ctx.stroke();

    if (state === STATE.EVOLVING) {
      drawRuler(floorY);
      drawFlag(floorY);
      drawOrganisms(floorY);
    } else {
      drawTemplate(floorY);
    }
  }

  function drawTemplate(floorY) {
    if (tVertices.length === 0) {
      ctx.fillStyle = 'rgba(150, 220, 210, 0.4)';
      ctx.font = '13px serif';
      ctx.textAlign = 'center';
      ctx.fillText('clique pra colocar a primeira articulação', W / 2, H / 2);
    }
    // ossos (linha sólida, destaca o hovered no modo músculo)
    for (let i = 0; i < tBones.length; i++) {
      const b = tBones[i];
      const v1 = tVertices[b.a], v2 = tVertices[b.b];
      const isStart = i === dragStartB;
      const isHover = (placementMode === 'muscle' && i === hoverB && !isStart);
      ctx.strokeStyle = isStart ? 'rgba(255, 200, 130, 1)'
                      : isHover ? 'rgba(180, 235, 220, 1)'
                      : 'rgba(210, 235, 230, 0.92)';
      ctx.lineWidth = (isStart || isHover) ? 3 : 2.2;
      ctx.beginPath(); ctx.moveTo(v1.x, v1.y); ctx.lineTo(v2.x, v2.y); ctx.stroke();
    }
    // músculos: linha tracejada entre os midpoints dos dois ossos
    ctx.strokeStyle = 'rgba(255, 130, 150, 0.85)';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 5]);
    for (const m of tMuscles) {
      const m1 = boneMid(m.ba), m2 = boneMid(m.bb);
      ctx.beginPath(); ctx.moveTo(m1.x, m1.y); ctx.lineTo(m2.x, m2.y); ctx.stroke();
      // pequenos discos nos pontos de fixação
      ctx.fillStyle = 'rgba(255, 130, 150, 0.7)';
      ctx.beginPath(); ctx.arc(m1.x, m1.y, 3, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(m2.x, m2.y, 3, 0, TAU); ctx.fill();
    }
    ctx.setLineDash([]);
    // preview do drag
    if (dragStart && dragEnd) {
      const dx = dragEnd.x - dragStart.x, dy = dragEnd.y - dragStart.y;
      if (dx * dx + dy * dy > 100) {
        const isMuscle = placementMode === 'muscle';
        const isBone = placementMode === 'bone';
        ctx.strokeStyle = isMuscle ? 'rgba(255, 130, 150, 0.55)' : isBone ? 'rgba(210, 235, 230, 0.55)' : 'rgba(150, 220, 210, 0.4)';
        ctx.lineWidth = 1.6;
        if (isMuscle) ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(dragStart.x, dragStart.y); ctx.lineTo(dragEnd.x, dragEnd.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // articulações
    for (let i = 0; i < tVertices.length; i++) {
      const v = tVertices[i];
      const isHover = (placementMode !== 'muscle' && i === hoverV);
      const isStart = i === dragStartV;
      ctx.fillStyle = isStart ? 'rgba(255, 200, 130, 1)' : isHover ? 'rgba(180, 235, 220, 1)' : 'rgba(140, 215, 205, 0.9)';
      ctx.beginPath(); ctx.arc(v.x, v.y, isHover || isStart ? VERTEX_R + 1 : VERTEX_R, 0, TAU); ctx.fill();
    }
  }

  function drawOrganisms(floorY) {
    // descobre o melhor atual (mais à direita)
    let leaderDist = -Infinity;
    for (const o of organisms) {
      const d = orgCenterX(o) - o.startX;
      if (d > leaderDist) leaderDist = d;
    }
    // organismo elite (i=0) é o pai da geração; destacar
    for (let i = 0; i < organisms.length; i++) {
      const org = organisms[i];
      const isElite = i === 0;
      const isLeader = (orgCenterX(org) - org.startX) === leaderDist;
      drawOrganism(org, isElite, isLeader);
    }
    // HUD (centro superior pra não brigar com o link "← ecossistema" e a bandeira)
    ctx.fillStyle = 'rgba(190, 235, 225, 0.85)';
    ctx.font = '13px serif';
    ctx.textAlign = 'center';
    ctx.fillText('geração ' + generation + ' · líder ' + Math.round(leaderDist) + ' px', W / 2, 28);
    if (autoBoom) {
      const remaining = Math.max(0, Math.round((autoBoomNext - performance.now()) / 1000));
      ctx.fillStyle = 'rgba(255, 200, 130, 0.85)';
      ctx.fillText('próximo boom em ' + remaining + 's', W / 2, 48);
    }
    if (speedMult > 1) {
      ctx.fillStyle = 'rgba(150, 230, 220, 0.7)';
      ctx.font = '11px serif';
      ctx.fillText('rápido ×' + speedMult, W / 2, autoBoom ? 66 : 48);
    }
  }

  function drawRuler(floorY) {
    const tickInterval = 50;
    const labelInterval = 200;
    const halfWorld = W / 2 / camScale;
    const startMark = Math.floor((camX - halfWorld) / tickInterval) * tickInterval;
    const endMark = Math.ceil((camX + halfWorld) / tickInterval) * tickInterval;
    ctx.strokeStyle = 'rgba(120, 220, 210, 0.32)';
    ctx.fillStyle = 'rgba(150, 230, 220, 0.7)';
    ctx.font = '10px serif';
    ctx.textAlign = 'center';
    for (let x = startMark; x <= endMark; x += tickInterval) {
      const sx = projX(x);
      const dist = x - START_X;
      const isLabel = (((dist % labelInterval) + labelInterval) % labelInterval) === 0;
      ctx.lineWidth = isLabel ? 1.2 : 0.8;
      ctx.beginPath();
      ctx.moveTo(sx, floorY);
      ctx.lineTo(sx, floorY + (isLabel ? 12 : 6));
      ctx.stroke();
      if (isLabel) {
        ctx.fillText(dist === 0 ? '0' : (dist + ''), sx, floorY + 20);
      }
    }
    // marca da linha de partida
    const sxStart = projX(START_X);
    ctx.strokeStyle = 'rgba(150, 230, 220, 0.55)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(sxStart, floorY - 40);
    ctx.lineTo(sxStart, floorY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawFlag(floorY) {
    if (flagX <= START_X) return;
    const sx = projX(flagX);
    // mastro
    ctx.strokeStyle = 'rgba(255, 200, 130, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, floorY);
    ctx.lineTo(sx, floorY - 40);
    ctx.stroke();
    // tecido da bandeira
    ctx.fillStyle = 'rgba(255, 200, 130, 0.95)';
    ctx.beginPath();
    ctx.moveTo(sx, floorY - 40);
    ctx.lineTo(sx + 18, floorY - 35);
    ctx.lineTo(sx, floorY - 28);
    ctx.closePath();
    ctx.fill();
    // distância anotada
    ctx.fillStyle = 'rgba(255, 200, 130, 0.85)';
    ctx.font = '11px serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(flagX - START_X) + ' px', sx, floorY - 46);
  }

  function drawOrganism(org, isElite, isLeader) {
    // ossos
    ctx.strokeStyle = isElite ? 'rgba(220, 240, 235, 0.95)' : isLeader ? 'rgba(200, 230, 225, 0.85)' : 'rgba(180, 215, 210, 0.55)';
    ctx.lineWidth = isElite ? 2.6 : isLeader ? 2.2 : 1.6;
    for (const b of org.bones) {
      const v1 = org.vertices[b.a], v2 = org.vertices[b.b];
      ctx.beginPath();
      ctx.moveTo(projX(v1.x), projY(v1.y));
      ctx.lineTo(projX(v2.x), projY(v2.y));
      ctx.stroke();
    }
    // músculos: linha entre os midpoints dos dois ossos, cor varia com a fase de contração
    for (let mi = 0; mi < org.muscles.length; mi++) {
      const m = org.muscles[mi];
      const b1 = org.bones[m.ba], b2 = org.bones[m.bb];
      const v1a = org.vertices[b1.a], v1b = org.vertices[b1.b];
      const v2a = org.vertices[b2.a], v2b = org.vertices[b2.b];
      const m1x = (v1a.x + v1b.x) * 0.5, m1y = (v1a.y + v1b.y) * 0.5;
      const m2x = (v2a.x + v2b.x) * 0.5, m2y = (v2a.y + v2b.y) * 0.5;
      const act = (org.activations && org.activations[mi]) || 0;
      const phase = (act + 1) * 0.5;
      const a = isElite ? 0.92 : isLeader ? 0.78 : 0.55;
      ctx.strokeStyle = 'hsla(' + (org.hue + phase * 40) + ', 75%, ' + (55 + phase * 18) + '%, ' + a + ')';
      ctx.lineWidth = isElite ? 2.4 : isLeader ? 2.0 : 1.5;
      ctx.beginPath();
      ctx.moveTo(projX(m1x), projY(m1y));
      ctx.lineTo(projX(m2x), projY(m2y));
      ctx.stroke();
    }
    // articulações
    ctx.fillStyle = isElite ? 'rgba(255, 200, 130, 0.95)' : isLeader ? 'rgba(255, 170, 190, 0.85)' : 'rgba(150, 220, 210, 0.7)';
    for (const v of org.vertices) {
      ctx.beginPath();
      ctx.arc(projX(v.x), projY(v.y), isElite ? 4 : 3, 0, TAU);
      ctx.fill();
    }
  }

  // ---- flashes / dicas
  let flashMsg = '', flashUntil = 0;
  function flash(msg, ms) {
    flashMsg = msg;
    flashUntil = performance.now() + (ms || 1800);
  }

  // ---- loop
  let lastTs = 0;
  function frame(ts) {
    const dt = Math.min(2, (ts - lastTs) / 16 || 1); // unidades aproximadas
    lastTs = ts;
    if (state === STATE.EVOLVING) {
      // executa N passos por quadro real quando "rápido" ligado
      for (let s = 0; s < speedMult; s++) {
        for (const org of organisms) step(org, STEP_DT);
      }
      // câmera segue o LÍDER (mais à direita) + atualiza recorde da bandeira
      let leaderX = -Infinity;
      for (const o of organisms) {
        const cx = orgCenterX(o);
        if (cx > leaderX) leaderX = cx;
        if (cx > flagX) flagX = cx;
      }
      if (leaderX > -Infinity) camX = lerp(camX, leaderX, 0.08);
      // auto-boom
      if (autoBoom && performance.now() >= autoBoomNext) boom();
    }
    render();
    // flash
    if (flashMsg && performance.now() < flashUntil) {
      ctx.fillStyle = 'rgba(255, 200, 130, 0.95)';
      ctx.font = '14px serif';
      ctx.textAlign = 'center';
      ctx.fillText(flashMsg, W / 2, 100);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
