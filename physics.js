/*
 * physics.js — 우드 스크류 마스터 퍼즐 코어
 *
 * 브라우저와 Node(자동 검증)에서 같은 코드가 돈다.
 * - PuzzleWorld : Matter.js 월드 + 나사/구멍 규칙
 * - searchGen / solveSync : 현재 상태에서 정답을 찾는 물리 기반 탐색기
 *
 * 설계 원칙
 *  1) 플레이어의 이동은 "모든 판자가 멈춘 상태"에서만 확정된다.
 *  2) 이동을 확정할 때마다 정규화된 스냅샷으로 엔진을 새로 만든다.
 *     덕분에 같은 스냅샷 + 같은 이동 = 항상 같은 결과이며,
 *     검증기·힌트 탐색기·실제 플레이가 동일한 궤적을 따른다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/matter.min.js'));
  } else {
    root.WSMPhysics = factory(root.Matter);
  }
})(typeof self !== 'undefined' ? self : this, function (Matter) {
  'use strict';

  const { Engine, Body, Bodies, Composite, Constraint, Events, Vertices } = Matter;

  const WORLD = { W: 720, H: 1280 };
  const TUNE = {
    DT: 1000 / 60,
    ALIGN_TOL: 13,        // 판자 구멍과 벽 구멍이 "맞물렸다"고 보는 거리
    SHAFT_R: 9,           // 나사 몸통 충돌 반경
    HEAD_R: 24,           // 나사 머리 반경(표시·판정)
    PIERCE_MARGIN: 9,     // 몸통이 판자에 걸리는지 판정하는 여유
    HEAD_MARGIN: 4,       // 머리가 위층 판자에 덮였는지 판정하는 여유
    AIR_PIVOT: 0.02,      // 나사 하나로 매달린 판자의 감쇠
    ASSIST_ZONE: 0.42,    // 수직에 가까워지면 진자의 꼬리 진동을 줄이는 구간(rad)
    ASSIST_K: 0.1,
    ASSIST_BLEND: 0.3,
    AIR_FREE: 0.004,      // 자유 낙하 판자의 감쇠
    MAX_SPEED: 30,        // 스텝당 최대 이동(터널링 방지)
    MAX_ANG: 0.35,
    STILL_SPEED: 0.07,
    STILL_ANG: 0.0012,
    STILL_STEPS: 10,
    MAX_SETTLE: 420,      // 7초 안에 멈추지 않으면 강제로 안정 처리
    FALL_ZONE_TOP: WORLD.H + 10
  };

  const BIT_WALL = 1 << 29;
  const BIT_SHAFT = 1 << 28;
  const BIT_ZONE = 1 << 27;

  /* ---------- 기하 ---------- */
  function rotate(p, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
  }
  function toLocal(pose, p) {
    return rotate({ x: p.x - pose.x, y: p.y - pose.y }, -pose.a);
  }
  function toWorld(pose, p) {
    const r = rotate(p, pose.a);
    return { x: r.x + pose.x, y: r.y + pose.y };
  }
  function centroid(v) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < v.length; i++) {
      const p = v[i], q = v[(i + 1) % v.length], c = p.x * q.y - q.x * p.y;
      a += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
    }
    return { x: cx / (3 * a), y: cy / (3 * a) };
  }
  function round(n, f) { return Math.round(n * f) / f; }
  function normAngle(a) {
    const t = Math.PI * 2;
    return ((a % t) + t) % t;
  }

  /** 레벨 JSON을 런타임 구조로 변환한다(무게중심 원점, 외향 법선 계산). */
  function prepareLevel(level) {
    const holes = level.holes.map((h, i) => ({ id: h.id, idx: i, x: h.x, y: h.y }));
    const holeIndex = {};
    holes.forEach(h => { holeIndex[h.id] = h.idx; });

    const boards = level.boards.map((d, i) => {
      let verts = d.shape === 'rect'
        ? [{ x: -d.w / 2, y: -d.h / 2 }, { x: d.w / 2, y: -d.h / 2 }, { x: d.w / 2, y: d.h / 2 }, { x: -d.w / 2, y: d.h / 2 }]
        : d.points.map(p => ({ x: p[0], y: p[1] }));
      const c = d.shape === 'rect' ? { x: 0, y: 0 } : centroid(verts);
      verts = verts.map(v => ({ x: v.x - c.x, y: v.y - c.y }));
      const bh = d.holes.map(h => ({ x: h.x - c.x, y: h.y - c.y }));
      const shift = rotate(c, d.angle || 0);
      const edges = verts.map((a, k) => {
        const b = verts[(k + 1) % verts.length];
        const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
        let nx = ey / len, ny = -ex / len;
        if (nx * (-a.x) + ny * (-a.y) > 0) { nx = -nx; ny = -ny; }
        return { x: a.x, y: a.y, nx, ny };
      });
      let radius = 0;
      verts.forEach(v => { radius = Math.max(radius, Math.hypot(v.x, v.y)); });
      return {
        id: d.id, idx: i, bit: 1 << i, layer: d.layer, mass: d.mass, wood: d.wood || 'oak',
        shape: d.shape, w: d.w, h: d.h, verts, holes: bh, edges, radius,
        x0: d.x + shift.x, y0: d.y + shift.y, a0: d.angle || 0
      };
    });
    return { holes, holeIndex, boards };
  }

  function coversPoint(board, pose, p, margin) {
    const q = toLocal(pose, p);
    if (q.x * q.x + q.y * q.y > (board.radius + margin) * (board.radius + margin)) return false;
    for (const e of board.edges) {
      if ((q.x - e.x) * e.nx + (q.y - e.y) * e.ny > margin) return false;
    }
    return true;
  }
  function alignedHole(board, pose, p) {
    const q = toLocal(pose, p);
    let best = -1, bestD = TUNE.ALIGN_TOL;
    board.holes.forEach((h, i) => {
      const d = Math.hypot(h.x - q.x, h.y - q.y);
      if (d <= bestD) { best = i; bestD = d; }
    });
    return best;
  }

  /* ---------- 월드 ---------- */
  class PuzzleWorld {
    constructor(level, opts) {
      this.level = level;
      this.def = prepareLevel(level);
      this.silent = !!(opts && opts.silent);
      this.jitter = (opts && opts.jitter) || 0;
      this.listeners = {};
      this.engine = null;
      this.bodies = [];
      this.reset();
    }

    on(name, fn) { this.listeners[name] = fn; }
    emit(name, data) { if (!this.silent && this.listeners[name]) this.listeners[name](data); }

    /** 레벨 초기 상태로 되돌린다. */
    reset() {
      const boards = this.def.boards.map((b, i) => {
        const j = this.jitter;
        const n = () => (j ? (Math.sin((i + 1) * 12.9898 * j * 1000) * 2 - 1) * j : 0);
        return { x: b.x0 + n(), y: b.y0 - n(), a: b.a0, g: 0 };
      });
      const screws = this.level.screws.map(s => {
        const h = this.def.holes[this.def.holeIndex[s.holeId]];
        const p = [];
        this.def.boards.forEach((b, i) => {
          const k = alignedHole(b, boards[i], h);
          if (k >= 0) p.push([i, k]);
        });
        return { h: h.idx, p };
      });
      this.st = { b: boards, s: screws };
      this.settled = false;
      this.stepCount = 0;
      this.still = 0;
      this._build();
    }

    /** 현재 상태를 JSON 호환 스냅샷으로 만든다. */
    snapshot() {
      this._syncPoses();
      return {
        b: this.st.b.map(p => ({ x: round(p.x, 100), y: round(p.y, 100), a: round(p.a, 10000), g: p.g })),
        s: this.st.s.map(s => ({ h: s.h, p: s.p.map(x => x.slice()) }))
      };
    }

    /** 스냅샷으로 복원한다. 복원 직후의 상태는 안정 상태다. */
    restore(snap) {
      this.st = {
        b: snap.b.map(p => ({ x: p.x, y: p.y, a: p.a, g: p.g })),
        s: snap.s.map(s => ({ h: s.h, p: s.p.map(x => x.slice()) }))
      };
      this.settled = true;
      this.still = 0;
      this.stepCount = 0;
      this._build();
    }

    _syncPoses() {
      this.bodies.forEach((body, i) => {
        if (body) {
          const p = this.st.b[i];
          p.x = body.position.x; p.y = body.position.y; p.a = body.angle;
        }
      });
    }

    pinCounts() {
      const c = this.def.boards.map(() => 0);
      this.st.s.forEach(s => s.p.forEach(p => { c[p[0]]++; }));
      return c;
    }

    _build() {
      const engine = Engine.create({
        gravity: { x: 0, y: 1, scale: 0.0016 },
        positionIterations: 10,
        velocityIterations: 8,
        constraintIterations: 4
      });
      this.engine = engine;
      const items = [];
      const wallOpts = {
        isStatic: true, friction: 0.05, restitution: 0.05,
        collisionFilter: { category: BIT_WALL, mask: 0x07ffffff }
      };
      items.push(Bodies.rectangle(-50, 800, 100, 3400, wallOpts));
      items.push(Bodies.rectangle(WORLD.W + 50, 800, 100, 3400, wallOpts));
      this.zone = Bodies.rectangle(WORLD.W / 2, TUNE.FALL_ZONE_TOP + 700, WORLD.W + 400, 1400, {
        isStatic: true, isSensor: true, label: 'fallZone',
        collisionFilter: { category: BIT_ZONE, mask: 0x07ffffff }
      });
      items.push(this.zone);

      const pins = this.pinCounts();
      this.pinOf = pins;
      const layerMask = {};
      this.def.boards.forEach((b, i) => {
        if (!this.st.b[i].g) layerMask[b.layer] = (layerMask[b.layer] || 0) | b.bit;
      });

      this.bodies = this.def.boards.map((b, i) => {
        const pose = this.st.b[i];
        if (pose.g) return null;
        const body = Body.create({
          position: { x: pose.x, y: pose.y },
          vertices: Vertices.clockwiseSort(b.verts.map(v => ({ x: v.x, y: v.y }))),
          friction: 0.22, frictionStatic: 0.3, restitution: 0.08, slop: 0.03,
          frictionAir: pins[i] === 1 ? TUNE.AIR_PIVOT : TUNE.AIR_FREE,
          collisionFilter: {
            category: b.bit,
            mask: layerMask[b.layer] | BIT_WALL | BIT_ZONE | BIT_SHAFT
          }
        });
        Body.setMass(body, b.mass);
        Body.setAngle(body, pose.a);
        body.plugin.boardIdx = i;
        items.push(body);
        return body;
      });

      this.fallFlag = this.def.boards.map(() => false);
      this.shafts = this.st.s.map(s => {
        const h = this.def.holes[s.h];
        const pinned = {};
        let top = 1;
        s.p.forEach(p => { pinned[p[0]] = 1; top = Math.max(top, this.def.boards[p[0]].layer); });
        let mask = 0;
        this.def.boards.forEach((b, i) => {
          if (!pinned[i] && !this.st.b[i].g && b.layer <= top) mask |= b.bit;
        });
        const shaft = Bodies.circle(h.x, h.y, TUNE.SHAFT_R, {
          isStatic: true, friction: 0.15, restitution: 0.02,
          collisionFilter: { category: BIT_SHAFT, mask: mask }
        });
        items.push(shaft);
        return shaft;
      });

      // 나사 1개: 회전축 제약 / 나사 2개 이상: 완전 고정
      const fixed = {};
      this.st.s.forEach(s => {
        const h = this.def.holes[s.h];
        s.p.forEach(p => {
          const body = this.bodies[p[0]];
          if (!body) return;
          if (pins[p[0]] >= 2) { fixed[p[0]] = true; return; }
          const off = rotate(this.def.boards[p[0]].holes[p[1]], body.angle);
          items.push(Constraint.create({
            pointA: { x: h.x, y: h.y }, bodyB: body, pointB: off,
            length: 0, stiffness: 0.95, damping: 0
          }));
        });
      });
      Object.keys(fixed).forEach(i => Body.setStatic(this.bodies[i], true));

      Composite.add(engine.world, items);
      Events.on(engine, 'collisionStart', ev => this._onCollide(ev));
    }

    _onCollide(ev) {
      for (const pair of ev.pairs) {
        const a = pair.bodyA, b = pair.bodyB;
        if (a === this.zone || b === this.zone) {
          const other = a === this.zone ? b : a;
          if (other.plugin && other.plugin.boardIdx !== undefined) this.fallFlag[other.plugin.boardIdx] = true;
          continue;
        }
        if (this.silent) continue;
        const dvx = a.velocity.x - b.velocity.x, dvy = a.velocity.y - b.velocity.y;
        const speed = Math.hypot(dvx, dvy);
        if (speed > 2.4 && pair.collision.supports && pair.collision.supports[0]) {
          const p = pair.collision.supports[0];
          this.emit('impact', { x: p.x, y: p.y, speed });
        }
      }
    }

    step() {
      if (this.settled) return;
      Engine.update(this.engine, TUNE.DT);
      this.stepCount++;
      this._assistPendulums();
      let moving = false;
      this.bodies.forEach((body, i) => {
        if (!body || body.isStatic) return;
        if (body.speed > TUNE.MAX_SPEED) {
          const f = TUNE.MAX_SPEED / body.speed;
          Body.setVelocity(body, { x: body.velocity.x * f, y: body.velocity.y * f });
        }
        if (body.angularSpeed > TUNE.MAX_ANG) {
          Body.setAngularVelocity(body, Math.sign(body.angularVelocity) * TUNE.MAX_ANG);
        }
        // 낙하 판정 영역에 들어왔고 판자 전체가 화면 밖으로 나가면 제거
        if ((this.fallFlag[i] && body.bounds.min.y >= TUNE.FALL_ZONE_TOP) || body.position.y > 3000) {
          this.st.b[i].g = 1;
          this.emit('fall', { board: this.def.boards[i], x: body.position.x });
          Composite.remove(this.engine.world, body);
          this.bodies[i] = null;
          return;
        }
        if (body.speed > TUNE.STILL_SPEED || body.angularSpeed > TUNE.STILL_ANG) moving = true;
      });
      this.still = moving ? 0 : this.still + 1;
      if (this.still >= TUNE.STILL_STEPS || this.stepCount >= TUNE.MAX_SETTLE) {
        const snap = this.snapshot();
        this.restore(snap);
        this.emit('settled', {});
      }
    }

    /** 한 나사에 매달린 판자가 수직 근처에서 오래 흔들리지 않게 마무리한다. 접촉 중인 판자는 건드리지 않는다. */
    _assistPendulums() {
      let touching = null;
      this.st.s.forEach(s => {
        const hole = this.def.holes[s.h];
        s.p.forEach(pin => {
          const body = this.bodies[pin[0]];
          if (!body || body.isStatic || this.pinOf[pin[0]] !== 1) return;
          const dx = body.position.x - hole.x, dy = body.position.y - hole.y;
          const off = Math.atan2(dx, dy);
          if (Math.abs(off) > TUNE.ASSIST_ZONE || Math.hypot(dx, dy) < 12) return;
          if (!touching) {
            touching = new Set();
            this.engine.pairs.list.forEach(pair => {
              if (!pair.isActive || pair.isSensor) return;
              touching.add(pair.bodyA.id); touching.add(pair.bodyB.id);
            });
          }
          if (touching.has(body.id)) return;
          const w = body.angularVelocity;
          Body.setAngularVelocity(body, w + (TUNE.ASSIST_K * off - w) * TUNE.ASSIST_BLEND);
        });
      });
    }

    settle() { while (!this.settled) this.step(); }

    pose(i) {
      const body = this.bodies[i];
      if (body) return { x: body.position.x, y: body.position.y, a: body.angle };
      return this.st.b[i];
    }

    screwTop(s) {
      let top = 1;
      s.p.forEach(p => { top = Math.max(top, this.def.boards[p[0]].layer); });
      return top;
    }

    /** 나사 머리가 위층 판자에 덮이지 않았는지 */
    screwAccessible(si) {
      const s = this.st.s[si];
      const top = this.screwTop(s);
      const h = this.def.holes[s.h];
      for (const b of this.def.boards) {
        if (this.st.b[b.idx].g || b.layer <= top) continue;
        if (coversPoint(b, this.pose(b.idx), h, TUNE.HEAD_MARGIN)) return false;
      }
      return true;
    }

    /** 구멍에 나사를 꽂을 수 있는지(비어 있고, 몸통이 관통할 판자가 없어야 한다) */
    holeAvailable(hi) {
      if (this.st.s.some(s => s.h === hi)) return false;
      const h = this.def.holes[hi];
      for (const b of this.def.boards) {
        if (this.st.b[b.idx].g) continue;
        const pose = this.pose(b.idx);
        if (coversPoint(b, pose, h, TUNE.PIERCE_MARGIN) && alignedHole(b, pose, h) < 0) return false;
      }
      return true;
    }

    legalTargets(si) {
      if (!this.settled || !this.screwAccessible(si)) return [];
      const out = [];
      this.def.holes.forEach(h => { if (this.holeAvailable(h.idx)) out.push(h.idx); });
      return out;
    }

    legalMoves() {
      const out = [];
      this.st.s.forEach((s, si) => {
        this.legalTargets(si).forEach(hi => out.push({ s: si, to: hi }));
      });
      return out;
    }

    isLegal(si, hi) { return this.legalTargets(si).indexOf(hi) >= 0; }

    /** 나사 이동을 확정한다. 이전 고정 해제와 새 고정이 한 스텝에 반영된다. */
    commit(si, hi) {
      if (!this.isLegal(si, hi)) return false;
      const snap = this.snapshot();
      this.st = snap;
      const h = this.def.holes[hi];
      const p = [];
      this.def.boards.forEach((b, i) => {
        if (snap.b[i].g) return;
        const k = alignedHole(b, snap.b[i], h);
        if (k >= 0) p.push([i, k]);
      });
      const released = snap.s[si].p.map(x => x[0]);
      snap.s[si] = { h: hi, p };
      this.settled = false;
      this.still = 0;
      this.stepCount = 0;
      this._build();
      this.emit('commit', { screw: si, hole: hi, released, pinned: p.map(x => x[0]) });
      return true;
    }

    boardsLeft() { return this.st.b.reduce((n, b) => n + (b.g ? 0 : 1), 0); }
    won() { return this.boardsLeft() === 0; }
    screwAtHole(hi) { return this.st.s.findIndex(s => s.h === hi); }
  }

  /* ---------- 탐색기 ---------- */
  function stateKey(snap) {
    const occ = snap.s.map(s => s.h + ':' + s.p.map(p => p[0]).sort((a, b) => a - b).join('.')).sort().join('|');
    const pins = {};
    snap.s.forEach(s => s.p.forEach(p => { pins[p[0]] = (pins[p[0]] || 0) + 1; }));
    let pose = '';
    snap.b.forEach((b, i) => {
      if (b.g) pose += 'x';
      else if ((pins[i] || 0) >= 2) pose += 'f';
      else pose += Math.round(b.x / 8) + ',' + Math.round(b.y / 8) + ',' + Math.round(normAngle(b.a) / 0.14) + ';';
    });
    return occ + '#' + pose;
  }

  function heuristic(snap) {
    let pinning = 0, left = 0;
    snap.s.forEach(s => { if (s.p.length) pinning++; });
    snap.b.forEach(b => { if (!b.g) left++; });
    return pinning > 0 ? pinning : (left > 0 ? 1 : 0);
  }

  /**
   * 물리 기반 A* 탐색. 일정 간격으로 yield 하므로 UI 스레드를 나눠 쓸 수 있다.
   * opts: maxEdges, maxDepth, weight(1=최단 보장), yieldEvery
   * 반환: { found, path:[{s,to,fromHole}], edges, exhausted }
   */
  function* searchGen(level, startSnap, opts) {
    const o = Object.assign({ maxEdges: 2000, maxDepth: 40, weight: 1.6, yieldEvery: 6 }, opts);
    const world = new PuzzleWorld(level, { silent: true });
    const start = { snap: startSnap, g: 0, h: heuristic(startSnap), parent: null, move: null };
    if (startSnap.b.every(b => b.g)) return { found: true, path: [], edges: 0, exhausted: false };
    const open = [start];
    const best = new Map([[stateKey(startSnap), 0]]);
    let edges = 0;
    const score = n => n.g + o.weight * n.h;

    const pathOf = n => {
      const p = [];
      for (let c = n; c.parent; c = c.parent) p.unshift(c.move);
      return p;
    };

    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) {
        const a = score(open[i]), b = score(open[bi]);
        if (a < b - 1e-9 || (Math.abs(a - b) < 1e-9 && open[i].h < open[bi].h)) bi = i;
      }
      const node = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (node.snap.b.every(b => b.g)) return { found: true, path: pathOf(node), edges, exhausted: false };
      if (node.g >= o.maxDepth) continue;

      world.restore(node.snap);
      const moves = world.legalMoves();
      for (const m of moves) {
        if (edges >= o.maxEdges) return { found: false, path: null, edges, exhausted: false };
        world.restore(node.snap);
        const fromHole = node.snap.s[m.s].h;
        world.commit(m.s, m.to);
        world.settle();
        edges++;
        const snap = world.snapshot();
        const key = stateKey(snap);
        const g = node.g + 1;
        const h = heuristic(snap);
        // 고정 중인 나사는 각각 최소 한 번은 옮겨야 하므로, 남은 이동으로 불가능한 가지는 버린다.
        if (g + h <= o.maxDepth && (!best.has(key) || best.get(key) > g)) {
          best.set(key, g);
          open.push({ snap, g, h, parent: node, move: { s: m.s, to: m.to, from: fromHole } });
        }
        if (edges % o.yieldEvery === 0) yield edges;
      }
    }
    return { found: false, path: null, edges, exhausted: true };
  }

  function solveSync(level, snap, opts) {
    const gen = searchGen(level, snap, opts);
    let r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
  }

  /** moves를 snap에서 재생해 클리어되는지 확인한다. moves: [{from,to}] (구멍 인덱스) */
  function replayWins(level, snap, moves) {
    const world = new PuzzleWorld(level, { silent: true });
    world.restore(snap);
    for (const m of moves) {
      const si = world.screwAtHole(m.from);
      if (si < 0 || !world.isLegal(si, m.to)) return false;
      world.commit(si, m.to);
      world.settle();
    }
    return world.won();
  }

  return {
    WORLD, TUNE, PuzzleWorld, prepareLevel, coversPoint, alignedHole,
    toWorld, toLocal, rotate, searchGen, solveSync, replayWins, stateKey
  };
});
