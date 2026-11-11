/* game.js — 화면, 입력, 렌더링, 진행 저장 */
(function () {
  'use strict';

  const { WORLD, TUNE, PuzzleWorld, searchGen, replayWins } = window.WSMPhysics;
  const LEVELS = window.WSM_LEVELS;
  const Audio = window.WSMAudio;
  const $ = id => document.getElementById(id);
  const TIER = { beginner: '초급', intermediate: '중급', advanced: '고급' };

  /* ---------- 저장 ---------- */
  const SAVE_KEY = 'wood-screw-master.save.v1';
  const Save = {
    data: { unlocked: 1, stars: {}, best: {}, sound: true, last: 1 },
    load() {
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return;
        const d = JSON.parse(raw);
        if (d && typeof d === 'object') {
          this.data.unlocked = Math.min(LEVELS.length, Math.max(1, d.unlocked | 0));
          this.data.stars = d.stars && typeof d.stars === 'object' ? d.stars : {};
          this.data.best = d.best && typeof d.best === 'object' ? d.best : {};
          this.data.sound = d.sound !== false;
          this.data.last = Math.min(this.data.unlocked, Math.max(1, d.last | 0));
        }
      } catch (e) { /* 손상되었거나 접근 불가하면 새로 시작 */ }
    },
    write() {
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.data)); } catch (e) { /* 저장 불가 환경 */ }
    },
    totalStars() { return Object.values(this.data.stars).reduce((a, b) => a + (b | 0), 0); }
  };

  function starsFor(level, moves) {
    if (moves <= level.targetMoves) return 3;
    if (moves <= level.targetMoves + Math.ceil((level.moveLimit - level.targetMoves) / 2)) return 2;
    return 1;
  }

  /* ---------- 상태 ---------- */
  const G = {
    mode: 'title', idx: 0, level: null, world: null,
    moves: 0, stack: [], sel: -1, anim: null,
    hint: null, hintPlan: null, searchId: 0, searching: false,
    dirty: false, pendingEnd: 0, shake: {}, screwRot: [],
    particles: [], lastThud: 0, time: 0, tipTimer: 0
  };

  /* ---------- 캔버스 ---------- */
  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  let scale = 1;
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    scale = canvas.width / WORLD.W;
  }
  window.addEventListener('resize', resize);

  /* ---------- 절차적 텍스처 ---------- */
  function seeded(n) {
    let a = n * 2654435761 >>> 0;
    return () => {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h); return c; }

  const WOOD = {
    oak: { hi: '#d7a767', lo: '#ab7a41', grain: '#6e4420', side: '#6e4722' },
    walnut: { hi: '#8c6040', lo: '#5f3d25', grain: '#2d1a0d', side: '#35200f' },
    maple: { hi: '#eccb98', lo: '#cfa873', grain: '#94683a', side: '#8d6a3e' },
    cherry: { hi: '#c67a51', lo: '#964f30', grain: '#5a2a15', side: '#5c2e18' },
    ash: { hi: '#e4d5b3', lo: '#bda984', grain: '#85714e', side: '#7f6c4b' }
  };

  function grain(g, rng, x0, y0, w, h, color, density) {
    g.strokeStyle = color;
    const n = Math.floor(h * density);
    for (let i = 0; i < n; i++) {
      const y = y0 + rng() * h;
      const amp = 1 + rng() * 5, freq = 0.006 + rng() * 0.012, ph = rng() * 7;
      g.globalAlpha = 0.07 + rng() * 0.2;
      g.lineWidth = 0.5 + rng() * 1.5;
      g.beginPath();
      for (let x = x0; x <= x0 + w; x += 10) {
        const yy = y + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 3.1 + ph) * amp * 0.25;
        if (x === x0) g.moveTo(x, yy); else g.lineTo(x, yy);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  let bgCanvas = null;
  function buildBackground() {
    const S = 1.5, c = mk(WORLD.W * S, WORLD.H * S), g = c.getContext('2d');
    g.scale(S, S);
    const rng = seeded(77);
    const plankH = 142;
    for (let row = 0; row * plankH < WORLD.H; row++) {
      const y = row * plankH;
      const t = rng();
      const base = g.createLinearGradient(0, y, 0, y + plankH);
      base.addColorStop(0, `hsl(${30 + t * 5}, ${38 + t * 8}%, ${61 + t * 7}%)`);
      base.addColorStop(1, `hsl(${28 + t * 5}, ${36 + t * 8}%, ${52 + t * 7}%)`);
      g.fillStyle = base;
      g.fillRect(0, y, WORLD.W, plankH);
      g.save(); g.beginPath(); g.rect(0, y, WORLD.W, plankH); g.clip();
      grain(g, rng, 0, y, WORLD.W, plankH, '#6f4a26', 0.2);
      g.restore();
      g.fillStyle = '#3b2412aa'; g.fillRect(0, y + plankH - 2.5, WORLD.W, 2.5);
      g.fillStyle = '#ffeccb55'; g.fillRect(0, y, WORLD.W, 1.5);
      const joint = (rng() * 500 + 100) | 0;
      g.fillStyle = '#3b241299'; g.fillRect(joint, y, 2.5, plankH);
    }
    const v = g.createRadialGradient(360, 620, 260, 360, 640, 860);
    v.addColorStop(0, '#2a140000'); v.addColorStop(1, '#2a1400a8');
    g.fillStyle = v; g.fillRect(0, 0, WORLD.W, WORLD.H);
    bgCanvas = c;
  }

  function boardPath(b) {
    const p = new Path2D();
    if (b.shape === 'rect') {
      const r = 15, w = b.w / 2, h = b.h / 2;
      p.moveTo(-w + r, -h); p.arcTo(w, -h, w, h, r); p.arcTo(w, h, -w, h, r); p.arcTo(-w, h, -w, -h, r); p.arcTo(-w, -h, w, -h, r);
      p.closePath();
    } else {
      b.verts.forEach((v, i) => { if (i) p.lineTo(v.x, v.y); else p.moveTo(v.x, v.y); });
      p.closePath();
    }
    return p;
  }

  function drawSocket(g, x, y, r) {
    const out = g.createRadialGradient(x, y - 1, r * 0.2, x, y, r + 3);
    out.addColorStop(0, '#0d0704'); out.addColorStop(0.75, '#1e110a'); out.addColorStop(1, '#00000044');
    g.fillStyle = out;
    g.beginPath(); g.arc(x, y, r + 3, 0, 7); g.fill();
    g.strokeStyle = '#ffe4bd55'; g.lineWidth = 1.4;
    g.beginPath(); g.arc(x, y, r + 3, 0.3, 2.9); g.stroke();
  }

  function makeBoardSprite(b) {
    const S = 2, pad = 6;
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    b.verts.forEach(v => { mnx = Math.min(mnx, v.x); mny = Math.min(mny, v.y); mxx = Math.max(mxx, v.x); mxy = Math.max(mxy, v.y); });
    const w = mxx - mnx + pad * 2, h = mxy - mny + pad * 2;
    const c = mk(w * S, h * S), g = c.getContext('2d');
    const tone = WOOD[b.wood] || WOOD.oak;
    const path = boardPath(b);
    g.scale(S, S);
    g.translate(pad - mnx, pad - mny);
    g.save();
    g.clip(path);
    const lg = g.createLinearGradient(0, mny, 0, mxy);
    lg.addColorStop(0, tone.hi); lg.addColorStop(0.55, tone.lo); lg.addColorStop(1, tone.hi);
    g.fillStyle = lg;
    g.fillRect(mnx, mny, mxx - mnx, mxy - mny);
    const rng = seeded(b.idx * 13 + b.id.length + 5 + Math.round(b.verts[0].x));
    grain(g, rng, mnx, mny, mxx - mnx, mxy - mny, tone.grain, 0.42);
    const knots = rng() < 0.7 ? 1 + Math.floor(rng() * 2) : 0;
    for (let i = 0; i < knots; i++) {
      const kx = mnx + rng() * (mxx - mnx), ky = mny + rng() * (mxy - mny), kr = 7 + rng() * 9;
      g.strokeStyle = tone.grain;
      for (let r = kr; r > 1; r -= 2.5) {
        g.globalAlpha = 0.22; g.lineWidth = 1.1;
        g.beginPath(); g.ellipse(kx, ky, r * 1.5, r, 0, 0, 7); g.stroke();
      }
      g.globalAlpha = 0.4; g.fillStyle = tone.grain;
      g.beginPath(); g.ellipse(kx, ky, 3, 2, 0, 0, 7); g.fill();
      g.globalAlpha = 1;
    }
    g.lineJoin = 'round';
    g.strokeStyle = '#fff3d74d'; g.lineWidth = 7; g.stroke(path);
    g.restore();
    g.lineJoin = 'round';
    g.strokeStyle = '#2d180a66'; g.lineWidth = 1.6; g.stroke(path);
    b.holes.forEach(h => drawSocket(g, h.x, h.y, 14));
    return { canvas: c, ox: mnx - pad, oy: mny - pad, w, h, path, tone };
  }

  /* ---------- 레벨 진행 ---------- */
  function startLevel(i) {
    G.idx = i;
    G.level = LEVELS[i];
    const world = new PuzzleWorld(G.level);
    G.world = world;
    world.on('impact', e => onImpact(e));
    world.on('fall', e => onFall(e));
    G.sprites = world.def.boards.map(makeBoardSprite);
    G.screwRot = world.level.screws.map((s, k) => (k * 2.4 + 0.5) % Math.PI);
    G.particles = [];
    clearRun();
    Save.data.last = i + 1;
    Save.write();
    setMode('play');
    const tip = G.level.tip;
    const el = $('hud-tip');
    el.textContent = tip || '';
    el.classList.toggle('show', !!tip);
    G.tipTimer = tip ? 7000 : 0;
    updateHud();
  }

  function clearRun() {
    G.moves = 0; G.stack = []; G.sel = -1; G.anim = null;
    G.hint = null; G.hintPlan = null; G.dirty = false; G.pendingEnd = 0;
    G.shake = {};
    cancelSearch();
  }

  function restartLevel() {
    if (!G.world) return;
    G.world.reset();
    clearRun();
    G.mode = 'play';
    hideOverlay();
    updateHud();
    Audio.play('undo');
  }

  function cancelSearch() {
    G.searchId++;
    G.searching = false;
    $('btn-hint').classList.remove('busy');
  }

  function undo() {
    if (G.anim || !G.stack.length || G.mode === 'clear') return;
    const prev = G.stack.pop();
    cancelSearch();
    G.world.restore(prev.snap);
    G.moves = prev.moves;
    G.sel = -1; G.hint = null; G.dirty = false; G.pendingEnd = 0;
    G.mode = 'play';
    hideOverlay();
    updateHud();
    Audio.play('undo');
  }

  function updateHud() {
    const lv = G.level;
    if (!lv) return;
    $('hud-tier').textContent = TIER[lv.difficulty];
    $('hud-level').textContent = lv.levelId + '단계';
    $('hud-used').textContent = G.moves;
    $('hud-limit').textContent = lv.moveLimit;
    document.querySelector('.hud-moves').classList.toggle('warn', lv.moveLimit - G.moves <= 2);
    $('btn-undo').disabled = !G.stack.length;
  }

  function checkOutcome() {
    if (!G.dirty || G.anim || !G.world.settled) return;
    G.dirty = false;
    if (G.world.won()) { G.pendingEnd = 480; G.endKind = 'clear'; return; }
    if (G.moves >= G.level.moveLimit) { G.pendingEnd = 380; G.endKind = 'moves'; return; }
    if (G.world.legalMoves().length === 0) { G.pendingEnd = 380; G.endKind = 'stuck'; }
  }

  function finishLevel() {
    const lv = G.level, id = lv.levelId;
    const stars = starsFor(lv, G.moves);
    const best = Save.data.best[id];
    const newBest = !best || G.moves < best;
    if (newBest) Save.data.best[id] = G.moves;
    Save.data.stars[id] = Math.max(Save.data.stars[id] | 0, stars);
    if (id < LEVELS.length) Save.data.unlocked = Math.max(Save.data.unlocked, id + 1);
    Save.write();
    G.mode = 'clear';
    const isLast = id >= LEVELS.length;
    showPanel(`
      <h3>${id}단계 클리어</h3>
      <div class="stars"><div class="star"></div><div class="star"></div><div class="star"></div></div>
      <div class="result-line"><span>사용한 이동</span><b>${G.moves}</b></div>
      <div class="result-line"><span>목표 이동</span><b>${lv.targetMoves}</b></div>
      <div class="result-line"><span>최고 기록</span><b>${Save.data.best[id]}</b></div>
      ${newBest && best ? '<p class="new-best">최고 기록 갱신!</p>' : ''}
      ${isLast ? '<p>30단계를 모두 끝냈습니다. 공방의 장인이 되셨습니다.</p>' : ''}
      ${isLast ? '' : '<button class="btn primary" data-act="next">다음 단계</button>'}
      <div class="row"><button class="btn" data-act="restart">다시 하기</button><button class="btn" data-act="levels">단계 선택</button></div>
    `);
    Audio.play('win');
    const nodes = $('panel').querySelectorAll('.star');
    for (let i = 0; i < stars; i++) {
      setTimeout(() => { if (nodes[i]) { nodes[i].classList.add('lit'); Audio.play('star', i); } }, 380 + i * 300);
    }
  }

  function failLevel(kind) {
    G.mode = 'fail';
    Audio.play('fail');
    const msg = kind === 'moves'
      ? '이동 횟수를 모두 썼습니다.'
      : '옮길 수 있는 나사나 빈 구멍이 없습니다.';
    showPanel(`
      <h3>실패</h3>
      <p>${msg}</p>
      ${G.stack.length ? '<button class="btn primary" data-act="undo">한 수 되돌리기</button>' : ''}
      <div class="row"><button class="btn" data-act="restart">재시작</button><button class="btn" data-act="levels">단계 선택</button></div>
    `);
  }

  /* ---------- 힌트 ---------- */
  function occupancy(list) { return list.slice().sort((a, b) => a - b).join(','); }

  /** plan(이동 목록)에서 현재 나사 배치와 같은 지점을 찾아 남은 수순을 돌려준다. */
  function suffixFromPlan(plan, snap) {
    const current = occupancy(snap.s.map(s => s.h));
    let holes = G.world.level.screws.map(s => G.world.def.holeIndex[s.holeId]);
    for (let k = 0; k <= plan.length; k++) {
      if (occupancy(holes) === current) {
        const rest = plan.slice(k);
        if (rest.length && rest.length <= G.level.moveLimit - G.moves && replayWins(G.level, snap, rest)) return rest;
      }
      if (k < plan.length) {
        const at = holes.indexOf(plan[k].from);
        if (at < 0) break;
        holes[at] = plan[k].to;
      }
    }
    return null;
  }

  function levelPlan() {
    const idx = G.world.def.holeIndex;
    return G.level.solution.map(m => ({ from: idx[m.from], to: idx[m.to] }));
  }

  function requestHint() {
    if (G.mode !== 'play' || G.anim || G.searching) return;
    if (!G.world.settled) { toast('판자가 멈춘 뒤 힌트를 볼 수 있습니다.'); return; }
    if (G.world.won()) return;
    const snap = G.world.snapshot();
    const left = G.level.moveLimit - G.moves;
    if (left <= 0) { toast('남은 이동이 없습니다. 되돌리기나 재시작을 해 보세요.'); return; }
    G.sel = -1;
    const known = (G.hintPlan && suffixFromPlan(G.hintPlan, snap)) || suffixFromPlan(levelPlan(), snap);
    if (known) { showHint(known); return; }

    // 정답 경로를 벗어났다면 현재 상태에서 실제 물리로 재탐색한다.
    const gen = searchGen(G.level, snap, { maxDepth: left, maxEdges: 2600, weight: 1.7 });
    const id = ++G.searchId;
    G.searching = true;
    $('btn-hint').classList.add('busy');
    toast('현재 상태에서 해법을 찾는 중…');
    const started = performance.now();
    const pump = () => {
      if (id !== G.searchId) return;
      const t0 = performance.now();
      let r;
      do { r = gen.next(); } while (!r.done && performance.now() - t0 < 12);
      if (!r.done && performance.now() - started > 6000) {
        gen.return();
        r = { done: true, value: { found: false, exhausted: false } };
      }
      if (!r.done) { requestAnimationFrame(pump); return; }
      G.searching = false;
      $('btn-hint').classList.remove('busy');
      const res = r.value;
      if (res.found && res.path.length) {
        G.hintPlan = res.path.map(m => ({ from: m.from, to: m.to }));
        showHint(G.hintPlan);
      } else if (res.exhausted) {
        toast('이 상태에서는 남은 이동으로 풀 수 없습니다. 되돌리기나 재시작을 권합니다.', 3400);
      } else {
        toast('해법을 찾지 못했습니다. 되돌리기나 재시작을 권합니다.', 3400);
      }
    };
    requestAnimationFrame(pump);
  }

  function showHint(moves) {
    const m = moves[0];
    const si = G.world.screwAtHole(m.from);
    if (si < 0) return;
    G.hint = { si, to: m.to, from: m.from };
    Audio.play('hint');
    toast('표시된 나사를 빛나는 구멍으로 옮기세요.', 1800);
  }

  /* ---------- 입력 ---------- */
  let activePointer = null, downX = 0, downY = 0, lastTap = 0;

  function toLogical(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * WORLD.W / r.width, y: (ev.clientY - r.top) * WORLD.H / r.height };
  }

  canvas.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    if (activePointer !== null || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    activePointer = ev.pointerId;
    downX = ev.clientX; downY = ev.clientY;
    Audio.unlock();
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 일부 환경 미지원 */ }
  });
  canvas.addEventListener('pointerup', ev => {
    if (ev.pointerId !== activePointer) return;
    ev.preventDefault();
    activePointer = null;
    const r = canvas.getBoundingClientRect();
    const slop = r.width * 0.05;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > slop) return;
    const now = performance.now();
    if (now - lastTap < 70) return;
    lastTap = now;
    handleTap(toLogical(ev));
  });
  const dropPointer = ev => { if (ev.pointerId === activePointer) activePointer = null; };
  canvas.addEventListener('pointercancel', dropPointer);
  canvas.addEventListener('lostpointercapture', dropPointer);
  canvas.addEventListener('contextmenu', ev => ev.preventDefault());
  document.addEventListener('touchmove', ev => {
    if (!ev.target.closest || !ev.target.closest('.levels-scroll')) ev.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', ev => ev.preventDefault());
  document.addEventListener('dblclick', ev => ev.preventDefault());

  function handleTap(p) {
    if (G.mode !== 'play' || G.anim || G.pendingEnd > 0 || G.world.won()) return;
    const w = G.world;
    const HIT = 52;
    let best = null, bestD = HIT;

    if (G.sel >= 0) {
      w.legalTargets(G.sel).forEach(hi => {
        const h = w.def.holes[hi];
        const d = Math.hypot(h.x - p.x, h.y - p.y);
        if (d < bestD) { bestD = d; best = { kind: 'hole', hi }; }
      });
    }
    w.st.s.forEach((s, si) => {
      const h = w.def.holes[s.h];
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d < bestD) { bestD = d; best = { kind: 'screw', si }; }
    });

    if (!best) {
      if (G.sel >= 0) { G.sel = -1; Audio.play('cancel'); }
      return;
    }
    if (best.kind === 'hole') { beginMove(G.sel, best.hi); return; }
    if (best.si === G.sel) { G.sel = -1; Audio.play('cancel'); return; }
    if (!w.screwAccessible(best.si)) {
      G.shake[best.si] = 280;
      Audio.play('deny');
      toast('위 판자에 덮여 있어 집을 수 없습니다.');
      return;
    }
    G.sel = best.si;
    Audio.play('select');
  }

  function beginMove(si, hi) {
    const w = G.world;
    if (!w.isLegal(si, hi)) return;
    const from = w.def.holes[w.st.s[si].h], to = w.def.holes[hi];
    G.anim = { si, hi, stage: 0, t: 0, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, committed: false };
    G.sel = -1;
    G.hint = null;
    cancelSearch();
    $('hud-tip').classList.remove('show');
    Audio.play('unscrew');
  }

  const ANIM = [150, 280, 170];
  function advanceAnim(dt) {
    const a = G.anim;
    if (!a) return;
    a.t += dt;
    G.screwRot[a.si] += dt * (a.stage === 2 ? 0.022 : a.stage === 0 ? -0.022 : 0.004);
    if (a.t < ANIM[a.stage]) return;
    a.t = 0;
    if (a.stage === 0) {
      const w = G.world;
      const snap = w.snapshot();
      if (!w.commit(a.si, a.hi)) { G.anim = null; return; }
      G.stack.push({ snap, moves: G.moves });
      G.moves++;
      G.dirty = true;
      updateHud();
      dust(a.from.x, a.from.y, 6, 0.8);
    }
    if (a.stage === 1) Audio.play('screwIn');
    a.stage++;
    if (a.stage >= ANIM.length) G.anim = null;
  }

  /* ---------- 효과 ---------- */
  function dust(x, y, n, power) {
    for (let i = 0; i < n && G.particles.length < 140; i++) {
      const a = Math.random() * 6.28, sp = (0.6 + Math.random() * 2.6) * power;
      G.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.4,
        life: 0, max: 380 + Math.random() * 420, r: 2 + Math.random() * 5,
        c: Math.random() < 0.5 ? '#d8bb8e' : '#a9875c'
      });
    }
  }
  function onImpact(e) {
    dust(e.x, e.y, Math.min(10, 3 + e.speed | 0), 1);
    const now = performance.now();
    if (now - G.lastThud > 70) { G.lastThud = now; Audio.play('thud', e.speed / 14); }
  }
  function onFall(e) {
    const x = Math.max(60, Math.min(660, e.x));
    dust(x, 1110, 16, 2.1);
    Audio.play('fall');
  }

  let toastTimer = 0;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 1600);
  }

  /* ---------- 그리기 ---------- */
  function drawBoard(i) {
    const w = G.world, b = w.def.boards[i], sp = G.sprites[i], pose = w.pose(i);
    if (w.st.b[i].g) return;
    const lift = b.layer * 3;
    ctx.save(); ctx.translate(pose.x + 7 + lift, pose.y + 12 + lift); ctx.rotate(pose.a);
    ctx.fillStyle = '#1c0e0555'; ctx.fill(sp.path); ctx.restore();
    ctx.save(); ctx.translate(pose.x, pose.y + 7); ctx.rotate(pose.a);
    ctx.fillStyle = sp.tone.side; ctx.fill(sp.path); ctx.restore();
    ctx.save(); ctx.translate(pose.x, pose.y); ctx.rotate(pose.a);
    ctx.drawImage(sp.canvas, sp.ox, sp.oy, sp.w, sp.h);
    ctx.restore();
  }

  const METAL = {
    brass: ['#fff0ba', '#dba943', '#8a6221', '#533811'],
    silver: ['#ffffff', '#c4c8ce', '#70757d', '#3b3e44']
  };
  function drawScrew(si, x, y, s, selected) {
    const metal = METAL[G.level.screws[si].metal] || METAL.brass;
    const r = TUNE.HEAD_R * s;
    if (selected) {
      const pulse = 0.72 + Math.sin(G.time * 0.008) * 0.2;
      const gl = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2.5);
      gl.addColorStop(0, `rgba(255,222,130,${0.82 * pulse})`);
      gl.addColorStop(1, 'rgba(255,190,70,0)');
      ctx.fillStyle = gl;
      ctx.beginPath(); ctx.arc(x, y, r * 2.5, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#1b0d0466';
    ctx.beginPath(); ctx.arc(x + 3, y + 5, r + 2, 0, 7); ctx.fill();
    const hd = ctx.createRadialGradient(x - r * 0.35, y - r * 0.42, r * 0.1, x, y, r);
    hd.addColorStop(0, metal[0]); hd.addColorStop(0.5, metal[1]); hd.addColorStop(1, metal[2]);
    ctx.fillStyle = hd;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.strokeStyle = metal[3]; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.strokeStyle = '#ffffff66'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, r - 3, 3.5, 5.2); ctx.stroke();
    ctx.save(); ctx.translate(x, y); ctx.rotate(G.screwRot[si]);
    const L = r * 0.62, T = r * 0.17;
    for (let k = 0; k < 2; k++) {
      ctx.fillStyle = metal[3]; ctx.fillRect(-L, -T, L * 2, T * 2);
      ctx.fillStyle = '#ffffff40'; ctx.fillRect(-L, T - 1.2, L * 2, 1.2);
      ctx.rotate(Math.PI / 2);
    }
    ctx.restore();
  }

  function screwPos(si) {
    const w = G.world, a = G.anim, h = w.def.holes[w.st.s[si].h];
    let x = h.x, y = h.y, s = 1;
    if (a && a.si === si) {
      if (a.stage === 0) { x = a.from.x; y = a.from.y; s = 1 + 0.2 * (a.t / ANIM[0]); }
      else if (a.stage === 1) {
        const t = a.t / ANIM[1], e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const lift = Math.sin(t * Math.PI) * 60;
        x = a.from.x + (a.to.x - a.from.x) * e; y = a.from.y + (a.to.y - a.from.y) * e - lift;
        s = 1.2 + Math.sin(t * Math.PI) * 0.1;
      } else { x = a.to.x; y = a.to.y; s = 1.2 - 0.2 * (a.t / ANIM[2]); }
    }
    if (G.shake[si] > 0) x += Math.sin(G.time * 0.09) * 4;
    return { x, y, s };
  }

  function render() {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, WORLD.W, WORLD.H);
    if (bgCanvas) ctx.drawImage(bgCanvas, 0, 0, WORLD.W, WORLD.H);
    const w = G.world;
    if (!w) return;
    w.def.holes.forEach(h => drawSocket(ctx, h.x, h.y, 16));

    const layers = [...new Set(w.def.boards.map(b => b.layer))].sort((a, b) => a - b);
    const top = layers.length ? layers[layers.length - 1] : 1;
    const animSi = G.anim ? G.anim.si : -1;
    for (let lyr = 1; lyr <= top; lyr++) {
      w.def.boards.forEach(b => { if (b.layer === lyr) drawBoard(b.idx); });
      w.st.s.forEach((s, si) => {
        if (si === animSi) return;
        if (Math.min(top, w.screwTop(s)) === lyr) {
          const p = screwPos(si);
          drawScrew(si, p.x, p.y, G.sel === si ? 1.1 : 1, G.sel === si);
        }
      });
    }

    if (G.sel >= 0 && G.mode === 'play') {
      const pulse = 0.5 + Math.sin(G.time * 0.007) * 0.5;
      w.legalTargets(G.sel).forEach(hi => {
        const h = w.def.holes[hi];
        ctx.fillStyle = `rgba(255,214,120,${0.2 + pulse * 0.18})`;
        ctx.beginPath(); ctx.arc(h.x, h.y, 28, 0, 7); ctx.fill();
        ctx.strokeStyle = `rgba(255,236,170,${0.65 + pulse * 0.35})`;
        ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.arc(h.x, h.y, 22 + pulse * 7, 0, 7); ctx.stroke();
      });
    }

    if (G.hint && G.mode === 'play') {
      const from = w.def.holes[w.st.s[G.hint.si].h], to = w.def.holes[G.hint.to];
      const t = G.time * 0.006, pulse = 0.5 + Math.sin(t) * 0.5;
      const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2 - 70;
      ctx.save();
      ctx.strokeStyle = '#7dffb0'; ctx.lineWidth = 5; ctx.setLineDash([16, 12]); ctx.lineDashOffset = -G.time * 0.05; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(mx, my, to.x, to.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(from.x, from.y, 32 + pulse * 7, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(to.x, to.y, 26 + pulse * 7, 0, 7); ctx.stroke();
      ctx.restore();
    }

    if (animSi >= 0) { const p = screwPos(animSi); drawScrew(animSi, p.x, p.y, p.s, true); }

    G.particles.forEach(p => {
      const k = 1 - p.life / p.max;
      ctx.globalAlpha = Math.max(0, k * 0.75);
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1.4 - k * 0.4), 0, 7); ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  /* ---------- 메인 루프 ---------- */
  let lastT = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(100, now - lastT);
    lastT = now;
    if (G.mode === 'play' || G.mode === 'fail' || G.mode === 'clear') {
      G.time += dt;
      if (G.mode === 'play' && G.world) {
        advanceAnim(dt);
        acc += dt;
        let n = 0;
        while (acc >= TUNE.DT && n++ < 5) { G.world.step(); acc -= TUNE.DT; }
        if (acc > TUNE.DT * 5) acc = 0;
        checkOutcome();
        if (G.pendingEnd > 0) {
          G.pendingEnd -= dt;
          if (G.pendingEnd <= 0) {
            G.pendingEnd = 0;
            if (G.endKind === 'clear') finishLevel(); else failLevel(G.endKind);
          }
        }
        if (G.tipTimer > 0) { G.tipTimer -= dt; if (G.tipTimer <= 0) $('hud-tip').classList.remove('show'); }
        Object.keys(G.shake).forEach(k => { G.shake[k] -= dt; });
      }
      for (let i = G.particles.length - 1; i >= 0; i--) {
        const p = G.particles[i];
        p.life += dt; p.x += p.vx; p.y += p.vy; p.vy += 0.03; p.vx *= 0.98;
        if (p.life >= p.max) G.particles.splice(i, 1);
      }
    }
    render();
    requestAnimationFrame(frame);
  }

  /* ---------- 화면 전환 ---------- */
  function showPanel(html) {
    $('panel').innerHTML = html;
    $('overlay').classList.remove('hidden');
  }
  function hideOverlay() { $('overlay').classList.add('hidden'); }

  function setMode(mode) {
    G.mode = mode;
    $('hud').classList.toggle('hidden', mode === 'title' || mode === 'levels');
    $('screen-title').classList.toggle('hidden', mode !== 'title');
    $('screen-levels').classList.toggle('hidden', mode !== 'levels');
    hideOverlay();
    if (mode === 'title') {
      $('title-stat').textContent = `해금 ${Save.data.unlocked} / ${LEVELS.length}단계 · 별 ${Save.totalStars()} / ${LEVELS.length * 3}`;
      $('btn-play').textContent = Save.totalStars() > 0 ? '이어하기' : '시작하기';
    }
    if (mode === 'levels') renderLevels();
  }

  function renderLevels() {
    const tiers = [
      ['beginner', '초급', '1 ~ 10단계'],
      ['intermediate', '중급', '11 ~ 20단계'],
      ['advanced', '고급', '21 ~ 30단계']
    ];
    const lockSvg = '<svg class="lock-icon" viewBox="0 0 24 24"><path d="M17 9V7A5 5 0 0 0 7 7v2H5v13h14V9zm-8 0V7a3 3 0 0 1 6 0v2z"/></svg>';
    let html = '';
    tiers.forEach(([key, name, range]) => {
      html += `<div class="tier-title">${name}<span>${range}</span></div><div class="level-grid">`;
      LEVELS.filter(l => l.difficulty === key).forEach(l => {
        const id = l.levelId, locked = id > Save.data.unlocked;
        const s = Save.data.stars[id] | 0;
        const stars = [0, 1, 2].map(i => `<b class="${i < s ? 'on' : ''}"></b>`).join('');
        html += `<button class="level-cell ${locked ? 'locked' : ''} ${id === Save.data.unlocked ? 'current' : ''}" data-level="${id}" ${locked ? 'aria-disabled="true"' : ''}>${locked ? lockSvg : id + `<span class="level-stars">${stars}</span>`}</button>`;
      });
      html += '</div>';
    });
    $('levels-scroll').innerHTML = html;
    $('total-stars').textContent = `${Save.totalStars()}/${LEVELS.length * 3}`;
  }

  function pause() {
    if (G.mode !== 'play') return;
    G.mode = 'pause';
    showPanel(`
      <h3>일시정지</h3>
      <p>${G.level.levelId}단계 · 이동 ${G.moves} / ${G.level.moveLimit}</p>
      <button class="btn primary" data-act="resume">계속하기</button>
      <div class="row"><button class="btn" data-act="restart">재시작</button><button class="btn" data-act="levels">단계 선택</button></div>
    `);
  }

  function syncSoundUi() {
    const on = Save.data.sound;
    Audio.setEnabled(on);
    $('sound-label').textContent = on ? '소리 켬' : '소리 끔';
    $('sound-path').setAttribute('d', on
      ? 'M3 9v6h4l5 5V4L7 9zm11-1.5v9a5 5 0 0 0 0-9z'
      : 'M3 9v6h4l5 5V4L7 9zm16.6 3 2.4-2.4L20.6 8.2 18.2 10.6 15.8 8.2l-1.4 1.4 2.4 2.4-2.4 2.4 1.4 1.4 2.4-2.4 2.4 2.4 1.4-1.4z');
  }

  /* 메뉴 버튼 */
  $('btn-play').addEventListener('click', () => { Audio.unlock(); Audio.play('tap'); startLevel(Math.min(Save.data.last, Save.data.unlocked) - 1); });
  $('btn-levels').addEventListener('click', () => { Audio.unlock(); Audio.play('tap'); setMode('levels'); });
  $('btn-levels-back').addEventListener('click', () => { Audio.play('tap'); setMode('title'); });
  $('levels-scroll').addEventListener('click', ev => {
    const cell = ev.target.closest('[data-level]');
    if (!cell) return;
    const id = +cell.dataset.level;
    if (id > Save.data.unlocked) { Audio.play('deny'); toast('이전 단계를 클리어하면 열립니다.'); return; }
    Audio.play('tap');
    startLevel(id - 1);
  });
  $('btn-pause').addEventListener('click', () => { Audio.play('tap'); pause(); });
  $('btn-hint').addEventListener('click', requestHint);
  $('btn-undo').addEventListener('click', undo);
  $('btn-restart').addEventListener('click', () => { if (G.mode === 'play' && !G.anim) restartLevel(); });
  $('btn-sound').addEventListener('click', () => {
    Save.data.sound = !Save.data.sound;
    Save.write();
    syncSoundUi();
    Audio.play('tap');
  });
  $('panel').addEventListener('click', ev => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    Audio.play('tap');
    if (act === 'resume') { G.mode = 'play'; hideOverlay(); }
    if (act === 'restart') restartLevel();
    if (act === 'undo') undo();
    if (act === 'levels') setMode('levels');
    if (act === 'next') startLevel(G.idx + 1);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

  /* 자동 시험용 접근점. 게임 진행에는 쓰이지 않는다. */
  window.WSM = { G, Save, starsFor, startLevel, undo, restartLevel, requestHint, SAVE_KEY };

  /* ---------- 시작 ---------- */
  Save.load();
  resize();
  buildBackground();
  syncSoundUi();
  setMode('title');
  requestAnimationFrame(frame);
})();
