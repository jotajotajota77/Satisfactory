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
  const VELOCITY_DAMPING = 0.992;
  const ITERATIONS = 8;
  const FRICTION_GROUND = 0.32; // 0 = escorregadio, 1 = grudado
  const VERTEX_R = 6;
  const POP_SIZE = 6;
  const FLOOR_PAD = 90; // pixels do chão até a borda inferior

  // ---- estado
  const STATE = { DRAWING: 0, EVOLVING: 1 };
  let state = STATE.DRAWING;

  // template (desenho do usuário)
  let tVertices = []; // [{x, y}]
  let tBones = [];    // [{a, b}] (índices)
  let tMuscles = [];  // [{a, b}]
  let history = [];   // pra desfazer (pilha de ações)
  let placementMode = 'bone'; // 'bone' | 'muscle'

  // interação com mouse/toque
  let dragStart = null;     // {x, y} ponto inicial do drag
  let dragStartIdx = -1;    // índice do vértice se for de um vértice
  let dragEnd = null;       // {x, y} atual durante drag
  let hoverIdx = -1;

  // organismos
  let organisms = [];
  let generation = 0;
  let bestEverDistance = 0;

  // auto-boom
  let autoBoom = false;
  let autoBoomNext = 0;
  let autoBoomLastShown = 0;

  // câmera (rola na evolução)
  let camX = 0;

  // ---- DOM
  const infoEl = document.getElementById('info');
  const drawCtrl = document.getElementById('draw-controls');
  const evolCtrl = document.getElementById('evol-controls');
  const modeBone = document.getElementById('mode-bone');
  const modeMuscle = document.getElementById('mode-muscle');
  const undoBtn = document.getElementById('undo-btn');
  const clearBtn = document.getElementById('clear-btn');
  const startBtn = document.getElementById('start-btn');
  const boomBtn = document.getElementById('boom-btn');
  const autoToggle = document.getElementById('auto-toggle');
  const autoSecs = document.getElementById('auto-secs');
  const backBtn = document.getElementById('back-btn');

  function setMode(m) {
    placementMode = m;
    modeBone.classList.toggle('on', m === 'bone');
    modeMuscle.classList.toggle('on', m === 'muscle');
  }
  modeBone.addEventListener('click', () => setMode('bone'));
  modeMuscle.addEventListener('click', () => setMode('muscle'));
  undoBtn.addEventListener('click', undo);
  clearBtn.addEventListener('click', clearTemplate);
  startBtn.addEventListener('click', start);
  boomBtn.addEventListener('click', boom);
  autoToggle.addEventListener('click', () => setAutoBoom(!autoBoom));
  backBtn.addEventListener('click', backToDrawing);

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
  function addVertex(x, y) {
    tVertices.push({ x, y });
    history.push({ kind: 'v' });
    return tVertices.length - 1;
  }
  function addBone(a, b) {
    if (a === b) return;
    tBones.push({ a, b });
    history.push({ kind: 'b' });
  }
  function addMuscle(a, b) {
    if (a === b) return;
    tMuscles.push({ a, b });
    history.push({ kind: 'm' });
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
    if (tVertices.length < 2 || (tBones.length + tMuscles.length) < 1) {
      flash('precisa de ao menos 2 pontos ligados');
      return;
    }
    if (tMuscles.length === 0) {
      flash('sem músculos não tem movimento — adicione pelo menos 1');
      return;
    }
    state = STATE.EVOLVING;
    drawCtrl.classList.add('hidden');
    evolCtrl.classList.remove('hidden');
    generation = 1;
    bestEverDistance = 0;
    camX = 0;
    // primeira geração com genomas aleatórios
    organisms = [];
    for (let i = 0; i < POP_SIZE; i++) {
      organisms.push(makeOrganism(randomGenome(), i));
    }
    if (autoBoom) autoBoomNext = performance.now() + (+autoSecs.value || 12) * 1000;
  }

  function backToDrawing() {
    state = STATE.DRAWING;
    organisms = [];
    drawCtrl.classList.remove('hidden');
    evolCtrl.classList.add('hidden');
    setAutoBoom(false);
  }

  // ---- genoma e organismo
  function randomGenome() {
    const g = [];
    for (let i = 0; i < tMuscles.length; i++) {
      g.push({
        freq: rand(0.03, 0.18),
        phase: rand(TAU),
        amp: rand(0.15, 0.55),
      });
    }
    return g;
  }
  function mutateGenome(g, strength) {
    return g.map((gene) => ({
      freq: clamp(gene.freq + (Math.random() - 0.5) * strength * 0.08 + (Math.random() < 0.03 ? (Math.random() - 0.5) * 0.2 : 0), 0.02, 0.4),
      phase: gene.phase + (Math.random() - 0.5) * strength * TAU * 0.4,
      amp: clamp(gene.amp + (Math.random() - 0.5) * strength * 0.25 + (Math.random() < 0.03 ? (Math.random() - 0.5) * 0.4 : 0), 0.05, 0.7),
    }));
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
    const startX = 180;
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
    const muscles = tMuscles.map((m, i) => {
      const base = dist(tVertices[m.a], tVertices[m.b]);
      return {
        a: m.a, b: m.b, base,
        freq: genome[i].freq,
        phase: genome[i].phase,
        amp: genome[i].amp,
      };
    });
    return {
      vertices, bones, muscles,
      time: 0, startX,
      genome,
      hue: (idx * 53) % 360,
    };
  }
  function cloneGenome(g) { return g.map(x => ({ freq: x.freq, phase: x.phase, amp: x.amp })); }
  function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  // ---- física (Verlet)
  function step(org, dt) {
    org.time += dt;
    const floorY = H - FLOOR_PAD;
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
      for (const m of org.muscles) {
        const target = m.base * (1 + m.amp * Math.sin(org.time * m.freq + m.phase));
        satisfyDistance(org.vertices[m.a], org.vertices[m.b], Math.max(2, target), 0.5);
      }
      // chão + atrito
      for (const v of org.vertices) {
        if (v.y > floorY) {
          v.y = floorY;
          // atrito horizontal: empurra px em direção a x (reduz vx)
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
    camX = 0;
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
    const idx = vertexNear(p.x, p.y);
    if (idx >= 0) {
      dragStartIdx = idx;
      dragStart = { x: tVertices[idx].x, y: tVertices[idx].y };
    } else {
      // clica em espaço vazio: adiciona vértice E começa drag dele
      const newIdx = addVertex(p.x, p.y);
      dragStartIdx = newIdx;
      dragStart = { x: p.x, y: p.y };
    }
    dragEnd = { x: p.x, y: p.y };
  }
  function onMove(e) {
    const p = eventXY(e);
    if (state === STATE.DRAWING) {
      hoverIdx = vertexNear(p.x, p.y);
      if (dragStart) dragEnd = { x: p.x, y: p.y };
    }
  }
  function onUp(e) {
    if (state !== STATE.DRAWING || !dragStart) { dragStart = null; dragStartIdx = -1; dragEnd = null; return; }
    const p = e && (e.changedTouches ? e.changedTouches[0] : e);
    const px = p ? (p.clientX != null ? p.clientX : dragEnd.x) : dragEnd.x;
    const py = p ? (p.clientY != null ? p.clientY : dragEnd.y) : dragEnd.y;
    // se moveu suficiente, cria ligação até onde soltou
    const dx = px - dragStart.x, dy = py - dragStart.y;
    const dragLen = Math.sqrt(dx * dx + dy * dy);
    if (dragLen > 10) {
      const targetIdx = vertexNear(px, py);
      let endIdx = targetIdx;
      if (endIdx < 0 || endIdx === dragStartIdx) {
        endIdx = addVertex(px, py);
      }
      if (placementMode === 'bone') addBone(dragStartIdx, endIdx);
      else addMuscle(dragStartIdx, endIdx);
    }
    dragStart = null; dragStartIdx = -1; dragEnd = null;
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
      // marcas de 50 px (rolando com a câmera)
      ctx.strokeStyle = 'rgba(120, 220, 210, 0.15)';
      ctx.lineWidth = 1;
      const tickStart = Math.floor(camX / 50) * 50;
      for (let x = tickStart; x < tickStart + W + 50; x += 50) {
        const sx = x - camX;
        ctx.beginPath();
        ctx.moveTo(sx, floorY);
        ctx.lineTo(sx, floorY + (x % 200 === 0 ? 12 : 6));
        ctx.stroke();
      }
      drawOrganisms(floorY);
    } else {
      drawTemplate(floorY);
    }
  }

  function drawTemplate(floorY) {
    // dica visual: linha do chão
    if (tVertices.length === 0) {
      ctx.fillStyle = 'rgba(150, 220, 210, 0.4)';
      ctx.font = '13px serif';
      ctx.textAlign = 'center';
      ctx.fillText('clique aqui pra começar', W / 2, H / 2);
    }
    // ossos
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = 'rgba(210, 235, 230, 0.95)';
    for (const b of tBones) {
      const v1 = tVertices[b.a], v2 = tVertices[b.b];
      ctx.beginPath(); ctx.moveTo(v1.x, v1.y); ctx.lineTo(v2.x, v2.y); ctx.stroke();
    }
    // músculos (linha tracejada vermelha)
    ctx.strokeStyle = 'rgba(255, 130, 150, 0.85)';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 5]);
    for (const m of tMuscles) {
      const v1 = tVertices[m.a], v2 = tVertices[m.b];
      ctx.beginPath(); ctx.moveTo(v1.x, v1.y); ctx.lineTo(v2.x, v2.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    // preview do drag
    if (dragStart && dragEnd) {
      const isMuscle = placementMode === 'muscle';
      ctx.strokeStyle = isMuscle ? 'rgba(255, 130, 150, 0.5)' : 'rgba(210, 235, 230, 0.5)';
      ctx.lineWidth = 1.6;
      if (isMuscle) ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(dragStart.x, dragStart.y); ctx.lineTo(dragEnd.x, dragEnd.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    // vértices
    for (let i = 0; i < tVertices.length; i++) {
      const v = tVertices[i];
      const isHover = i === hoverIdx;
      const isStart = i === dragStartIdx;
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
    // HUD
    ctx.fillStyle = 'rgba(190, 235, 225, 0.85)';
    ctx.font = '13px serif';
    ctx.textAlign = 'left';
    ctx.fillText('geração ' + generation, 20, H - 16);
    ctx.fillText('distância: ' + Math.round(leaderDist) + ' px · melhor histórica: ' + Math.round(bestEverDistance) + ' px', 130, H - 16);
    if (autoBoom) {
      const remaining = Math.max(0, Math.round((autoBoomNext - performance.now()) / 1000));
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255, 200, 130, 0.85)';
      ctx.fillText('próximo boom em ' + remaining + 's', W - 20, H - 16);
    }
  }

  function drawOrganism(org, isElite, isLeader) {
    const ofs = -camX;
    // músculos (mostra contração com cor variando)
    for (const m of org.muscles) {
      const v1 = org.vertices[m.a], v2 = org.vertices[m.b];
      const phase = (Math.sin(org.time * m.freq + m.phase) + 1) * 0.5; // 0..1
      const a = isElite ? 0.85 : isLeader ? 0.7 : 0.45;
      ctx.strokeStyle = 'hsla(' + (org.hue + phase * 40) + ', 75%, ' + (55 + phase * 15) + '%, ' + a + ')';
      ctx.lineWidth = isElite ? 2.6 : isLeader ? 2.2 : 1.6;
      ctx.beginPath(); ctx.moveTo(v1.x + ofs, v1.y); ctx.lineTo(v2.x + ofs, v2.y); ctx.stroke();
    }
    // ossos
    ctx.strokeStyle = isElite ? 'rgba(220, 240, 235, 0.95)' : isLeader ? 'rgba(200, 230, 225, 0.85)' : 'rgba(180, 215, 210, 0.5)';
    ctx.lineWidth = isElite ? 2.4 : isLeader ? 2.0 : 1.4;
    for (const b of org.bones) {
      const v1 = org.vertices[b.a], v2 = org.vertices[b.b];
      ctx.beginPath(); ctx.moveTo(v1.x + ofs, v1.y); ctx.lineTo(v2.x + ofs, v2.y); ctx.stroke();
    }
    // vértices (articulações)
    ctx.fillStyle = isElite ? 'rgba(255, 200, 130, 0.95)' : isLeader ? 'rgba(255, 170, 190, 0.85)' : 'rgba(150, 220, 210, 0.6)';
    for (const v of org.vertices) {
      ctx.beginPath(); ctx.arc(v.x + ofs, v.y, isElite ? 4 : 3, 0, TAU); ctx.fill();
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
      for (let s = 0; s < 1; s++) {
        for (const org of organisms) step(org, 1);
      }
      // câmera segue a média ponderada (puxando levemente o líder)
      let avg = 0;
      for (const o of organisms) avg += orgCenterX(o);
      avg /= organisms.length;
      const target = Math.max(0, avg - W * 0.35);
      camX = lerp(camX, target, 0.05);
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
