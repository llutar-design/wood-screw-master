/*
 * 레벨 제작 도구 (게임 실행에는 필요 없음)
 *   node tools/build_levels.js pool    : 후보 퍼즐을 병렬 생성해 tools/pool.json 저장
 *   node tools/build_levels.js write   : 수제 1~10단계 + 후보 중 선별해 levels.js 작성
 *
 * 모든 정답 수순은 실제 물리 시뮬레이션(physics.js)을 돌린 A* 탐색으로 얻는다.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const P = require('../physics.js');

const COLS = [120, 240, 360, 480, 600];
const ROWS = [270, 390, 510, 630, 750, 870, 990];
const MARGIN = 34;
const WOODS = ['oak', 'walnut', 'maple', 'cherry', 'ash'];
const DENSITY = { oak: 1.0, walnut: 1.15, maple: 0.95, cherry: 1.05, ash: 0.9 };
const pt = ([c, r]) => ({ x: COLS[c], y: ROWS[r] });
const key = p => p.x + '_' + p.y;

/* ---------- 판자 빌더 ---------- */
function massOf(area, wood) { return Math.round(area * 0.00011 * DENSITY[wood] * 100) / 100; }

function plank(a, b, layer, wood, extra) {
  const pa = pt(a), pb = pt(b);
  const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  const angle = Math.atan2(pb.y - pa.y, pb.x - pa.x);
  const x = (pa.x + pb.x) / 2, y = (pa.y + pb.y) / 2;
  const w = len + MARGIN * 2, h = MARGIN * 2;
  const world = [pa, pb].concat((extra || []).map(pt));
  const holes = world.map(p => {
    const l = P.rotate({ x: p.x - x, y: p.y - y }, -angle);
    return { x: round2(l.x), y: round2(l.y) };
  });
  return { shape: 'rect', w: round2(w), h, x, y, angle: round4(angle), mass: massOf(w * h, wood), layer, wood, holes, _pts: world };
}

function hull(points) {
  const pts = points.slice().sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of pts.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** 격자점들을 감싸는 둥근 볼록 다각형 판자 */
function plate(list, layer, wood) {
  const world = list.map(pt);
  const h = hull(world);
  const out = [];
  for (let i = 0; i < h.length; i++) {
    const p = h[i], prev = h[(i - 1 + h.length) % h.length], next = h[(i + 1) % h.length];
    const a0 = Math.atan2(p.y - prev.y, p.x - prev.x) - Math.PI / 2;
    let a1 = Math.atan2(next.y - p.y, next.x - p.x) - Math.PI / 2;
    while (a1 < a0) a1 += Math.PI * 2;
    const seg = 3;
    for (let k = 0; k <= seg; k++) {
      const t = a0 + (a1 - a0) * k / seg;
      out.push({ x: p.x + Math.cos(t) * MARGIN, y: p.y + Math.sin(t) * MARGIN });
    }
  }
  let A = 0, cx = 0, cy = 0;
  out.forEach((p, i) => {
    const q = out[(i + 1) % out.length], c = p.x * q.y - q.x * p.y;
    A += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  });
  cx /= 3 * A; cy /= 3 * A;
  const area = Math.abs(A) / 2;
  return {
    shape: 'poly', points: out.map(p => [round2(p.x - cx), round2(p.y - cy)]),
    x: round2(cx), y: round2(cy), angle: 0, mass: massOf(area, wood), layer, wood,
    holes: world.map(p => ({ x: round2(p.x - cx), y: round2(p.y - cy) })), _pts: world
  };
}
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function worldPoly(b) {
  if (b.shape === 'rect') {
    return [[-b.w / 2, -b.h / 2], [b.w / 2, -b.h / 2], [b.w / 2, b.h / 2], [-b.w / 2, b.h / 2]].map(([x, y]) => {
      const r = P.rotate({ x, y }, b.angle);
      return { x: r.x + b.x, y: r.y + b.y };
    });
  }
  return b.points.map(([x, y]) => ({ x: x + b.x, y: y + b.y }));
}
function satOverlap(A, B, gap) {
  const axes = poly => poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length], l = Math.hypot(q.x - p.x, q.y - p.y);
    return { x: (q.y - p.y) / l, y: -(q.x - p.x) / l };
  });
  for (const ax of axes(A).concat(axes(B))) {
    const proj = P2 => { let mn = Infinity, mx = -Infinity; P2.forEach(p => { const d = p.x * ax.x + p.y * ax.y; mn = Math.min(mn, d); mx = Math.max(mx, d); }); return [mn, mx]; };
    const a = proj(A), b = proj(B);
    if (a[1] + gap < b[0] || b[1] + gap < a[0]) return false;
  }
  return true;
}

/* ---------- 레벨 조립 ---------- */
function assemble(boards, screwPts, parkPts) {
  const seen = new Map();
  const holes = [];
  const add = p => {
    const k = key(p);
    if (!seen.has(k)) { const id = 'h' + (holes.length + 1); seen.set(k, id); holes.push({ id, x: p.x, y: p.y }); }
    return seen.get(k);
  };
  screwPts.forEach(add); parkPts.forEach(add);
  const screws = screwPts.map((p, i) => ({ id: 's' + (i + 1), holeId: seen.get(key(p)), metal: i % 3 === 2 ? 'silver' : 'brass' }));
  const outBoards = boards.map((b, i) => {
    const c = Object.assign({}, b); delete c._pts; c.id = 'b' + (i + 1); return c;
  });
  return { boards: outBoards, holes, screws };
}

/** 시작 배치 규칙 검사: 고정 수, 안정성, 관통 금지, 같은 층 겹침 금지 */
function validateStart(lv) {
  const polys = lv.boards.map(worldPoly);
  for (let i = 0; i < lv.boards.length; i++) {
    for (let j = i + 1; j < lv.boards.length; j++) {
      if (lv.boards[i].layer === lv.boards[j].layer && satOverlap(polys[i], polys[j], 8)) return 'same-layer overlap';
    }
    for (const p of polys[i]) if (p.x < 6 || p.x > 714 || p.y < 190 || p.y > 1070) return 'out of bounds';
  }
  const w = new P.PuzzleWorld(lv, { silent: true });
  const pins = w.pinCounts();
  if (pins.some(c => c === 0)) return 'unpinned board';
  for (const s of w.st.s) {
    const h = w.def.holes[s.h];
    const pinned = new Set(s.p.map(p => p[0]));
    const top = w.screwTop(s);
    for (const b of w.def.boards) {
      if (pinned.has(b.idx)) continue;
      if (b.layer <= top && P.coversPoint(b, w.st.b[b.idx], h, P.TUNE.PIERCE_MARGIN)) return 'pierced board';
    }
  }
  const before = w.snapshot();
  w.settle();
  const after = w.snapshot();
  for (let i = 0; i < before.b.length; i++) {
    if (Math.hypot(before.b[i].x - after.b[i].x, before.b[i].y - after.b[i].y) > 1.5 || Math.abs(before.b[i].a - after.b[i].a) > 0.02) return 'unstable start';
  }
  return null;
}

function analyze(lv, path) {
  const w = new P.PuzzleWorld(lv, { silent: true });
  w.settle();
  const start = w.snapshot();
  let locked = 0;
  w.st.s.forEach((s, i) => { if (!w.screwAccessible(i)) locked++; });
  const firstMoves = w.legalMoves().length;
  let rotDep = 0, swingMax = 0;
  const startPose = start.b;
  for (const m of path) {
    w.commit(m.s, m.to);
    const h = w.def.holes[m.to];
    w.def.boards.forEach(b => {
      if (w.st.b[b.idx].g) return;
      if (P.coversPoint(b, startPose[b.idx], h, P.TUNE.PIERCE_MARGIN) && P.alignedHole(b, startPose[b.idx], h) < 0) rotDep++;
    });
    w.settle();
    const snap = w.snapshot();
    snap.b.forEach((b, i) => { if (!b.g) swingMax = Math.max(swingMax, Math.abs(b.a - startPose[i].a)); });
  }
  const polys = lv.boards.map(worldPoly);
  let cross = 0;
  for (let i = 0; i < lv.boards.length; i++) {
    for (let j = i + 1; j < lv.boards.length; j++) {
      if (lv.boards[i].layer !== lv.boards[j].layer && satOverlap(polys[i], polys[j], -6)) {
        if (Math.abs(Math.sin(lv.boards[i].angle - lv.boards[j].angle)) > 0.5 || lv.boards[i].shape === 'poly' || lv.boards[j].shape === 'poly') cross++;
      }
    }
  }
  return { locked, firstMoves, rotDep, swingMax: Math.round(swingMax * 100) / 100, cross };
}

/* ---------- 수제 초급 1~10 ---------- */
const HAND = [
  { name: '첫 나사', tip: '나사를 누른 뒤 빛나는 빈 구멍을 누르면 옮겨집니다.',
    boards: () => [plank([2, 1], [2, 4], 1, 'oak')], screws: [[2, 1]], park: [[0, 1], [4, 1]] },
  { name: '두 개의 축', tip: '나사가 하나 남으면 판자는 그 나사를 축으로 돕니다.',
    boards: () => [plank([1, 2], [3, 2], 1, 'walnut')], screws: [[1, 2], [3, 2]], park: [[0, 5], [4, 5]] },
  { name: '한 나사 두 판', tip: '겹친 구멍에 박힌 나사는 두 판을 함께 잡습니다.',
    boards: () => [plank([2, 1], [2, 5], 1, 'oak'), plate([[2, 1], [1, 3], [3, 3]], 2, 'walnut')], screws: [[2, 1]], park: [[0, 0], [4, 6]] },
  { name: '빈자리 재활용', tip: '판자가 사라진 자리의 구멍은 다시 쓸 수 있습니다.',
    boards: () => [plank([1, 1], [1, 4], 1, 'cherry'), plank([3, 1], [3, 4], 1, 'ash')], screws: [[1, 1], [3, 1]], park: [[2, 1]] },
  { name: '돌려서 비우기', tip: '판자를 돌리면 가려진 구멍이 드러납니다.',
    boards: () => [plank([0, 3], [4, 3], 1, 'cherry')], screws: [[0, 3], [4, 3]], park: [[2, 3], [0, 1]] },
  { name: '삼각 받침', tip: '판자에 박힌 나사를 모두 빼야 떨어집니다.',
    boards: () => [plate([[1, 2], [3, 2], [2, 4]], 1, 'maple')], screws: [[1, 2], [3, 2], [2, 4]], park: [[0, 0], [4, 0], [0, 6]] },
  { name: '가려진 구멍', tip: '판자에 가려진 구멍은 판자를 치우면 열립니다.',
    boards: () => [plank([1, 1], [3, 1], 1, 'maple'), plank([2, 2], [2, 5], 2, 'cherry')], screws: [[1, 1], [3, 1], [2, 2]], park: [[2, 4], [4, 4]] },
  { name: '덮개 먼저', tip: '위 판자에 덮인 나사는 집을 수 없습니다.',
    boards: () => [plank([1, 3], [3, 3], 1, 'maple'), plank([1, 1], [1, 5], 2, 'walnut')], screws: [[1, 1], [1, 3], [3, 3]], park: [[4, 1], [3, 6], [4, 5]] },
  { name: '같은 층의 충돌', tip: '같은 층의 판자끼리는 서로 부딪힙니다.',
    boards: () => [plank([1, 1], [3, 1], 1, 'ash'), plank([1, 3], [1, 5], 1, 'oak')], screws: [[1, 1], [3, 1], [1, 3]], park: [[4, 0], [0, 6], [4, 6]] },
  { name: '겹침의 순서', tip: '어느 판자부터 비울지 먼저 생각해 보세요.',
    boards: () => [plate([[1, 0], [3, 0], [3, 2], [1, 2], [2, 0]], 2, 'walnut'), plank([1, 1], [1, 4], 1, 'oak'), plank([3, 1], [3, 4], 1, 'ash')], screws: [[2, 0], [1, 1], [3, 1]], park: [[2, 5]] }
];
function buildHand(def, idx) {
  const boards = def.boards();
  const lv = assemble(boards, def.screws.map(pt), def.park.map(pt));
  // 나사가 없는 판자 끝 구멍에도 벽 구멍이 필요한 단계는 screws에 포함해 지정한다.
  return Object.assign(lv, { _name: def.name, _tip: def.tip, _idx: idx });
}

/* ---------- 절차적 후보 생성 ---------- */
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randomBoard(rng, layers, shapes) {
  const ri = n => Math.floor(rng() * n);
  const layer = 1 + ri(layers);
  const wood = WOODS[ri(WOODS.length)];
  const kind = shapes[ri(shapes.length)];
  const c = ri(5), r = ri(7);
  if (kind === 'h') {
    const len = 2 + ri(3), c0 = ri(5 - len);
    const extra = []; for (let i = 1; i < len; i++) if (rng() < 0.5) extra.push([c0 + i, r]);
    return plank([c0, r], [c0 + len, r], layer, wood, extra);
  }
  if (kind === 'v') {
    const len = 2 + ri(3), r0 = ri(7 - len);
    const extra = []; for (let i = 1; i < len; i++) if (rng() < 0.5) extra.push([c, r0 + i]);
    return plank([c, r0], [c, r0 + len], layer, wood, extra);
  }
  if (kind === 'd') {
    const n = 1 + ri(2), sx = rng() < 0.5 ? 1 : -1;
    const c0 = sx > 0 ? ri(5 - n) : n + ri(5 - n), r0 = ri(7 - n);
    const extra = n === 2 ? [[c0 + sx, r0 + 1]] : [];
    return plank([c0, r0], [c0 + sx * n, r0 + n], layer, wood, extra);
  }
  if (kind === 't') {
    const c0 = ri(4), r0 = ri(6), f = rng();
    const tri = f < 0.25 ? [[c0, r0], [c0 + 1, r0], [c0, r0 + 1]] : f < 0.5 ? [[c0, r0], [c0 + 1, r0], [c0 + 1, r0 + 1]] : f < 0.75 ? [[c0, r0], [c0, r0 + 1], [c0 + 1, r0 + 1]] : [[c0 + 1, r0], [c0, r0 + 1], [c0 + 1, r0 + 1]];
    return plate(tri, layer, wood);
  }
  const c0 = ri(4), r0 = ri(6);
  return plate([[c0, r0], [c0 + 1, r0], [c0 + 1, r0 + 1], [c0, r0 + 1]], layer, wood);
}

function mirrorBoard(b) {
  const pts = b._pts.map(p => ({ x: 720 - p.x, y: p.y }));
  const toCell = p => [COLS.indexOf(p.x), ROWS.indexOf(p.y)];
  if (b.shape === 'rect') return plank(toCell(pts[0]), toCell(pts[1]), b.layer, b.wood, pts.slice(2).map(toCell));
  return plate(pts.map(toCell), b.layer, b.wood);
}

function generate(seed, cfg) {
  const rng = mulberry(seed);
  const ri = n => Math.floor(rng() * n);
  const boards = [];
  const n = cfg.boardsMin + ri(cfg.boardsMax - cfg.boardsMin + 1);
  const mirror = rng() < cfg.mirror;
  let tries = 0;
  const fits = (b) => {
    const pb = worldPoly(b);
    if (pb.some(p => p.x < 6 || p.x > 714 || p.y < 200 || p.y > 1060)) return false;
    let touching = boards.length === 0;
    for (const o of boards) {
      if (key(o._pts[0]) === key(b._pts[0]) && key(o._pts[1]) === key(b._pts[1])) return false;
      const po = worldPoly(o);
      if (o.layer === b.layer) { if (satOverlap(po, pb, 14)) return false; } else if (satOverlap(po, pb, -8)) touching = true;
    }
    return touching;
  };
  while (boards.length < n && tries++ < 400) {
    const b = randomBoard(rng, cfg.layers, cfg.shapes);
    if (!fits(b)) continue;
    boards.push(b);
    if (mirror && boards.length < n) {
      const m = mirrorBoard(b);
      const samePos = m._pts.every(p => b._pts.some(q => key(p) === key(q)));
      if (!samePos && fits(m)) boards.push(m);
    }
  }
  if (boards.length < cfg.boardsMin) return null;

  // 판자별 구멍 지도
  const holeMap = new Map();
  boards.forEach((b, i) => b._pts.forEach(p => {
    const k = key(p);
    if (!holeMap.has(k)) holeMap.set(k, { p, boards: [] });
    holeMap.get(k).boards.push(i);
  }));

  const chosen = new Set();
  const pinCount = boards.map(() => 0);
  const addPoint = k => {
    if (chosen.has(k)) return;
    chosen.add(k);
    holeMap.get(k).boards.forEach(i => { pinCount[i]++; });
  };
  // 겹친 구멍 우선
  const shared = [...holeMap.entries()].filter(([, v]) => v.boards.length > 1);
  shared.sort(() => rng() - 0.5).slice(0, 1 + ri(3)).forEach(([k]) => addPoint(k));
  boards.forEach((b, i) => {
    const pool = b._pts.map(key).sort(() => rng() - 0.5);
    for (const k of pool) { if (pinCount[i] >= 2) break; addPoint(k); }
  });
  if (chosen.size < cfg.screwsMin || chosen.size > cfg.screwsMax) return null;

  const screwPts = [...chosen].map(k => holeMap.get(k).p);
  // 주차 구멍
  const allCells = [];
  COLS.forEach((x, c) => ROWS.forEach((y, r) => { if (!chosen.has(key({ x, y }))) allCells.push([c, r]); }));
  allCells.sort(() => rng() - 0.5);
  const parkN = cfg.parkMin + ri(cfg.parkMax - cfg.parkMin + 1);
  // 첫 주차 구멍은 열려 있고, 나머지는 판자에 가려져 있도록 해 순서·회전 의존성을 만든다.
  const polys = boards.map(worldPoly);
  const isCovered = c => {
    const p = pt(c), d = 4, sq = [{ x: p.x - d, y: p.y - d }, { x: p.x + d, y: p.y - d }, { x: p.x + d, y: p.y + d }, { x: p.x - d, y: p.y + d }];
    return polys.some(q => satOverlap(q, sq, 0));
  };
  const open = allCells.filter(c => !isCovered(c)), hidden = allCells.filter(isCovered);
  if (!open.length) return null;
  const parkPts = [pt(open[0])].concat(hidden.slice(0, parkN - 1).map(pt));
  // 비어 있는 판자 구멍 일부도 벽 구멍으로 노출
  for (const [k, v] of holeMap) {
    if (!chosen.has(k) && !parkPts.some(p => key(p) === k) && rng() < cfg.boardHoleExpose) parkPts.push(v.p);
  }
  return assemble(boards, screwPts, parkPts);
}

const CFG = {
  mid: { boardsMin: 3, boardsMax: 5, layers: 3, shapes: ['h', 'v', 'd', 'd', 't', 'q'], mirror: 0.45, screwsMin: 4, screwsMax: 8, parkMin: 2, parkMax: 4, boardHoleExpose: 0.3, maxEdges: 1500 },
  high: { boardsMin: 5, boardsMax: 8, layers: 4, shapes: ['h', 'v', 'h', 'v', 'd', 't', 'q'], mirror: 0.4, screwsMin: 6, screwsMax: 12, parkMin: 2, parkMax: 4, boardHoleExpose: 0.25, maxEdges: 2500 }
};

function evalSeed(seed, tier) {
  const cfg = CFG[tier];
  const lv = generate(seed, cfg);
  if (!lv) return null;
  if (validateStart(lv)) return null;
  const w = new P.PuzzleWorld(lv, { silent: true });
  w.settle();
  if (w.legalMoves().length === 0) return null;
  const r = P.solveSync(lv, w.snapshot(), { maxEdges: cfg.maxEdges, weight: 1.25, maxDepth: 30 });
  if (!r.found) return null;
  const a = analyze(lv, r.path);
  return { seed, tier, moves: r.path.length, screws: lv.screws.length, boards: lv.boards.length, edges: r.edges, ...a };
}

const SLACK = { mid: 2, high: 2 };
const BEGINNER_SLACK = 2;

/** 후보를 최단 탐색하고, 첫 수 중 함정(남은 이동으로 풀 수 없는 수)의 수를 센다. */
function refineSeed(seed, tier) {
  const cfg = CFG[tier];
  const lv = generate(seed, cfg);
  const w = new P.PuzzleWorld(lv, { silent: true });
  w.settle();
  const start = w.snapshot();
  let r = P.solveSync(lv, start, { maxEdges: 9000, weight: 1, maxDepth: 30 });
  let optimal = true;
  if (!r.found) { r = P.solveSync(lv, start, { maxEdges: 4000, weight: 1.25, maxDepth: 30 }); optimal = false; }
  if (!r.found) return null;
  const limit = r.path.length + SLACK[tier];
  const first = w.legalMoves();
  let traps = 0, tested = 0;
  for (const m of first) {
    w.restore(start);
    w.commit(m.s, m.to); w.settle();
    const s = P.solveSync(lv, w.snapshot(), { maxEdges: 350, weight: 1.7, maxDepth: limit - 1 });
    tested++;
    if (!s.found) traps++;
  }
  const a = analyze(lv, r.path);
  return { seed, tier, moves: r.path.length, optimal, screws: lv.screws.length, boards: lv.boards.length, traps, tested, path: r.path, ...a };
}

/** 첫 수 중 "남은 이동으로 풀 수 없음"이 증명된 수를 센다. 탐색 한도에 걸린 수는 함정으로 치지 않는다. */
function retrapSeed(seed, tier, moves) {
  const lv = generate(seed, CFG[tier]);
  const w = new P.PuzzleWorld(lv, { silent: true });
  w.settle();
  const start = w.snapshot();
  const first = w.legalMoves();
  let proven = 0, unknown = 0;
  for (const m of first) {
    w.restore(start);
    w.commit(m.s, m.to); w.settle();
    const s = P.solveSync(lv, w.snapshot(), { maxEdges: 2500, weight: 1.25, maxDepth: moves + SLACK[tier] - 1 });
    if (!s.found) { if (s.exhausted) proven++; else unknown++; }
  }
  return { seed, tier, proven, unknown, tested: first.length };
}

function poolScore(c) { return c.moves * 2 + (c.moves - c.screws) * 5 + c.locked * 3 + Math.min(c.rotDep, 3) * 2 - c.firstMoves * 0.12; }
/* ---------- 메인 ---------- */
function finishLevel(lv, id, tierName, sol, slack, meta) {
  const w = new P.PuzzleWorld(lv, { silent: true });
  w.settle();
  const ids = lv.screws.map(s => s.id);
  const solution = sol.map(m => ({ screw: ids[w.screwAtHole(m.from)], from: lv.holes[m.from].id, to: lv.holes[m.to].id, _s: 0 }));
  // screw 식별자를 재생으로 정확히 맞춘다.
  solution.length = 0;
  for (const m of sol) {
    const si = w.screwAtHole(m.from);
    solution.push({ screw: ids[si], from: lv.holes[m.from].id, to: lv.holes[m.to].id });
    if (!w.commit(si, m.to)) throw new Error('replay failed on level ' + id);
    w.settle();
  }
  if (!w.won()) throw new Error('solution does not win on level ' + id);
  return Object.assign({ levelId: id, difficulty: tierName, name: meta.name, tip: meta.tip || '' }, {
    boards: lv.boards, holes: lv.holes, screws: lv.screws,
    moveLimit: sol.length + slack, targetMoves: sol.length, solution
  });
}

if (!isMainThread) {
  const { seeds, tier, refine, retrap } = workerData;
  for (const s of seeds) {
    let r = null;
    try { r = retrap ? retrapSeed(s, tier, retrap[s]) : refine ? refineSeed(s, tier) : evalSeed(s, tier); } catch (e) { parentPort.postMessage({ err: String(e) }); }
    parentPort.postMessage({ r, done: 1 });
  }
} else {
  const mode = process.argv[2];
  const poolPath = path.join(__dirname, 'pool.json');
  if (mode === 'hand') {
    HAND.forEach((d, i) => {
      const lv = buildHand(d, i);
      const err = validateStart(lv);
      const w = new P.PuzzleWorld(lv, { silent: true });
      w.settle();
      const r = P.solveSync(lv, w.snapshot(), { maxEdges: 5000, weight: 1, maxDepth: 12 });
      console.log(i + 1, d.name, 'err=' + err, 'B' + lv.boards.length, 'S' + lv.screws.length, 'found', r.found, r.found ? r.path.length : '-', 'edges', r.edges, r.found ? JSON.stringify(analyze(lv, r.path)) : '');
    });
  } else if (mode === 'pool') {
    const N = { mid: +process.argv[3] || 6000, high: +process.argv[4] || 6000 };
    const THREADS = Math.max(2, require('os').cpus().length - 2);
    const out = fs.existsSync(poolPath) ? JSON.parse(fs.readFileSync(poolPath)) : [];
    const known = new Set(out.map(o => o.tier + o.seed));
    const jobs = [];
    ['mid', 'high'].forEach(t => { for (let s = 1; s <= N[t]; s++) if (!known.has(t + s)) jobs.push({ s, t }); });
    let pending = 0, done = 0, t0 = Date.now();
    ['mid', 'high'].forEach(t => {
      const list = jobs.filter(j => j.t === t).map(j => j.s);
      const per = Math.ceil(list.length / THREADS);
      for (let i = 0; i < THREADS; i++) {
        const seeds = list.slice(i * per, (i + 1) * per);
        if (!seeds.length) continue;
        pending++;
        const wk = new Worker(__filename, { workerData: { seeds, tier: t } });
        wk.on('message', m => {
          if (m.err) console.error(m.err);
          if (m.r) out.push(m.r);
          if (m.done && ++done % 500 === 0) {
            console.log(done, '/', jobs.length, 'kept', out.length, Math.round((Date.now() - t0) / 1000) + 's');
            fs.writeFileSync(poolPath, JSON.stringify(out));
          }
        });
        wk.on('exit', () => {
          if (--pending === 0) { fs.writeFileSync(poolPath, JSON.stringify(out)); console.log('pool done', out.length, Math.round((Date.now() - t0) / 1000) + 's'); }
        });
      }
    });
  } else if (mode === 'refine') {
    const pool = JSON.parse(fs.readFileSync(poolPath));
    const pick = (t, f, n) => pool.filter(c => c.tier === t && f(c)).sort((a, b) => poolScore(b) - poolScore(a)).slice(0, n);
    const mid = pick('mid', c => c.cross >= 1 && c.rotDep >= 1 && c.moves >= 4, 90);
    const high = pick('high', c => c.boards >= 5 && c.locked >= 1 && c.moves >= 7 && c.cross >= 2, 90);
    console.log('refine', mid.length, high.length);
    const out = [];
    const THREADS = Math.max(2, require('os').cpus().length - 2);
    let pending = 0;
    [['mid', mid], ['high', high]].forEach(([t, list]) => {
      const seeds = list.map(c => c.seed);
      const per = Math.ceil(seeds.length / THREADS);
      for (let i = 0; i < THREADS; i++) {
        const part = seeds.slice(i * per, (i + 1) * per);
        if (!part.length) continue;
        pending++;
        const wk = new Worker(__filename, { workerData: { seeds: part, tier: t, refine: true } });
        wk.on('message', m => { if (m.err) console.error(m.err); if (m.r) out.push(m.r); });
        wk.on('exit', () => {
          if (--pending === 0) { fs.writeFileSync(path.join(__dirname, 'refined.json'), JSON.stringify(out)); console.log('refined', out.length); }
        });
      }
    });
  } else if (mode === 'retrap') {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'refined.json'))).filter(c => c.tier === 'high');
    const movesOf = {}; list.forEach(c => { movesOf[c.seed] = c.moves; });
    const seeds = list.map(c => c.seed), out = {};
    const THREADS = Math.max(2, require('os').cpus().length - 2), per = Math.ceil(seeds.length / THREADS);
    let pending = 0;
    for (let i = 0; i < THREADS; i++) {
      const part = seeds.slice(i * per, (i + 1) * per);
      if (!part.length) continue;
      pending++;
      const wk = new Worker(__filename, { workerData: { seeds: part, tier: 'high', retrap: movesOf } });
      wk.on('message', m => { if (m.err) console.error(m.err); if (m.r) out[m.r.tier + m.r.seed] = m.r; });
      wk.on('exit', () => { if (--pending === 0) { fs.writeFileSync(path.join(__dirname, 'traps.json'), JSON.stringify(out)); console.log('traps', Object.keys(out).length); } });
    }
  } else if (mode === 'write') {
    const refined = JSON.parse(fs.readFileSync(path.join(__dirname, 'refined.json')));
    const trapData = JSON.parse(fs.readFileSync(path.join(__dirname, 'traps.json')));
    refined.forEach(c => { const x = trapData[c.tier + c.seed]; if (x) { c.proven = x.proven; c.unknown = x.unknown; c.testedP = x.tested; } });
    const levels = [];
    HAND.forEach((d, i) => {
      const lv = buildHand(d, i);
      const err = validateStart(lv);
      if (err) throw new Error('hand ' + (i + 1) + ' ' + err);
      if (lv.boards.length > 3 || lv.screws.length > 3) throw new Error('hand ' + (i + 1) + ' exceeds beginner limits');
      const w = new P.PuzzleWorld(lv, { silent: true });
      w.settle();
      const r = P.solveSync(lv, w.snapshot(), { maxEdges: 8000, weight: 1, maxDepth: 12 });
      if (!r.found) throw new Error('hand ' + (i + 1) + ' unsolved');
      if (![0.05, 0.1, 0.15, 0.25, 0.35, 0.45, 0.6, 0.8].every(j => { const x = new P.PuzzleWorld(lv, { silent: true, jitter: j }); x.settle(); for (const m of r.path) { const si = x.screwAtHole(m.from); if (si < 0 || !x.isLegal(si, m.to)) return false; x.commit(si, m.to); x.settle(); } return x.won(); })) throw new Error('hand ' + (i + 1) + ' not robust');
      levels.push(finishLevel(lv, i + 1, 'beginner', r.path, BEGINNER_SLACK, { name: d.name, tip: d.tip }));
    });
    const NAMES = {
      mid: ['엇갈린 들보', '돌쩌귀', '풍차 날개', '비스듬한 선반', '문설주', '접이식 다리', '기울어진 처마', '걸쇠', '삼각 지지대', '장부 맞춤'],
      high: ['서까래', '대들보 잇기', '겹겹의 궤', '장인의 시험', '반닫이', '고방의 자물쇠', '누각의 공포', '마지막 전 관문', '대목장의 도면', '천년 목조']
    };
    const choose = (tier, need, filter, cfg) => {
      const list = refined.filter(c => c.tier === tier && robustSet.has(c.tier + c.seed) && filter(c)).sort((a, b) => a.moves - b.moves || poolScore(a) - poolScore(b));
      if (list.length < need) throw new Error(tier + ' candidates ' + list.length);
      const out = [];
      for (let i = 0; i < need; i++) out.push(list[Math.round((i + 0.5) * list.length / need - 0.5)]);
      return out;
    };
    // 작은 좌표 오차에도 정답이 유지되는 후보만 쓴다(판자가 나사 위에서 균형을 잡는 수순 제거).
    const robust = (lv, sol) => [0.05, 0.1, 0.15, 0.25, 0.35, 0.45, 0.6, 0.8].every(j => {
      const w = new P.PuzzleWorld(lv, { silent: true, jitter: j });
      w.settle();
      for (const m of sol) {
        const si = w.screwAtHole(m.from);
        if (si < 0 || !w.isLegal(si, m.to)) return false;
        w.commit(si, m.to); w.settle();
      }
      return w.won();
    });
    const robustSet = new Set(refined.filter(c => robust(generate(c.seed, CFG[c.tier]), c.path)).map(c => c.tier + c.seed));
    console.log('robust candidates', robustSet.size, '/', refined.length);
    const mids = choose('mid', 10, c => c.boards >= 3 && c.boards <= 5 && c.cross >= 1 && c.rotDep >= 1);
    // 함정이 증명된 후보를 모두 쓰고, 모자라면 정답이 길고 덮인 나사가 많은 후보로 채운다.
    const highPool = refined.filter(c => c.tier === 'high' && robustSet.has('high' + c.seed) && c.boards >= 5 && c.locked >= 1);
    const trapped = highPool.filter(c => c.proven >= 1).sort((x, y) => y.proven / y.testedP - x.proven / x.testedP).slice(0, 10);
    const filler = highPool.filter(c => !(c.proven >= 1)).sort((x, y) => y.moves - x.moves || y.locked - x.locked || poolScore(y) - poolScore(x)).slice(0, 10 - trapped.length);
    const highs = trapped.concat(filler).sort((x, y) => x.moves - y.moves || (x.proven || 0) - (y.proven || 0));
    if (highs.length < 10) throw new Error('high candidates ' + highs.length);
    [[mids, 'mid', 'intermediate', 11], [highs, 'high', 'advanced', 21]].forEach(([list, tier, name, base]) => {
      list.forEach((c, i) => {
        const lv = generate(c.seed, CFG[tier]);
        levels.push(finishLevel(lv, base + i, name, c.path, SLACK[tier], { name: NAMES[tier][i], tip: '' }));
        console.log(base + i, tier, 'B' + c.boards, 'S' + c.screws, 'moves', c.moves, c.optimal ? 'opt' : 'sub', 'locked', c.locked, 'traps', (c.proven !== undefined ? c.proven + '/' + c.testedP + ' (unknown ' + c.unknown + ')' : c.traps + '/' + c.tested), 'rot', c.rotDep, 'cross', c.cross);
      });
    });
    const body = levels.map(l => '  ' + JSON.stringify(l)).join(',\n');
    fs.writeFileSync(path.join(__dirname, '..', 'levels.js'),
`/* levels.js — 30개 스테이지 데이터. tools/build_levels.js가 생성하고 tests/verify_levels.js가 검증한다. */
(function (root) {
  'use strict';
  const LEVELS = [
${body}
  ];
  if (typeof module === 'object' && module.exports) module.exports = LEVELS;
  else root.WSM_LEVELS = LEVELS;
})(typeof self !== 'undefined' ? self : this);
`);
    console.log('levels.js written', levels.length);
  } else if (mode === 'one') {
    const t0 = Date.now();
    let kept = 0;
    for (let s = 1; s <= +process.argv[4]; s++) { const r = evalSeed(s, process.argv[3]); if (r) { kept++; console.log(JSON.stringify(r)); } }
    console.log('kept', kept, 'ms', Date.now() - t0);
  }
}

module.exports = { HAND, buildHand, generate, CFG, finishLevel, validateStart, analyze };
