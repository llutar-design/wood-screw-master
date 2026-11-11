/*
 * 레벨·규칙 자동 검증: node tests/verify_levels.js
 * 실제 게임과 같은 physics.js + Matter.js를 고정 스텝으로 돌린다.
 */
'use strict';
const P = require('../physics.js');
const LEVELS = require('../levels.js');

let failures = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { failures++; console.log('  FAIL', msg); } }

function idxMoves(level, world) {
  return level.solution.map(m => ({ from: world.def.holeIndex[m.from], to: world.def.holeIndex[m.to], screw: m.screw }));
}
function settled(level, opts) { const w = new P.PuzzleWorld(level, Object.assign({ silent: true }, opts)); w.settle(); return w; }
function rng(seed) { let a = seed; return () => (a = (a * 1664525 + 1013904223) >>> 0) / 4294967296; }

console.log('== 레벨 데이터 구조와 난이도 규칙');
ok(LEVELS.length === 30, '레벨 30개');
LEVELS.forEach((lv, i) => {
  const tag = 'L' + lv.levelId;
  ok(lv.levelId === i + 1, tag + ' levelId 연속');
  ['levelId', 'difficulty', 'boards', 'holes', 'screws', 'moveLimit', 'targetMoves', 'solution'].forEach(k => ok(lv[k] !== undefined, tag + ' 필드 ' + k));
  const tier = i < 10 ? 'beginner' : i < 20 ? 'intermediate' : 'advanced';
  ok(lv.difficulty === tier, tag + ' 난이도 표기');
  const B = lv.boards.length, S = lv.screws.length;
  if (tier === 'beginner') ok(B >= 1 && B <= 3 && S >= 1 && S <= 3, tag + ` 초급 범위 B${B} S${S}`);
  if (tier === 'intermediate') ok(B >= 3 && B <= 5, tag + ` 중급 범위 B${B}`);
  if (tier === 'advanced') ok(B >= 5, tag + ` 고급 범위 B${B}`);
  lv.boards.forEach(b => ['x', 'y', 'angle', 'mass', 'layer', 'holes'].forEach(k => ok(b[k] !== undefined, tag + ' 판자 ' + k)));
  lv.boards.forEach(b => ok(b.shape === 'poly' ? b.points.length >= 3 : b.w > 0 && b.h > 0, tag + ' 판자 크기'));
  const holeIds = new Set(lv.holes.map(h => h.id));
  ok(holeIds.size === lv.holes.length, tag + ' 구멍 ID 고유');
  const used = new Set();
  lv.screws.forEach(s => { ok(holeIds.has(s.holeId), tag + ' 나사 위치 유효'); ok(!used.has(s.holeId), tag + ' 나사 중복'); used.add(s.holeId); });
  ok(lv.solution.length > 0 && lv.solution.length === lv.targetMoves, tag + ' 정답 길이 = 목표');
  ok(lv.targetMoves <= lv.moveLimit, tag + ' 목표 ≤ 제한');
});
const sig = new Set(LEVELS.map(l => JSON.stringify([l.boards.map(b => [b.x, b.y, b.angle]), l.holes])));
ok(sig.size === 30, '레벨 배치 중복 없음');

console.log('== 시작 상태 안정성 + 30개 정답 재생(섭동 포함)');
const JITTERS = [0, 0.15, 0.35, 0.6];
const report = [];
LEVELS.forEach(lv => {
  const tag = 'L' + lv.levelId;
  const w0 = new P.PuzzleWorld(lv, { silent: true });
  const a = w0.snapshot(); w0.settle(); const b = w0.snapshot();
  a.b.forEach((p, i) => ok(Math.hypot(p.x - b.b[i].x, p.y - b.b[i].y) < 1.6 && Math.abs(p.a - b.b[i].a) < 0.025, tag + ' 시작 안정'));
  ok(w0.pinCounts().every(c => c >= 1), tag + ' 모든 판자 고정');
  JITTERS.forEach(j => {
    const w = settled(lv, { jitter: j });
    let good = true;
    for (const m of idxMoves(lv, w)) {
      const si = w.screwAtHole(m.from);
      if (si < 0 || !w.isLegal(si, m.to)) { good = false; console.log('   ', tag, 'jitter', j, 'illegal step', m); break; }
      w.commit(si, m.to); w.settle();
    }
    ok(good && w.won(), `${tag} 정답 재생 jitter=${j} (남은 판자 ${w.boardsLeft()})`);
  });
  // 재현성: 같은 수순은 같은 최종 스냅샷을 만든다
  const once = () => { const w = settled(lv); idxMoves(lv, w).forEach(m => { w.commit(w.screwAtHole(m.from), m.to); w.settle(); }); return JSON.stringify(w.snapshot()); };
  ok(once() === once(), tag + ' 재현성');
  report.push(`${tag}:${lv.boards.length}B/${lv.screws.length}S/${lv.targetMoves}m`);
});
console.log('  ' + report.join(' '));

console.log('== 규칙 단위 시험');
{
  // 고정·회전·낙하: 2단계(판자 1, 나사 2)
  const lv = LEVELS[1];
  const w = settled(lv);
  const moves = idxMoves(lv, w);
  ok(w.pinCounts()[0] === 2, '나사 2개 고정');
  ok(w.bodies[0].isStatic, '나사 2개면 완전 고정');
  const a0 = w.pose(0).a;
  w.commit(w.screwAtHole(moves[0].from), moves[0].to);
  ok(w.pinCounts()[0] === 1 && !w.bodies[0].isStatic, '나사 1개면 회전 가능');
  ok(w.engine.world.constraints.length === 1, '회전축 제약 1개');
  w.settle();
  ok(Math.abs(w.pose(0).a - a0) > 0.8 && !w.st.b[0].g, '남은 나사를 축으로 회전');
  const pivot = w.st.s.find(s => s.p.length === 1);
  const h = w.def.holes[pivot.h];
  const ph = P.toWorld(w.pose(0), w.def.boards[0].holes[pivot.p[0][1]]);
  ok(Math.hypot(ph.x - h.x, ph.y - h.y) < 4, '회전 후 축 구멍 좌표 동기화');
  w.commit(w.screwAtHole(moves[1].from), moves[1].to);
  ok(w.pinCounts()[0] === 0 && w.engine.world.constraints.length === 0, '고정 해제 시 제약 제거');
  w.settle();
  ok(w.won(), '낙하 판정 후 클리어');
}
{
  // 사용 중·가려진 구멍 금지, 덮인 나사 금지
  const lv = LEVELS[7]; // 덮개 먼저
  const w = settled(lv);
  const lockedIdx = w.st.s.findIndex((s, i) => !w.screwAccessible(i));
  ok(lockedIdx >= 0, '덮인 나사 존재');
  ok(w.legalTargets(lockedIdx).length === 0, '덮인 나사는 이동 불가');
  const si = w.st.s.findIndex((s, i) => w.screwAccessible(i));
  const occupied = w.st.s[(si + 1) % w.st.s.length].h;
  ok(!w.isLegal(si, occupied), '사용 중인 구멍 금지');
  ok(w.commit(si, occupied) === false, '사용 중인 구멍 commit 거부');
  const lv7 = LEVELS[6]; // 가려진 구멍
  const w7 = settled(lv7);
  const parkHidden = w7.def.holes.find(h => h.x === 360 && h.y === 750);
  ok(parkHidden && !w7.holeAvailable(parkHidden.idx), '판자에 가려진 구멍 금지');
}
{
  // 배경 고정: 판자가 없는 구멍의 나사는 아무 판자도 잡지 않는다
  const lv = LEVELS[0];
  const w = settled(lv);
  const m = idxMoves(lv, w)[0];
  w.commit(w.screwAtHole(m.from), m.to);
  ok(w.st.s[0].p.length === 0, '배경 구멍 나사는 판자 비연결');
  // 판자 구멍과 맞물린 구멍으로 돌아가면 다시 고정
  const lv2 = LEVELS[1];
  const w2 = settled(lv2);
  const mv = idxMoves(lv2, w2)[0];
  const si = w2.screwAtHole(mv.from);
  const before = w2.pinCounts()[0];
  w2.commit(si, mv.to);
  ok(w2.pinCounts()[0] === before - 1, '이동 시 고정 감소');
}
{
  // 충돌: 같은 층 판자는 물리적으로 부딪힌다 (9단계)
  const lv = LEVELS[8];
  const w = settled(lv);
  const si = w.st.s.findIndex(s => w.def.holes[s.h].x === 480);
  const free = w.legalTargets(si).find(hi => w.def.holes[hi].y < 300 || w.def.holes[hi].y > 900);
  w.commit(si, free); w.settle();
  const angle = Math.abs(w.pose(0).a);
  ok(angle > 0.25 && angle < 1.45, '같은 층 판자에 걸려 수직까지 돌지 못함 (각도 ' + angle.toFixed(2) + ')');
  const other = w.st.s.findIndex(s => w.def.holes[s.h].y === 630);
  const hole = w.legalTargets(other).find(hi => w.def.holes[hi].y > 900 || w.def.holes[hi].y < 300);
  w.commit(other, hole); w.settle();
  ok(w.st.b[1].g === 1, '받치던 판자 낙하');
  ok(Math.abs(w.pose(0).a) > 1.45, '받침이 사라지면 끝까지 회전');
}
{
  // 나사 몸통 충돌: 1층 판자는 주차된 나사에 걸린다
  const lv = {
    boards: [{ id: 'b1', shape: 'rect', w: 200, h: 68, x: 360, y: 300, angle: 0, mass: 1, layer: 1, wood: 'oak', holes: [{ x: 0, y: 0 }] }],
    holes: [{ id: 'h1', x: 360, y: 300 }, { id: 'h2', x: 290, y: 700 }, { id: 'h3', x: 100, y: 300 }, { id: 'h4', x: 430, y: 700 }],
    screws: [{ id: 's1', holeId: 'h1' }, { id: 's2', holeId: 'h2' }, { id: 's3', holeId: 'h4' }]
  };
  const w = settled(lv);
  ok(w.commit(0, 2), '테스트 나사 이동');
  w.settle();
  ok(!w.won() && Math.abs(w.pose(0).y - 657) < 12, '낙하 판자가 나사 몸통에 걸림 y=' + w.pose(0).y.toFixed(0));
}
{
  // 되돌리기 동등성
  LEVELS.slice(0, 30).forEach(lv => {
    const w = settled(lv);
    const snap = w.snapshot();
    const m = idxMoves(lv, w)[0];
    w.commit(w.screwAtHole(m.from), m.to); w.settle();
    w.restore(snap);
    ok(JSON.stringify(w.snapshot()) === JSON.stringify(snap), `L${lv.levelId} 되돌리기 복원`);
    const again = w.legalMoves().length;
    const w2 = settled(lv);
    ok(again === w2.legalMoves().length, `L${lv.levelId} 되돌린 뒤 합법수 동일`);
  });
}
{
  // 고속 충돌 누락 방지: 최대 속도 제한 확인
  const lv = LEVELS[21];
  const w = settled(lv);
  let maxSpeed = 0;
  idxMoves(lv, w).forEach(m => {
    w.commit(w.screwAtHole(m.from), m.to);
    while (!w.settled) { w.step(); w.bodies.forEach(b => { if (b) maxSpeed = Math.max(maxSpeed, b.speed); }); }
  });
  ok(maxSpeed <= P.TUNE.MAX_SPEED + 0.5, '최대 속도 제한 ' + maxSpeed.toFixed(1));
}

console.log('== 정답 경로 이탈 상태의 재탐색 힌트');
{
  let tried = 0, solved = 0, proved = 0, unknown = 0, totalMs = 0, maxMs = 0;
  LEVELS.forEach((lv, li) => {
    const r = rng(li * 91 + 7);
    for (let run = 0; run < 3; run++) {
      const w = settled(lv);
      const steps = 1 + Math.floor(r() * Math.min(3, lv.moveLimit - 1));
      let used = 0;
      for (let k = 0; k < steps; k++) {
        const legal = w.legalMoves();
        if (!legal.length || w.won()) break;
        const m = legal[Math.floor(r() * legal.length)];
        w.commit(m.s, m.to); w.settle(); used++;
      }
      if (w.won()) continue;
      tried++;
      // 힌트를 끝까지 따라가 실제로 클리어되는지 확인
      let guard = 0, finished = false;
      while (!finished && guard++ < 40) {
        const left = lv.moveLimit - used;
        const t0 = Date.now();
        const res = P.solveSync(lv, w.snapshot(), { maxDepth: left, maxEdges: 2600, weight: 1.7 });
        const ms = Date.now() - t0; totalMs += ms; maxMs = Math.max(maxMs, ms);
        if (!res.found) { if (res.exhausted) proved++; else unknown++; finished = true; break; }
        // 힌트는 경로 첫 수만 제시된다
        const m = res.path[0];
        const si = w.screwAtHole(m.from);
        ok(si >= 0 && w.isLegal(si, m.to), `L${lv.levelId} 힌트 수 합법`);
        w.commit(si, m.to); w.settle(); used++;
        if (w.won()) { solved++; finished = true; }
      }
      ok(finished, `L${lv.levelId} 힌트 추적 종료`);
    }
  });
  console.log(`  이탈 시험 ${tried}회: 클리어 ${solved}, 남은 이동으론 불가 증명 ${proved}, 탐색 한도 초과 ${unknown} (탐색 평균 ${Math.round(totalMs / Math.max(1, tried))}ms, 최대 ${maxMs}ms)`);
  ok(solved + proved + unknown === tried, '모든 이탈 시험이 결론남');
  ok(unknown / Math.max(1, tried) <= 0.08, '탐색 한도 초과(재시작 안내)는 8% 이하');
}

console.log(`\n결과: ${checks - failures}/${checks} 통과, 실패 ${failures}`);
process.exit(failures ? 1 : 0);
