/* audio.js — 외부 음원 없이 Web Audio로 합성하는 효과음 */
(function (root) {
  'use strict';
  let ctx = null, master = null, enabled = true, noiseBuf = null;

  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  function tone(freq, dur, type, vol, when, slideTo) {
    const t = ctx.currentTime + (when || 0);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(dur, freq, q, vol, when) {
    const t = ctx.currentTime + (when || 0);
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf;
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.3, dur + 0.02);
  }

  const SFX = {
    tap() { noise(0.04, 2400, 3, 0.25); tone(900, 0.05, 'triangle', 0.08); },
    select() { tone(620, 0.08, 'triangle', 0.14); tone(930, 0.1, 'sine', 0.08, 0.04); },
    cancel() { tone(420, 0.09, 'triangle', 0.1, 0, 300); },
    deny() { noise(0.09, 300, 2, 0.35); tone(150, 0.12, 'square', 0.05); },
    unscrew() { for (let i = 0; i < 5; i++) noise(0.025, 3200 + i * 180, 6, 0.28, i * 0.032); },
    screwIn() { for (let i = 0; i < 6; i++) noise(0.025, 3900 - i * 240, 6, 0.28, i * 0.028); tone(180, 0.07, 'sine', 0.2, 0.17); },
    thud(v) { const k = Math.min(1, v || 0.5); noise(0.14, 170, 1.1, 0.5 * k + 0.1); tone(95, 0.13, 'sine', 0.26 * k + 0.05, 0, 55); },
    fall() { noise(0.28, 420, 0.8, 0.22); tone(130, 0.24, 'sine', 0.12, 0, 60); },
    hint() { tone(1046, 0.16, 'sine', 0.1); tone(1568, 0.22, 'sine', 0.08, 0.1); },
    undo() { tone(500, 0.1, 'triangle', 0.12, 0, 330); },
    star(i) { tone(740 * Math.pow(1.26, i), 0.32, 'triangle', 0.16); tone(1480 * Math.pow(1.26, i), 0.26, 'sine', 0.06, 0.03); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.34, 'triangle', 0.15, i * 0.11)); },
    fail() { [330, 277, 220].forEach((f, i) => tone(f, 0.34, 'sawtooth', 0.06, i * 0.16)); }
  };

  root.WSMAudio = {
    unlock() { if (enabled) ensure(); },
    setEnabled(v) { enabled = !!v; if (enabled) ensure(); },
    isEnabled() { return enabled; },
    play(name, arg) {
      if (!enabled || !SFX[name] || !ensure()) return;
      try { SFX[name](arg); } catch (e) { /* 오디오 실패는 게임 진행에 영향을 주지 않는다 */ }
    }
  };
})(window);
