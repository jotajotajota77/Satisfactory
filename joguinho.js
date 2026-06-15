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
  const FRICTION_GROUND_DEFAULT = 0.42; // 0 = escorregadio, 1 = grudado
  let frictionGround = FRICTION_GROUND_DEFAULT; // ajustável via slider em tempo real
  // tempo mínimo (em segundos) pra um músculo ir de -1 a +1 (ou vice-versa).
  // limita a velocidade de contração/relaxamento — quanto maior, mais lento o ciclo.
  let minCycleSec = 0.5;
  const VERTEX_R = 6;
  const HIT_R_VERTEX = 26; // raio de tolerância pra "clicar/arrastar até" uma articulação
  const HIT_R_BONE = 22;   // raio de tolerância pra "clicar/arrastar até" um osso
  const POP_SIZE = 50;
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
  let tMuscles = [];  // [{ba, bb, ta, tb}] (ossos + posição da fixação em [0,1])
  let history = [];   // pra desfazer (pilha de ações)
  let placementMode = 'joint'; // 'joint' | 'bone' | 'muscle' | 'structure' | 'sticky'
  let tStructIdx = -1; // índice da articulação marcada como "estrutura sensível" (-1 = nenhuma)
  let tStickyJoints = []; // índices de articulações aderentes (aderência sai da rede)

  // interação com mouse/toque
  let dragStart = null;     // {x, y} ponto inicial do drag
  let dragStartV = -1;      // índice de articulação se drag de joint
  let dragStartB = -1;      // índice de osso se drag de bone (modo músculo)
  let dragStartT = 0.5;     // t ∈ [0,1] do clique sobre o osso inicial (fixação do músculo)

  // ---- zoom/pan da tela de montagem
  let drawScale = 1;
  let drawPanX = 0;
  let drawPanY = 0;
  let pinchInitial = null;
  function screenToWorld(sx, sy) {
    return { x: (sx - drawPanX) / drawScale, y: (sy - drawPanY) / drawScale };
  }
  function resetDrawView() { drawScale = 1; drawPanX = 0; drawPanY = 0; }
  let dragEnd = null;       // {x, y} atual durante drag
  let hoverV = -1;
  let hoverB = -1;

  // organismos
  let organisms = [];
  let generation = 0;
  let bestEverDistance = 0;
  let flagX = START_X; // posição X (mundo) da bandeira: o mais longe já alcançado nesta sessão
  let flagH = 0;       // altura máxima já atingida (px acima do chão) — bandeira do modo "pular"
  let lastGenDistances = []; // distâncias da geração anterior (histograma de cima)
  let lastGenNumber = 0;     // número da geração cujas distâncias estão em lastGenDistances
  let allGenDistances = [];  // todas as distâncias acumuladas (histograma de baixo)

  // auto-boom: o tempo restante é em "ms de simulação", ou seja, anda mais
  // rápido quando o slider de velocidade está alto (assim quem acelera a
  // simulação também acelera o relógio do boom).
  let autoBoom = false;
  let autoBoomRemaining = 0;
  // se ligado, criaturas que acumularam ≥ 360° de rotação são desclassificadas
  // do BOOM. se nenhuma sobrar, nova ninhada aleatória.
  let punishSpin = false;
  // objetivo da evolução: 'run' (distância horizontal) ou 'jump' (altura máxima)
  let evolMode = 'run';
  function autoBoomReset() {
    autoBoomRemaining = (+autoSecs.value || 12) * 1000;
  }

  // velocidade da simulação (slider 0.1×–10×) com acumulador fracionário
  let speedMult = 1;
  let stepAccum = 0;

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
  const modeSticky = document.getElementById('mode-sticky');
  const structToggle = document.getElementById('struct-toggle');
  const undoBtn = document.getElementById('undo-btn');
  const clearBtn = document.getElementById('clear-btn');
  const startBtn = document.getElementById('start-btn');
  const boomBtn = document.getElementById('boom-btn');
  const autoToggle = document.getElementById('auto-toggle');
  const autoSecs = document.getElementById('auto-secs');
  const backBtn = document.getElementById('back-btn');
  const speedSlider = document.getElementById('speed-slider');
  const speedLabel = document.getElementById('speed-label');
  const frictionSlider = document.getElementById('friction-slider');
  const frictionLabel = document.getElementById('friction-label');
  const cycleSlider = document.getElementById('cycle-slider');
  const cycleLabel = document.getElementById('cycle-label');
  const punishSpinBtn = document.getElementById('punish-spin-btn');
  const modeEvolBtn = document.getElementById('mode-evol-btn');

  function setMode(m) {
    placementMode = m;
    modeJoint.classList.toggle('on', m === 'joint');
    modeBone.classList.toggle('on', m === 'bone');
    modeMuscle.classList.toggle('on', m === 'muscle');
    if (modeSticky) modeSticky.classList.toggle('on', m === 'sticky');
    if (structToggle) structToggle.classList.toggle('on', m === 'structure');
  }
  modeJoint.addEventListener('click', () => setMode('joint'));
  modeBone.addEventListener('click', () => setMode('bone'));
  modeMuscle.addEventListener('click', () => setMode('muscle'));
  if (modeSticky) modeSticky.addEventListener('click', () => setMode('sticky'));
  if (structToggle) structToggle.addEventListener('click', () => setMode('structure'));
  undoBtn.addEventListener('click', undo);
  clearBtn.addEventListener('click', clearTemplate);
  startBtn.addEventListener('click', start);
  boomBtn.addEventListener('click', boom);
  autoToggle.addEventListener('click', () => setAutoBoom(!autoBoom));
  backBtn.addEventListener('click', backToDrawing);
  function setSpeed(mult) {
    speedMult = clamp(+mult || 1, 0.1, 10);
    if (speedSlider) speedSlider.value = String(speedMult);
    if (speedLabel) speedLabel.textContent = speedMult.toFixed(1) + '×';
  }
  if (speedSlider) speedSlider.addEventListener('input', () => setSpeed(speedSlider.value));
  function setFriction(v) {
    frictionGround = clamp(+v, 0, 1);
    if (Number.isNaN(frictionGround)) frictionGround = FRICTION_GROUND_DEFAULT;
    if (frictionSlider) frictionSlider.value = String(frictionGround);
    if (frictionLabel) frictionLabel.textContent = frictionGround.toFixed(2);
  }
  if (frictionSlider) frictionSlider.addEventListener('input', () => setFriction(frictionSlider.value));
  function setCycle(v) {
    minCycleSec = clamp(+v, 0.05, 3);
    if (Number.isNaN(minCycleSec)) minCycleSec = 0.5;
    if (cycleSlider) cycleSlider.value = String(minCycleSec);
    if (cycleLabel) cycleLabel.textContent = minCycleSec.toFixed(2) + 's';
  }
  if (cycleSlider) cycleSlider.addEventListener('input', () => setCycle(cycleSlider.value));
  function setPunishSpin(on) {
    punishSpin = !!on;
    if (punishSpinBtn) {
      punishSpinBtn.classList.toggle('on', punishSpin);
      punishSpinBtn.textContent = punishSpin ? 'sem giro' : 'punir giro';
    }
  }
  if (punishSpinBtn) punishSpinBtn.addEventListener('click', () => setPunishSpin(!punishSpin));
  function setEvolMode(m) {
    evolMode = m === 'jump' ? 'jump' : 'run';
    if (modeEvolBtn) {
      modeEvolBtn.textContent = 'modo: ' + (evolMode === 'jump' ? 'pular' : 'correr');
      modeEvolBtn.classList.toggle('on', evolMode === 'jump');
    }
  }
  if (modeEvolBtn) modeEvolBtn.addEventListener('click', () => setEvolMode(evolMode === 'jump' ? 'run' : 'jump'));

  function setAutoBoom(on) {
    autoBoom = !!on;
    autoToggle.classList.toggle('on', autoBoom);
    autoToggle.textContent = autoBoom ? 'auto on' : 'auto';
    if (autoBoom) autoBoomReset();
  }

  // ---- desenho da criatura
  function vertexNear(x, y) {
    // toca a mais próxima dentro do raio de tolerância (dedos não miram pixel exato).
    // tolerância é em pixels de tela, então escala inversamente com o zoom.
    const tol = HIT_R_VERTEX / Math.max(0.1, drawScale);
    let best = -1, bestD2 = tol * tol;
    for (let i = tVertices.length - 1; i >= 0; i--) {
      const v = tVertices[i];
      const dx = v.x - x, dy = v.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    return best;
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
    const tol = HIT_R_BONE / Math.max(0.1, drawScale);
    let best = -1, bestD = tol;
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
  // ponto parametrico sobre um osso (t=0 → vértice a, t=1 → vértice b)
  function bonePoint(boneIdx, t) {
    const b = tBones[boneIdx];
    const v1 = tVertices[b.a], v2 = tVertices[b.b];
    return { x: v1.x + t * (v2.x - v1.x), y: v1.y + t * (v2.y - v1.y) };
  }
  // projeção de um ponto qualquer sobre um osso → devolve t em [0,1]
  function bonePointT(boneIdx, x, y) {
    const b = tBones[boneIdx];
    const v1 = tVertices[b.a], v2 = tVertices[b.b];
    const dx = v2.x - v1.x, dy = v2.y - v1.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1) return 0.5;
    return clamp(((x - v1.x) * dx + (y - v1.y) * dy) / len2, 0, 1);
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
  function addMuscle(ba, bb, ta, tb) {
    if (ba === bb || ba < 0 || bb < 0) return false;
    const tA = ta == null ? 0.5 : clamp(+ta, 0, 1);
    const tB = tb == null ? 0.5 : clamp(+tb, 0, 1);
    // duplicada só se for o mesmo par de ossos COM as mesmas fixações (≤ 0.05 de
    // tolerância) — assim o usuário pode conectar 2 músculos entre o mesmo par.
    for (const ex of tMuscles) {
      const sameBones = (ex.ba === ba && ex.bb === bb) || (ex.ba === bb && ex.bb === ba);
      if (!sameBones) continue;
      const eA = (ex.ba === ba) ? ex.ta : ex.tb;
      const eB = (ex.ba === ba) ? ex.tb : ex.ta;
      if (Math.abs(eA - tA) < 0.05 && Math.abs(eB - tB) < 0.05) return false;
    }
    tMuscles.push({ ba, bb, ta: tA, tb: tB });
    history.push({ kind: 'm' });
    return true;
  }
  function undo() {
    if (state !== STATE.DRAWING || !history.length) return;
    const h = history.pop();
    if (h.kind === 'v') {
      const removedIdx = tVertices.length - 1;
      tVertices.pop();
      if (tStructIdx === removedIdx) tStructIdx = -1;
      const sp = tStickyJoints.indexOf(removedIdx);
      if (sp >= 0) tStickyJoints.splice(sp, 1);
    } else if (h.kind === 'b') tBones.pop();
    else if (h.kind === 'm') tMuscles.pop();
  }
  function clearTemplate() {
    if (state !== STATE.DRAWING) return;
    tVertices = []; tBones = []; tMuscles = []; history = [];
    tStructIdx = -1;
    tStickyJoints = [];
    resetDrawView();
  }

  // ---- início da simulação
  function start() {
    if (state !== STATE.DRAWING) return;
    if (tVertices.length < 2) { flash('coloque ao menos 2 articulações'); return; }
    if (tBones.length < 2) { flash('coloque ao menos 2 ossos'); return; }
    if (tMuscles.length === 0 && tStickyJoints.length === 0) {
      flash('precisa de pelo menos 1 músculo ou 1 articulação aderente'); return;
    }
    state = STATE.EVOLVING;
    drawCtrl.classList.add('hidden');
    evolCtrl.classList.remove('hidden');
    if (infoEl) infoEl.style.display = 'none';
    generation = 1;
    bestEverDistance = 0;
    flagX = START_X; // bandeira começa na linha de partida
    flagH = 0;
    camX = START_X;
    organisms = [];
    lastGenDistances = []; lastGenNumber = 0;
    allGenDistances = [];
    for (let i = 0; i < POP_SIZE; i++) organisms.push(makeOrganism(randomGenome(), i));
    if (autoBoom) autoBoomReset();
  }

  function backToDrawing() {
    state = STATE.DRAWING;
    organisms = [];
    drawCtrl.classList.remove('hidden');
    evolCtrl.classList.add('hidden');
    if (infoEl) infoEl.style.display = '';
    setAutoBoom(false);
    setSpeed(1);
    stepAccum = 0;
  }

  // ---- genoma e organismo
  function randomGenome() {
    const M = tMuscles.length;
    const S = tStickyJoints.length;
    const OUT = M + S;
    const W1 = new Array(NN_INPUTS * NN_HIDDEN);
    for (let i = 0; i < W1.length; i++) W1[i] = (Math.random() - 0.5) * 1.6;
    const W2 = new Array(NN_HIDDEN * OUT);
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
    function pointAt(boneIdx, t) {
      const bb = tBones[boneIdx];
      const va = tVertices[bb.a], vb = tVertices[bb.b];
      return { x: va.x + t * (vb.x - va.x), y: va.y + t * (vb.y - va.y) };
    }
    const muscles = tMuscles.map((m) => {
      const ta = m.ta == null ? 0.5 : m.ta;
      const tb = m.tb == null ? 0.5 : m.tb;
      const m1 = pointAt(m.ba, ta), m2 = pointAt(m.bb, tb);
      const base = Math.max(2, dist(m1, m2));
      return { ba: m.ba, bb: m.bb, ta, tb, base };
    });
    const stickyJoints = tStickyJoints.slice();
    const OUT = muscles.length + stickyJoints.length;
    return {
      vertices, bones, muscles,
      stickyJoints,
      time: 0, startX,
      genome,
      activations: new Array(OUT).fill(0),       // versão suavizada (rate-limited) usada na física
      rawActivations: new Array(OUT).fill(0),    // saída crua da rede
      hue: (idx * 53) % 360,
      structureIdx: tStructIdx,
      structPoints: 0,    // 1 ponto / segundo / articulação que ficou acima da estrutura
      totalRotation: 0,   // rotação acumulada do corpo todo (rad)
      peakRotation: 0,    // maior |totalRotation| já atingido — pega quem gira 360° e volta
      maxHeight: 0,       // maior altura (em px acima do chão) já atingida por qualquer articulação
    };
  }
  // métrica de fitness conforme o modo: distância horizontal (correr) ou altura máxima (pular)
  function orgMetric(org) {
    return evolMode === 'jump' ? org.maxHeight : (orgCenterX(org) - org.startX);
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
    const S = org.stickyJoints.length;
    const OUT = M + S;
    const acts = new Array(OUT);
    for (let m = 0; m < OUT; m++) {
      let s = 0;
      for (let h = 0; h < NN_HIDDEN; h++) s += hidden[h] * W2[h * OUT + m];
      acts[m] = Math.tanh(s);
    }
    return acts;
  }
  function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  // ---- física (Verlet)
  function step(org, dt) {
    org.time += dt;
    const floorY = H - FLOOR_PAD;
    // rede neural calcula a ativação CRUA de cada músculo a partir do estado atual
    org.rawActivations = controllerActivations(org, floorY);
    // físico: sem apoio no chão, músculo não tem alavanca pra aplicar força.
    // zera a ativação se NENHUMA articulação toca o chão — assim o organismo
    // não "nada" pelo ar nem muda de direção sem anteparo.
    let onGround = false;
    for (const v of org.vertices) {
      if (v.y >= floorY - 2) { onGround = true; break; }
    }
    if (!onGround) {
      for (let i = 0; i < org.rawActivations.length; i++) org.rawActivations[i] = 0;
    }
    // limita a velocidade de contração/relaxamento: ir de -1 a +1 leva no mínimo
    // minCycleSec segundos. dt/60 ≈ segundos por passo.
    const maxDelta = (2 / Math.max(0.05, minCycleSec)) * (dt / 60);
    for (let i = 0; i < org.rawActivations.length; i++) {
      const diff = org.rawActivations[i] - org.activations[i];
      const change = diff > maxDelta ? maxDelta : (diff < -maxDelta ? -maxDelta : diff);
      org.activations[i] += change;
    }
    // integração
    for (const v of org.vertices) {
      const vx = (v.x - v.px) * VELOCITY_DAMPING;
      const vy = (v.y - v.py) * VELOCITY_DAMPING;
      v.px = v.x; v.py = v.y;
      v.x += vx;
      v.y += vy + GRAVITY * dt;
    }
    // mapeia vértice → aderência individual (saída [M..M+S) da rede). vai de 0 (escorrega)
    // a 1 (grudado). só substitui o atrito do chão se o vértice for "aderente".
    const M = org.muscles.length;
    const stickyAdh = new Map();
    for (let si = 0; si < org.stickyJoints.length; si++) {
      const idx = org.stickyJoints[si];
      const out = org.activations[M + si] || 0;
      stickyAdh.set(idx, clamp((out + 1) * 0.5, 0, 1));
    }
    // restrições
    for (let it = 0; it < ITERATIONS; it++) {
      for (const b of org.bones) satisfyDistance(org.vertices[b.a], org.vertices[b.b], b.length, 0.5);
      for (let mi = 0; mi < M; mi++) {
        const m = org.muscles[mi];
        const amp = org.genome.amp[mi];
        const target = Math.max(2, m.base * (1 + amp * org.activations[mi]));
        satisfyMuscle(org, m, target, MUSCLE_K);
      }
      // chão + atrito (sticky usa aderência individual; resto usa o slider)
      for (let vi = 0; vi < org.vertices.length; vi++) {
        const v = org.vertices[vi];
        if (v.y > floorY) {
          v.y = floorY;
          const f = stickyAdh.has(vi) ? stickyAdh.get(vi) : frictionGround;
          v.px += (v.x - v.px) * f;
        }
      }
    }
    // pontuação da estrutura sensível: penaliza ter articulações acima dela
    // (no canvas y cresce pra baixo, então "acima" significa y menor).
    // dt está em "unidades de quadro"; STEP_DT≈0.6 ≈ 36ms ≈ 0.036s pra
    // converter aproximadamente em segundos.
    if (org.structureIdx >= 0 && org.structureIdx < org.vertices.length) {
      const sv = org.vertices[org.structureIdx];
      let aboveCount = 0;
      for (let i = 0; i < org.vertices.length; i++) {
        if (i === org.structureIdx) continue;
        if (org.vertices[i].y < sv.y) aboveCount++;
      }
      // dt~0.6 por quadro → ~0.6*60≈36 "ticks/s"; divide pra ficar em segundos
      org.structPoints += aboveCount * (dt / 60);
    }
    // rotação acumulada: velocidade angular do corpo inteiro (corpo rígido idealizado)
    //   ω = Σ(r × v) / Σ(r²), onde r é a posição relativa ao centróide e v é a
    // velocidade do vértice. integra frame a frame. captura rotação de cambalhota
    // do corpo todo, mesmo quando articulações individuais oscilam sem girar.
    {
      let cx = 0, cy = 0;
      for (const v of org.vertices) { cx += v.x; cy += v.y; }
      cx /= org.vertices.length; cy /= org.vertices.length;
      let cross = 0, rSq = 0;
      for (const v of org.vertices) {
        const rx = v.x - cx, ry = v.y - cy;
        const vx = v.x - v.px, vy = v.y - v.py;
        cross += rx * vy - ry * vx;
        rSq += rx * rx + ry * ry;
      }
      if (rSq > 0.01) {
        org.totalRotation += cross / rSq;
        const abs = Math.abs(org.totalRotation);
        if (abs > org.peakRotation) org.peakRotation = abs;
      }
    }
    // altura máxima já atingida (em px acima do chão) — alimenta o modo "pular"
    let minY = Infinity;
    for (const v of org.vertices) if (v.y < minY) minY = v.y;
    const h = floorY - minY;
    if (h > org.maxHeight) org.maxHeight = h;
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
    const ta = m.ta, tb = m.tb;
    const ta_ = 1 - ta, tb_ = 1 - tb;
    // pontos de fixação paramétricos
    const m1x = ta_ * v1a.x + ta * v1b.x;
    const m1y = ta_ * v1a.y + ta * v1b.y;
    const m2x = tb_ * v2a.x + tb * v2b.x;
    const m2y = tb_ * v2a.y + tb * v2b.y;
    const dx = m2x - m1x, dy = m2y - m1y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.0001) return;
    const factor = (d - target) / d * k;
    const fx = dx * factor, fy = dy * factor;
    // translação uniforme: cada osso se move como um todo (mais estável que
    // distribuir por t, evita explosões em fixações extremas)
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
    // métrica de cada um conforme o modo (distância ou altura máxima)
    const metrics = organisms.map(orgMetric);
    // guarda as métricas dessa geração pro histograma da próxima
    lastGenDistances = metrics.slice();
    lastGenNumber = generation;
    // acumula no histograma global de todas as gerações
    for (const d of metrics) allGenDistances.push(d);
    // elegibilidade: "punir giro" exclui quem em algum momento atingiu ≥360°
    // (2π rad) de rotação acumulada do corpo todo. usa o PICO, não o net atual —
    // assim quem girou pra frente e voltou também é pego.
    const eligible = [];
    if (punishSpin) {
      for (let i = 0; i < organisms.length; i++) {
        if (organisms[i].peakRotation < TAU) eligible.push(i);
      }
    } else {
      for (let i = 0; i < organisms.length; i++) eligible.push(i);
    }
    generation++;
    // se nenhuma criatura passou no filtro, gera ninhada toda aleatória
    if (eligible.length === 0) {
      organisms = [];
      for (let i = 0; i < POP_SIZE; i++) organisms.push(makeOrganism(randomGenome(), i));
      camX = START_X;
      if (autoBoom) autoBoomReset();
      flash('todas giraram 360° — nova ninhada aleatória', 2200);
      return;
    }
    // seleciona o melhor entre os elegíveis
    const usesStructure = tStructIdx >= 0;
    let bestIdx = eligible[0];
    if (!usesStructure) {
      let bestM = -Infinity;
      for (const i of eligible) {
        if (metrics[i] > bestM) { bestM = metrics[i]; bestIdx = i; }
      }
    } else {
      const points = organisms.map(o => o.structPoints);
      let maxM = 1, maxPts = 1;
      for (const i of eligible) {
        const mp = Math.max(0, metrics[i]);
        if (mp > maxM) maxM = mp;
        if (points[i] > maxPts) maxPts = points[i];
      }
      let bestFit = -Infinity;
      for (const i of eligible) {
        const mn = Math.max(0, metrics[i]) / maxM;
        const pn = points[i] / maxPts;
        const fit = 0.5 * (mn + (1 - pn));
        if (fit > bestFit) { bestFit = fit; bestIdx = i; }
      }
    }
    const bestM = metrics[bestIdx];
    const baseGenome = cloneGenome(organisms[bestIdx].genome);
    if (bestM > bestEverDistance) bestEverDistance = bestM;
    // nova geração: 1 elite + (POP_SIZE-1) mutações
    organisms = [];
    organisms.push(makeOrganism(baseGenome, 0)); // elite (sem mutação)
    for (let i = 1; i < POP_SIZE; i++) {
      const strength = i === POP_SIZE - 1 ? 0.6 : 0.22; // último é explorador (mutação alta)
      organisms.push(makeOrganism(mutateGenome(baseGenome, strength), i));
    }
    camX = START_X;
    if (autoBoom) autoBoomReset();
  }

  // ---- input
  function eventXY(e) {
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX, y: t.clientY };
  }
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  // touch: 2 dedos = pinch (zoom + pan), 1 dedo = desenho
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (state === STATE.DRAWING && e.touches.length === 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dx = t2.clientX - t1.clientX, dy = t2.clientY - t1.clientY;
      pinchInitial = {
        dist: Math.sqrt(dx * dx + dy * dy),
        midX: (t1.clientX + t2.clientX) / 2,
        midY: (t1.clientY + t2.clientY) / 2,
        scale0: drawScale, panX0: drawPanX, panY0: drawPanY,
      };
      dragStart = null; dragStartV = -1; dragStartB = -1; dragEnd = null;
      return;
    }
    pinchInitial = null;
    onDown(e);
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (pinchInitial && e.touches.length >= 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dx = t2.clientX - t1.clientX, dy = t2.clientY - t1.clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;
      const newScale = clamp(pinchInitial.scale0 * (dist / pinchInitial.dist), 0.3, 6);
      // ponto inicial entre os dedos fica preso ao mesmo ponto do mundo
      const wx = (pinchInitial.midX - pinchInitial.panX0) / pinchInitial.scale0;
      const wy = (pinchInitial.midY - pinchInitial.panY0) / pinchInitial.scale0;
      drawPanX = midX - wx * newScale;
      drawPanY = midY - wy * newScale;
      drawScale = newScale;
      return;
    }
    if (pinchInitial) return;
    onMove(e);
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (pinchInitial) {
      if (e.touches.length === 0) pinchInitial = null;
      return;
    }
    onUp(e);
  }, { passive: false });
  // wheel: zoom no cursor (desktop)
  canvas.addEventListener('wheel', (e) => {
    if (state !== STATE.DRAWING) return;
    e.preventDefault();
    const newScale = clamp(drawScale * Math.exp(-e.deltaY * 0.001), 0.3, 6);
    const wx = (e.clientX - drawPanX) / drawScale;
    const wy = (e.clientY - drawPanY) / drawScale;
    drawPanX = e.clientX - wx * newScale;
    drawPanY = e.clientY - wy * newScale;
    drawScale = newScale;
  }, { passive: false });

  function onDown(e) {
    if (state !== STATE.DRAWING) return;
    const p = eventXY(e);
    dragStart = { x: p.x, y: p.y };
    dragEnd = { x: p.x, y: p.y };
    dragStartV = -1; dragStartB = -1;
    const w = screenToWorld(p.x, p.y);
    if (placementMode === 'joint') {
      // só vai adicionar no onUp se for um clique (sem arrastar)
    } else if (placementMode === 'bone') {
      dragStartV = vertexNear(w.x, w.y);
    } else if (placementMode === 'muscle') {
      dragStartB = boneNear(w.x, w.y);
      if (dragStartB >= 0) dragStartT = bonePointT(dragStartB, w.x, w.y);
    }
  }
  function onMove(e) {
    const p = eventXY(e);
    if (state === STATE.DRAWING) {
      const w = screenToWorld(p.x, p.y);
      hoverV = (placementMode !== 'muscle') ? vertexNear(w.x, w.y) : -1;
      hoverB = (placementMode === 'muscle') ? boneNear(w.x, w.y) : -1;
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
    const w = screenToWorld(px, py);
    if (placementMode === 'joint') {
      if (dragLen < 10) addVertex(w.x, w.y);
      else flash('no modo articulação, só clique pra colocar pontos');
    } else if (placementMode === 'structure') {
      if (dragLen < 14) {
        const vi = vertexNear(w.x, w.y);
        if (vi < 0) flash('clique numa articulação pra marcá-la como estrutura sensível');
        else if (tStructIdx === vi) tStructIdx = -1;
        else tStructIdx = vi;
      }
    } else if (placementMode === 'sticky') {
      if (dragLen < 14) {
        const vi = vertexNear(w.x, w.y);
        if (vi < 0) flash('clique numa articulação pra alternar a aderência');
        else {
          const pos = tStickyJoints.indexOf(vi);
          if (pos >= 0) tStickyJoints.splice(pos, 1);
          else tStickyJoints.push(vi);
        }
      }
    } else if (placementMode === 'bone') {
      if (dragStartV < 0) flash('osso precisa começar numa articulação');
      else if (dragLen > 10) {
        const endV = vertexNear(w.x, w.y);
        if (endV < 0) flash('osso precisa terminar numa articulação');
        else if (endV === dragStartV) flash('articulações precisam ser diferentes');
        else if (!addBone(dragStartV, endV)) flash('esse osso já existe');
      }
    } else if (placementMode === 'muscle') {
      if (dragStartB < 0) flash('músculo precisa começar num osso');
      else if (dragLen > 10) {
        const endB = boneNear(w.x, w.y);
        if (endB < 0) flash('músculo precisa terminar num osso');
        else if (endB === dragStartB) flash('ossos precisam ser diferentes');
        else {
          const endT = bonePointT(endB, w.x, w.y);
          if (!addMuscle(dragStartB, endB, dragStartT, endT)) flash('esse músculo já existe');
        }
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
      ctx.fillText('clique pra colocar a primeira articulação · pinça/roda pra zoom', W / 2, H / 2);
    }
    // tudo desenhado a seguir vai no espaço da criatura (sob zoom+pan).
    ctx.save();
    ctx.translate(drawPanX, drawPanY);
    ctx.scale(drawScale, drawScale);
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
    // músculos: linha tracejada entre os pontos de fixação dos dois ossos
    ctx.strokeStyle = 'rgba(255, 130, 150, 0.85)';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 5]);
    for (const m of tMuscles) {
      const m1 = bonePoint(m.ba, m.ta), m2 = bonePoint(m.bb, m.tb);
      ctx.beginPath(); ctx.moveTo(m1.x, m1.y); ctx.lineTo(m2.x, m2.y); ctx.stroke();
      // pequenos discos nos pontos de fixação
      ctx.fillStyle = 'rgba(255, 130, 150, 0.7)';
      ctx.beginPath(); ctx.arc(m1.x, m1.y, 3, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(m2.x, m2.y, 3, 0, TAU); ctx.fill();
    }
    ctx.setLineDash([]);
    // preview do drag (dragStart/dragEnd estão em coords de TELA — converte pra mundo)
    if (dragStart && dragEnd) {
      const wsx = (dragStart.x - drawPanX) / drawScale;
      const wsy = (dragStart.y - drawPanY) / drawScale;
      const wex = (dragEnd.x - drawPanX) / drawScale;
      const wey = (dragEnd.y - drawPanY) / drawScale;
      const sdx = dragEnd.x - dragStart.x, sdy = dragEnd.y - dragStart.y;
      if (sdx * sdx + sdy * sdy > 100) {
        const isMuscle = placementMode === 'muscle';
        const isBone = placementMode === 'bone';
        ctx.strokeStyle = isMuscle ? 'rgba(255, 130, 150, 0.55)' : isBone ? 'rgba(210, 235, 230, 0.55)' : 'rgba(150, 220, 210, 0.4)';
        ctx.lineWidth = 1.6 / drawScale;
        if (isMuscle) ctx.setLineDash([6 / drawScale, 5 / drawScale]);
        ctx.beginPath(); ctx.moveTo(wsx, wsy); ctx.lineTo(wex, wey); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // articulações
    for (let i = 0; i < tVertices.length; i++) {
      const v = tVertices[i];
      const isHover = (placementMode !== 'muscle' && i === hoverV);
      const isStart = i === dragStartV;
      const isStruct = (i === tStructIdx);
      const isSticky = tStickyJoints.indexOf(i) >= 0;
      ctx.fillStyle = isStart ? 'rgba(255, 200, 130, 1)' : isHover ? 'rgba(180, 235, 220, 1)' : 'rgba(140, 215, 205, 0.9)';
      ctx.beginPath(); ctx.arc(v.x, v.y, isHover || isStart ? VERTEX_R + 1 : VERTEX_R, 0, TAU); ctx.fill();
      if (isStruct) drawStructMark(v.x, v.y, 'rgba(255, 200, 130, 0.95)');
      if (isSticky) {
        ctx.strokeStyle = 'rgba(120, 180, 255, 0.9)';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(v.x, v.y, VERTEX_R + 5, 0, TAU); ctx.stroke();
      }
    }
    ctx.restore();
    // dica do modo estrutura (espaço de tela)
    if (placementMode === 'structure' && tVertices.length > 0) {
      ctx.fillStyle = 'rgba(255, 200, 130, 0.7)';
      ctx.font = '11px serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        tStructIdx < 0
          ? 'clique numa articulação para marcá-la como estrutura sensível'
          : 'estrutura escolhida · clique nela de novo para desmarcar',
        W / 2, floorY - 24
      );
    }
    // indicador de zoom (canto inferior esquerdo, discreto)
    if (Math.abs(drawScale - 1) > 0.02) {
      ctx.fillStyle = 'rgba(190, 235, 225, 0.5)';
      ctx.font = '10px serif';
      ctx.textAlign = 'left';
      ctx.fillText('zoom ' + drawScale.toFixed(2) + '×', 14, floorY - 12);
    }
  }

  // pequeno losango ao redor da articulação marcada como estrutura sensível
  function drawStructMark(x, y, color) {
    const r = VERTEX_R + 6;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.stroke();
  }

  function drawOrganisms(floorY) {
    // melhor atual conforme a métrica do modo (correr = distância; pular = altura)
    let leaderM = -Infinity;
    for (const o of organisms) {
      const m = orgMetric(o);
      if (m > leaderM) leaderM = m;
    }
    // organismo elite (i=0) é o pai da geração; destacar
    for (let i = 0; i < organisms.length; i++) {
      const org = organisms[i];
      const isElite = i === 0;
      const isLeader = orgMetric(org) === leaderM;
      drawOrganism(org, isElite, isLeader);
    }
    // HUD: posiciona logo abaixo dos histogramas pra não brigar com eles à
    // direita. antes do primeiro BOOM (ainda não há histograma), sobe pro topo.
    const isNarrow = W < 600;
    const panelH = isNarrow ? 120 : 150;
    const havePanels = lastGenDistances.length > 0;
    const hudY = havePanels ? (14 + panelH * 2 + 8 + 22) : 28;
    ctx.fillStyle = 'rgba(190, 235, 225, 0.85)';
    ctx.font = '13px serif';
    ctx.textAlign = 'center';
    const metricName = evolMode === 'jump' ? 'altura' : 'dist';
    let hud = 'geração ' + generation + ' · ' + metricName + ' líder ' + Math.round(leaderM) + ' px';
    if (organisms.length && organisms[0].structureIdx >= 0) {
      // mostra a menor pontuação da estrutura (melhor) entre os organismos
      let minPts = Infinity;
      for (const o of organisms) if (o.structPoints < minPts) minPts = o.structPoints;
      hud += ' · est. sens. min ' + minPts.toFixed(1);
    }
    ctx.fillText(hud, W / 2, hudY);
    if (autoBoom) {
      // mostra os segundos reais que faltam (já compensa a velocidade)
      const realRemaining = Math.max(0, Math.round(autoBoomRemaining / Math.max(0.01, speedMult) / 1000));
      ctx.fillStyle = 'rgba(255, 200, 130, 0.85)';
      ctx.fillText('próximo boom em ' + realRemaining + 's', W / 2, hudY + 20);
    }
    if (Math.abs(speedMult - 1) > 0.05) {
      ctx.fillStyle = speedMult > 1 ? 'rgba(255, 200, 130, 0.85)' : 'rgba(150, 230, 220, 0.7)';
      ctx.font = '11px serif';
      ctx.fillText(speedMult.toFixed(1) + '×', W / 2, hudY + (autoBoom ? 38 : 20));
    }
    drawHistograms();
  }

  // ---- histogramas: o de cima é só a geração anterior, o de baixo acumula tudo
  function drawHistograms() {
    const isNarrow = W < 600;
    const panelW = isNarrow ? Math.min(220, W - 32) : 280;
    const panelH = isNarrow ? 120 : 150;
    const x0 = W - panelW - 14;
    const gap = 8;

    if (lastGenDistances.length) {
      drawHistogramPanel(
        lastGenDistances,
        'geração ' + lastGenNumber + ' · ' + lastGenDistances.length + ' ind.',
        x0, 14, panelW, panelH
      );
    }
    if (allGenDistances.length) {
      drawHistogramPanel(
        allGenDistances,
        'acumulado · ' + allGenDistances.length + ' ind.',
        x0, 14 + panelH + gap, panelW, panelH
      );
    }
  }

  function drawHistogramPanel(data, title, x0, y0, panelW, panelH) {
    const BINS = 10;

    // fundo
    ctx.fillStyle = 'rgba(16, 26, 36, 0.92)';
    ctx.strokeStyle = 'rgba(150, 235, 215, 0.45)';
    ctx.lineWidth = 1;
    roundRect(x0, y0, panelW, panelH, 10);
    ctx.fill();
    ctx.stroke();

    // título
    ctx.fillStyle = 'rgba(190, 235, 225, 0.7)';
    ctx.font = '10px serif';
    ctx.textAlign = 'left';
    ctx.fillText(title, x0 + 12, y0 + 14);

    // bins (min/max/intervalo recalculados a partir dos próprios dados)
    let minD = Infinity, maxD = -Infinity;
    for (const d of data) { if (d < minD) minD = d; if (d > maxD) maxD = d; }
    const range = Math.max(1, maxD - minD);
    const bins = new Array(BINS).fill(0);
    for (const d of data) {
      let b = Math.floor((d - minD) / range * BINS);
      if (b >= BINS) b = BINS - 1;
      if (b < 0) b = 0;
      bins[b]++;
    }
    let maxCount = 0;
    for (const c of bins) if (c > maxCount) maxCount = c;
    if (maxCount === 0) maxCount = 1;

    // layout da área do gráfico
    const padTop = 24, padBot = 22, padLeft = 14, padRight = 14;
    const chartX = x0 + padLeft;
    const chartY = y0 + padTop;
    const chartW = panelW - padLeft - padRight;
    const chartH = panelH - padTop - padBot;
    const barW = chartW / BINS;

    // linha-base
    ctx.strokeStyle = 'rgba(150, 235, 215, 0.20)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartX, chartY + chartH + 0.5);
    ctx.lineTo(chartX + chartW, chartY + chartH + 0.5);
    ctx.stroke();

    // barras: do menor (rosa) ao maior (teal)
    for (let i = 0; i < BINS; i++) {
      const h = (bins[i] / maxCount) * chartH;
      const bx = chartX + i * barW;
      const by = chartY + chartH - h;
      const t = i / Math.max(1, BINS - 1);
      const hue = lerp(340, 170, t);
      ctx.fillStyle = 'hsla(' + hue + ', 65%, 60%, 0.85)';
      ctx.fillRect(bx + 1, by, Math.max(1, barW - 2), h);
      if (bins[i] > 0 && barW > 14) {
        ctx.fillStyle = 'rgba(190, 235, 225, 0.55)';
        ctx.font = '9px serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(bins[i]), bx + barW / 2, by - 2);
      }
    }

    // rótulos do eixo (min e max)
    ctx.fillStyle = 'rgba(190, 235, 225, 0.55)';
    ctx.font = '9px serif';
    ctx.textAlign = 'left';
    ctx.fillText(Math.round(minD) + ' px', chartX, chartY + chartH + 12);
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxD) + ' px', chartX + chartW, chartY + chartH + 12);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
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
    if (evolMode === 'jump') {
      // linha horizontal marcando o recorde de altura desta sessão
      if (flagH <= 0) return;
      const sy = projY(floorY - flagH);
      ctx.strokeStyle = 'rgba(255, 200, 130, 0.7)';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(W, sy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255, 200, 130, 0.85)';
      ctx.font = '11px serif';
      ctx.textAlign = 'left';
      ctx.fillText(Math.round(flagH) + ' px', 12, sy - 4);
      return;
    }
    // modo correr: mastro vertical com bandeira na posição máxima
    if (flagX <= START_X) return;
    const sx = projX(flagX);
    ctx.strokeStyle = 'rgba(255, 200, 130, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, floorY);
    ctx.lineTo(sx, floorY - 40);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 200, 130, 0.95)';
    ctx.beginPath();
    ctx.moveTo(sx, floorY - 40);
    ctx.lineTo(sx + 18, floorY - 35);
    ctx.lineTo(sx, floorY - 28);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 200, 130, 0.85)';
    ctx.font = '11px serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(flagX - START_X) + ' px', sx, floorY - 46);
  }

  function drawOrganism(org, isElite, isLeader) {
    // "punir giro" ligado + organismo já passou de 360°: tinge de vermelho e desfoca
    const spunOut = punishSpin && org.peakRotation >= TAU;
    if (spunOut) {
      ctx.strokeStyle = 'rgba(255, 90, 110, 0.35)';
      ctx.lineWidth = 1.4;
    } else {
      ctx.strokeStyle = isElite ? 'rgba(220, 240, 235, 0.95)' : isLeader ? 'rgba(200, 230, 225, 0.85)' : 'rgba(180, 215, 210, 0.55)';
      ctx.lineWidth = isElite ? 2.6 : isLeader ? 2.2 : 1.6;
    }
    for (const b of org.bones) {
      const v1 = org.vertices[b.a], v2 = org.vertices[b.b];
      ctx.beginPath();
      ctx.moveTo(projX(v1.x), projY(v1.y));
      ctx.lineTo(projX(v2.x), projY(v2.y));
      ctx.stroke();
    }
    // músculos: linha entre os pontos de fixação dos dois ossos, cor varia com a fase de contração
    for (let mi = 0; mi < org.muscles.length; mi++) {
      const m = org.muscles[mi];
      const b1 = org.bones[m.ba], b2 = org.bones[m.bb];
      const v1a = org.vertices[b1.a], v1b = org.vertices[b1.b];
      const v2a = org.vertices[b2.a], v2b = org.vertices[b2.b];
      const ta_ = 1 - m.ta, tb_ = 1 - m.tb;
      const m1x = ta_ * v1a.x + m.ta * v1b.x, m1y = ta_ * v1a.y + m.ta * v1b.y;
      const m2x = tb_ * v2a.x + m.tb * v2b.x, m2y = tb_ * v2a.y + m.tb * v2b.y;
      const act = (org.activations && org.activations[mi]) || 0;
      const phase = (act + 1) * 0.5;
      const a = spunOut ? 0.25 : (isElite ? 0.92 : isLeader ? 0.78 : 0.55);
      ctx.strokeStyle = spunOut
        ? 'rgba(255, 90, 110, ' + a + ')'
        : 'hsla(' + (org.hue + phase * 40) + ', 75%, ' + (55 + phase * 18) + '%, ' + a + ')';
      ctx.lineWidth = spunOut ? 1.2 : (isElite ? 2.4 : isLeader ? 2.0 : 1.5);
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
    // marca da estrutura sensível
    if (org.structureIdx >= 0 && org.structureIdx < org.vertices.length) {
      const sv = org.vertices[org.structureIdx];
      const a = isElite ? 0.95 : isLeader ? 0.85 : 0.55;
      drawStructMark(projX(sv.x), projY(sv.y), 'rgba(255, 200, 130, ' + a + ')');
    }
    // articulações aderentes: anel azul cuja opacidade reflete a aderência atual
    if (org.stickyJoints && org.stickyJoints.length) {
      const Mm = org.muscles.length;
      for (let si = 0; si < org.stickyJoints.length; si++) {
        const idx = org.stickyJoints[si];
        if (idx >= org.vertices.length) continue;
        const sv = org.vertices[idx];
        const out = org.activations[Mm + si] || 0;
        const adh = clamp((out + 1) * 0.5, 0, 1);
        const baseA = isElite ? 0.95 : isLeader ? 0.85 : 0.6;
        const a = baseA * (0.25 + 0.75 * adh);
        ctx.strokeStyle = 'rgba(120, 180, 255, ' + a + ')';
        ctx.lineWidth = isElite ? 1.8 : 1.4;
        ctx.beginPath();
        ctx.arc(projX(sv.x), projY(sv.y), (isElite ? 6 : 5), 0, TAU);
        ctx.stroke();
      }
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
      // velocidade variável: acumulador fracionário deixa < 1× (passo só a cada
      // alguns quadros) e > 1× (vários passos por quadro) sem perder precisão.
      stepAccum += speedMult;
      let safety = 0;
      while (stepAccum >= 1 && safety++ < 50) {
        for (const org of organisms) step(org, STEP_DT);
        stepAccum -= 1;
      }
      // câmera + bandeira: no modo correr segue quem foi mais à direita;
      // no modo pular fica parada na partida (horizontal é irrelevante) e
      // a bandeira vira a maior altura já atingida.
      if (evolMode === 'run') {
        let leaderX = -Infinity;
        for (const o of organisms) {
          const cx = orgCenterX(o);
          if (cx > leaderX) leaderX = cx;
          if (cx > flagX) flagX = cx;
        }
        if (leaderX > -Infinity) camX = lerp(camX, leaderX, 0.08);
      } else {
        for (const o of organisms) {
          if (o.maxHeight > flagH) flagH = o.maxHeight;
        }
        camX = lerp(camX, START_X, 0.08);
      }
      // auto-boom: relógio anda em "ms de simulação" (acompanha a velocidade)
      if (autoBoom) {
        autoBoomRemaining -= dt * 16 * speedMult;
        if (autoBoomRemaining <= 0) boom();
      }
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
