/*
 * 실제 Chrome 터치 입력 시험 (게임 실행과 무관한 개발용)
 *   npm i puppeteer-core 후: node tests/e2e.js [screenshot폴더]
 * index.html을 file:// 로 직접 열어 서버 없이 동작하는지도 함께 확인한다.
 */
'use strict';
const path = require('path');
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_ = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const SHOTS = process.argv[2] || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0, checks = 0;
function ok(c, msg) { checks++; console.log((c ? '  ok   ' : '  FAIL ') + msg); if (!c) failures++; }

async function newPage(browser, errors, netlog) {
  const page = await browser.newPage();
  await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14) WSMTest' });
  page.on('pageerror', e => errors.push('pageerror ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console ' + m.text()); });
  page.on('request', r => { if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) netlog.push(r.url()); });
  await page.goto(URL_, { waitUntil: 'load' });
  return page;
}

async function client(page, x, y) {
  return page.evaluate((x, y) => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return { x: r.left + x * r.width / 720, y: r.top + y * r.height / 1280 };
  }, x, y);
}
const tapLogical = async (page, x, y) => { const c = await client(page, x, y); await page.touchscreen.tap(c.x, c.y); };
const tapEl = async (page, sel) => { const h = await page.$(sel); await h.tap(); };
const st = page => page.evaluate(() => {
  const { G } = window.WSM;
  return { mode: G.mode, sel: G.sel, moves: G.moves, anim: !!G.anim, settled: G.world ? G.world.settled : null, left: G.world ? G.world.boardsLeft() : null, hint: G.hint, stack: G.stack.length, end: G.pendingEnd };
});
async function waitFor(page, fn, ms, ...args) { await page.waitForFunction(fn, { timeout: ms, polling: 30 }, ...args); }
const waitReady = page => waitFor(page, () => { const G = window.WSM.G; return !G.anim && G.world.settled; }, 15000);
const holeXY = (page, id) => page.evaluate(id => { const w = window.WSM.G.world; const h = w.def.holes[w.def.holeIndex[id]]; return { x: h.x, y: h.y }; }, id);

async function playMove(page, m, pause) {
  await waitReady(page);
  const a = await holeXY(page, m.from), b = await holeXY(page, m.to);
  await tapLogical(page, a.x, a.y);
  await sleep(pause);
  await tapLogical(page, b.x, b.y);
  await waitFor(page, () => !window.WSM.G.anim, 4000);
  await waitReady(page);
}

async function playLevel(page, n) {
  await page.evaluate(n => window.WSM.startLevel(n - 1), n);
  await waitReady(page);
  const sol = await page.evaluate(() => window.WSM.G.level.solution);
  for (const m of sol) await playMove(page, m, 90);
  await waitFor(page, () => window.WSM.G.mode === 'clear', 6000);
  const r = await page.evaluate(n => ({ s: window.WSM.Save.data.stars[n], b: window.WSM.Save.data.best[n], moves: window.WSM.G.moves, t: window.WSM.G.level.targetMoves }), n);
  return r.s === 3 && r.b === r.t && r.moves === r.t;
}

(async () => {
  const launch = () => puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--allow-file-access-from-files', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const browser = await launch();
  const errors = [], net = [];
  const page = await newPage(browser, errors, net);
  await page.evaluate(k => localStorage.removeItem(k), 'wood-screw-master.save.v1');
  await page.reload({ waitUntil: 'load' });
  const shot = async name => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

  console.log('== 시작·메뉴');
  await sleep(300);
  await shot('01_title');
  ok(await page.evaluate(() => window.WSM_LEVELS.length === 30 && typeof Matter === 'object'), '레벨과 로컬 Matter.js 로드');
  await tapEl(page, '#btn-levels');
  await sleep(120);
  await shot('02_levels');
  ok((await st(page)).mode === 'levels', '단계 선택 화면');
  await tapEl(page, '[data-level="5"]');
  await sleep(120);
  ok((await st(page)).mode === 'levels', '잠긴 단계 진입 거부');
  await tapEl(page, '[data-level="1"]');
  await waitReady(page);
  await shot('03_level1');

  console.log('== 터치: 선택·취소·중복 입력');
  const lv1 = await page.evaluate(() => window.WSM.G.level);
  const s0 = await holeXY(page, lv1.screws[0].holeId);
  await tapLogical(page, s0.x, s0.y);
  await sleep(110);
  ok((await st(page)).sel === 0, '나사 터치로 선택');
  await sleep(250);
  await shot('04_selected');
  await tapLogical(page, s0.x, s0.y);
  await sleep(110);
  ok((await st(page)).sel === -1, '같은 나사 다시 터치로 취소');
  // 빠른 연속 탭: 70ms 안의 두 번째 탭은 무시되어 선택이 유지된다
  await page.evaluate((x, y) => {
    const c = document.getElementById('stage'), r = c.getBoundingClientRect();
    const cx = r.left + x * r.width / 720, cy = r.top + y * r.height / 1280;
    const fire = (t, id) => c.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: cx, clientY: cy, bubbles: true, isPrimary: true, button: 0 }));
    fire('pointerdown', 7); fire('pointerup', 7); fire('pointerdown', 8); fire('pointerup', 8);
  }, s0.x, s0.y);
  await sleep(120);
  ok((await st(page)).sel === 0, '빠른 연속 탭은 한 번만 처리');
  // 두 번째 손가락 무시
  await page.evaluate((x, y) => {
    const c = document.getElementById('stage'), r = c.getBoundingClientRect();
    const cx = r.left + x * r.width / 720, cy = r.top + y * r.height / 1280;
    const fire = (t, id, X, Y) => c.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: X, clientY: Y, bubbles: true, button: 0 }));
    fire('pointerdown', 21, cx, cy); fire('pointerdown', 22, cx + 30, cy + 30); fire('pointerup', 22, cx + 30, cy + 30); fire('pointerup', 21, cx, cy);
  }, s0.x, s0.y);
  await sleep(120);
  ok((await st(page)).sel === -1, '두 번째 손가락은 무시');
  // 판자 위 빈 곳 터치는 선택 없음 + 나사 이동 중 입력 차단
  await tapLogical(page, s0.x, s0.y);
  await sleep(100);
  const empty = await holeXY(page, lv1.solution[0].to);
  await tapLogical(page, 40, 1050);
  await sleep(100);
  ok((await st(page)).sel === -1, '빈 곳 터치로 취소');
  await tapLogical(page, s0.x, s0.y); await sleep(100);
  await tapLogical(page, empty.x, empty.y); await sleep(40);
  await tapLogical(page, s0.x, s0.y); await sleep(40);
  const mid = await st(page);
  ok(mid.anim && mid.sel === -1, '이동 애니메이션 중 입력 차단');

  console.log('== 클리어와 저장');
  await waitFor(page, () => window.WSM.G.mode === 'clear', 8000);
  await sleep(1400);
  await shot('05_clear');
  const saved = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), 'wood-screw-master.save.v1');
  ok(saved.unlocked === 2 && saved.stars['1'] === 3 && saved.best['1'] === 1, '해금·별·최고 기록 저장');
  ok(await page.evaluate(() => document.querySelectorAll('.star.lit').length === 3), '별 애니메이션 3개 점등');
  await tapEl(page, '[data-act="next"]');
  await waitReady(page);

  console.log('== 되돌리기');
  const lv2 = await page.evaluate(() => window.WSM.G.level);
  const before = await page.evaluate(() => JSON.stringify(window.WSM.G.world.snapshot()));
  await playMove(page, lv2.solution[0], 90);
  let s = await st(page);
  ok(s.moves === 1 && s.stack === 1, '이동 횟수 증가');
  await shot('06_swing');
  await tapEl(page, '#btn-undo');
  await sleep(80);
  s = await st(page);
  ok(s.moves === 0 && s.stack === 0, '되돌리기로 이동 횟수 복원');
  ok(await page.evaluate(b => JSON.stringify(window.WSM.G.world.snapshot()) === b, before), '되돌리기로 물리 상태 복원');

  console.log('== 힌트');
  await tapEl(page, '#btn-hint');
  await sleep(120);
  s = await st(page);
  const exp = await page.evaluate(() => { const G = window.WSM.G, m = G.level.solution[0]; return { from: G.world.def.holeIndex[m.from], to: G.world.def.holeIndex[m.to] }; });
  ok(s.hint && s.hint.from === exp.from && s.hint.to === exp.to, '정답 경로 힌트가 저장된 수순과 일치');
  await shot('07_hint');

  console.log('== 실패');
  // 나사 하나를 주차 구멍 사이로 옮겨 이동 제한까지 소모
  const failed = await page.evaluate(() => window.WSM.G.level.moveLimit);
  let guard = 0;
  while ((await st(page)).mode === 'play' && guard++ < failed + 2) {
    await waitReady(page);
    const m = await page.evaluate(() => {
      const w = window.WSM.G.world;
      const parked = w.st.s.findIndex((x, i) => x.p.length === 0 && w.legalTargets(i).length > 0);
      const si = parked >= 0 ? parked : w.st.s.findIndex((x, i) => w.legalTargets(i).length > 0);
      const free = w.legalTargets(si);
      const h0 = w.def.holes[w.st.s[si].h];
      const h = w.def.holes[free[free.length - 1]];
      return { a: { x: h0.x, y: h0.y }, b: { x: h.x, y: h.y } };
    });
    if (await page.evaluate(() => window.WSM.G.world.pinCounts()[0] === 1 && window.WSM.G.moves < window.WSM.G.level.moveLimit - 1 && false)) break;
    await tapLogical(page, m.a.x, m.a.y); await sleep(90);
    await tapLogical(page, m.b.x, m.b.y);
    await waitFor(page, () => !window.WSM.G.anim, 4000);
    await waitReady(page);
    await sleep(500);
  }
  s = await st(page);
  ok(s.mode === 'fail' || s.mode === 'clear', '소모 후 종료 상태 도달: ' + s.mode);
  if (s.mode === 'fail') {
    await shot('08_fail');
    await tapEl(page, '[data-act="undo"]');
    await sleep(100);
    s = await st(page);
    ok(s.mode === 'play', '실패 화면에서 되돌리기');
    await tapEl(page, '#btn-restart');
    await sleep(100);
    s = await st(page);
    ok(s.moves === 0 && s.stack === 0, '재시작');
  }

  console.log('== 일시정지·소리');
  await page.evaluate(() => window.WSM.startLevel(1));
  await waitReady(page);
  await page.evaluate(() => window.WSM.G.level);
  const lv = await page.evaluate(() => window.WSM.G.level);
  await playMove(page, lv.solution[0], 90);
  await page.evaluate(() => { const w = window.WSM.G.world; w.restore(w.snapshot()); });
  await tapEl(page, '#btn-pause');
  await sleep(120);
  s = await st(page);
  ok(s.mode === 'pause', '일시정지');
  await shot('09_pause');
  await page.evaluate(() => { window.__p0 = JSON.stringify(window.WSM.G.world.snapshot()); });
  await sleep(400);
  ok(await page.evaluate(() => JSON.stringify(window.WSM.G.world.snapshot()) === window.__p0), '일시정지 중 물리 멈춤');
  await tapEl(page, '[data-act="resume"]');
  await sleep(80);
  ok((await st(page)).mode === 'play', '계속하기');
  await tapEl(page, '#btn-sound');
  await sleep(50);
  ok((await page.evaluate(k => JSON.parse(localStorage.getItem(k)).sound, 'wood-screw-master.save.v1')) === false, '소리 설정 저장');

  console.log('== 재접속 후 유지');
  await page.reload({ waitUntil: 'load' });
  await sleep(200);
  const d = await page.evaluate(() => window.WSM.Save.data);
  ok(d.unlocked >= 2 && d.stars['1'] === 3 && d.sound === false, '새로고침 후 진행 유지');
  ok((await page.evaluate(() => document.getElementById('sound-label').textContent)) === '소리 끔', '소리 표시 유지');

  console.log('== 정답 이탈 재탐색 힌트');
  await page.evaluate(() => window.WSM.startLevel(13));
  await waitReady(page);
  // 정답의 첫 수와 다른 합법 수를 둔다
  await page.evaluate(() => {
    const G = window.WSM.G, w = G.world, sol = G.level.solution[0];
    const moves = w.legalMoves().filter(m => w.def.holes[w.st.s[m.s].h].id !== sol.from || w.def.holes[m.to].id !== sol.to);
    const m = moves[moves.length - 1];
    const snap = w.snapshot();
    w.commit(m.s, m.to);
    G.stack.push({ snap, moves: G.moves }); G.moves++; G.dirty = true;
  });
  await waitReady(page);
  await tapEl(page, '#btn-hint');
  await waitFor(page, () => !window.WSM.G.searching && window.WSM.G.mode === 'play', 12000);
  await sleep(150);
  s = await st(page);
  const toastTxt = await page.evaluate(() => document.getElementById('toast').textContent);
  ok(!!s.hint || /재시작/.test(toastTxt), '이탈 상태에서 힌트 또는 재시작 안내: ' + (s.hint ? 'move' : toastTxt));
  await sleep(200);
  await shot('10_offpath');
  ok(net.length === 0, '외부 네트워크 요청 없음 (' + net.length + ')');

  console.log('== PC 마우스');
  {
    const pc = await browser.newPage();
    await pc.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    pc.on('pageerror', e => errors.push('pageerror ' + e.message));
    await pc.goto(URL_, { waitUntil: 'load' });
    await pc.evaluate(() => window.WSM.startLevel(0));
    await waitReady(pc);
    const box = await pc.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { l: r.left, w: r.width, h: r.height }; });
    ok(Math.abs(box.l + box.w / 2 - 640) < 2 && Math.abs(box.w / box.h - 9 / 16) < 0.01, 'PC 중앙 정렬 9:16');
    const lvp = await pc.evaluate(() => window.WSM.G.level);
    const a = await holeXY(pc, lvp.solution[0].from), b = await holeXY(pc, lvp.solution[0].to);
    const ca = await client(pc, a.x, a.y), cb = await client(pc, b.x, b.y);
    await pc.mouse.click(ca.x, ca.y); await sleep(120);
    ok((await st(pc)).sel === 0, '마우스 클릭으로 선택');
    await pc.mouse.click(cb.x, cb.y);
    await waitFor(pc, () => window.WSM.G.mode === 'clear', 8000);
    ok(true, '마우스로 클리어');
    if (SHOTS) await pc.screenshot({ path: path.join(SHOTS, '11_pc.png') });
    await pc.close();
  }
  console.log('== 30단계 전체 실제 터치 플레이');
  await page.close();
  const chunks = [[1, 8], [9, 15], [16, 20], [21, 25], [26, 30]];
  const results = {};
  await Promise.all(chunks.map(async ([from, to]) => {
    const b = await launch();
    const p = await newPage(b, errors, net);
    for (let n = from; n <= to; n++) {
      let good = false, msg = '';
      try { good = await playLevel(p, n); } catch (e) { msg = e.message; }
      results[n] = good;
      console.log((good ? '  ok   ' : '  FAIL ') + n + '단계 터치 클리어 ' + msg);
      checks++; if (!good) failures++;
    }
    await b.close();
  }));
  ok(Object.keys(results).length === 30, '30단계 모두 실행');

  ok(errors.length === 0, '콘솔/페이지 오류 없음 ' + errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(`\n결과: ${checks - failures}/${checks} 통과, 실패 ${failures}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
