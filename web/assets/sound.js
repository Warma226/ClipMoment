/* ClipMoment — sound design : musique de fond et effets sonores, générés dans le navigateur.
   Tout est synthétisé (aucun fichier audio) : pas de droits d'auteur, rien à télécharger.
   Le « lit sonore » d'un clip (musique + effets) est rendu d'un bloc dans un OfflineAudioContext,
   puis lu en même temps que le montage, calé sur le temps du clip monté. La musique baisse
   automatiquement quand quelqu'un parle. */
(function () {
  'use strict';
  const SR = 32000;
  const STYLES = {
    aucune: { label: 'Aucune' },
    douce: { label: 'Douce', bpm: 84 },
    energique: { label: 'Énergique', bpm: 112 },
    suspense: { label: 'Suspense', bpm: 92 },
  };
  // Progressions en mineur (degrés en demi-tons depuis la tonique) : i–VI–III–VII, i–iv–VI–V, i–VII–VI–VII.
  const PROGS = [[[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], [[0, 3, 7], [5, 8, 12], [-4, 0, 3], [-5, -1, 2]], [[0, 3, 7], [-2, 2, 5], [-4, 0, 3], [-2, 2, 5]]];
  const ROOTS = [57, 55, 52, 60, 53]; // La, Sol, Mi, Do, Fa
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

  function noiseBuffer(ctx, sec) {
    const b = ctx.createBuffer(1, Math.ceil(sec * ctx.sampleRate), ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function env(g, t, a, peak, d, end) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(end || 0.0001, t + a + d); }

  /* ---------- Instruments ---------- */
  function pad(ctx, out, t, dur, notes, bright) {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = bright ? 1600 : 900; f.Q.value = 0.4;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.11, t + Math.min(0.8, dur / 3));
    g.gain.setValueAtTime(0.11, t + dur - 0.4); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.6);
    f.connect(g); g.connect(out);
    notes.forEach((m) => [-6, 6].forEach((det) => {
      const o = ctx.createOscillator(); o.type = bright ? 'sawtooth' : 'triangle'; o.frequency.value = hz(m); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 0.7);
    }));
  }
  function pluck(ctx, out, t, m, vol) {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = hz(m);
    const g = ctx.createGain(); env(g, t, 0.005, vol, 0.45); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.5);
  }
  function kick(ctx, out, t, vol) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const g = ctx.createGain(); env(g, t, 0.003, vol, 0.28); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.32);
  }
  function hat(ctx, out, t, vol, nb) {
    const s = ctx.createBufferSource(); s.buffer = nb;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
    const g = ctx.createGain(); env(g, t, 0.002, vol, 0.05); s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random()); s.stop(t + 0.08);
  }
  function clap(ctx, out, t, vol, nb) {
    const s = ctx.createBufferSource(); s.buffer = nb;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1700; f.Q.value = 0.8;
    const g = ctx.createGain(); env(g, t, 0.004, vol, 0.14); s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random()); s.stop(t + 0.2);
  }
  function bass(ctx, out, t, m, dur, vol) {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = hz(m - 24);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
  }

  /* ---------- Effets ---------- */
  function whoosh(ctx, out, t, vol, nb) { // culmine à t
    const s = ctx.createBufferSource(); s.buffer = nb;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.4;
    f.frequency.setValueAtTime(350, t - 0.28); f.frequency.exponentialRampToValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(900, t + 0.18);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, Math.max(0, t - 0.28)); g.gain.exponentialRampToValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    s.connect(f); f.connect(g); g.connect(out); s.start(Math.max(0, t - 0.28), Math.random()); s.stop(t + 0.25);
  }
  function pop(ctx, out, t, vol) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(520, t); o.frequency.exponentialRampToValueAtTime(1250, t + 0.06);
    const g = ctx.createGain(); env(g, t, 0.003, vol, 0.09); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.12);
  }
  function hit(ctx, out, t, vol, nb) { // impact d'ouverture : basse profonde + souffle
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.6);
    const g = ctx.createGain(); env(g, t, 0.005, vol, 0.9); o.connect(g); g.connect(out); o.start(t); o.stop(t + 1);
    const s = ctx.createBufferSource(); s.buffer = nb;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.5);
    const g2 = ctx.createGain(); env(g2, t, 0.004, vol * 0.5, 0.55); s.connect(f); f.connect(g2); g2.connect(out); s.start(t, Math.random()); s.stop(t + 0.7);
  }
  function ding(ctx, out, t, vol) { // note de fin
    [[1318.5, 1], [1975.5, 0.45], [2637, 0.2]].forEach(([fq, k]) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fq;
      const g = ctx.createGain(); env(g, t, 0.004, vol * k, 1.4); o.connect(g); g.connect(out); o.start(t); o.stop(t + 1.5);
    });
  }

  /* ---------- Musique ---------- */
  const cycleLen = (style) => (60 / STYLES[style].bpm) * 4 * 8; // la progression dure 8 mesures
  function music(ctx, out, style, seed) {
    const S = STYLES[style]; if (!S || !S.bpm) return;
    const beat = 60 / S.bpm, bar = beat * 4, prog = PROGS[seed % PROGS.length], root = ROOTS[(seed >> 3) % ROOTS.length] - (style === 'suspense' ? 12 : 0);
    const nb = noiseBuffer(ctx, 2);
    const total = cycleLen(style) - 0.001;
    for (let b = 0, t = 0; t < total; b++, t = b * bar) {
      const chord = prog[Math.floor(b / 2) % prog.length].map((x) => root + x);
      if (b % 2 === 0) pad(ctx, out, t, bar * 2, chord, style === 'energique');
      for (let k = 0; k < 4; k++) {
        const tb = t + k * beat; if (tb > total) break;
        if (style === 'douce') {
          if (k === 0 || k === 2) kick(ctx, out, tb, 0.18);
          hat(ctx, out, tb + beat / 2, 0.03, nb);
          pluck(ctx, out, tb, chord[(k + b) % 3] + 12, 0.05);
        } else if (style === 'energique') {
          kick(ctx, out, tb, 0.32);
          if (k === 1 || k === 3) clap(ctx, out, tb, 0.12, nb);
          hat(ctx, out, tb + beat / 2, 0.06, nb); hat(ctx, out, tb + beat * 0.75, 0.025, nb);
          bass(ctx, out, tb, chord[0], beat * 0.45, 0.22); bass(ctx, out, tb + beat / 2, chord[0], beat * 0.4, 0.16);
        } else { // suspense : pulsation sourde, tic de montre, notes hautes rares
          kick(ctx, out, tb, k === 0 ? 0.22 : 0.08);
          hat(ctx, out, tb, 0.02, nb);
          if (k === 0 && b % 2 === 1) pluck(ctx, out, tb, chord[2] + 24, 0.035);
        }
      }
    }
  }

  // Une boucle de 8 mesures, rendue une seule fois par style et par clip, puis répétée : rendu rapide même sur téléphone.
  const loops = new Map();
  async function musicLoop(style, seed, OAC) {
    const key = style + ':' + (seed % 15);
    if (loops.has(key)) return loops.get(key);
    const cyc = cycleLen(style), tail = 1.2;
    const ctx = new OAC(1, Math.ceil((cyc + tail) * SR), SR);
    music(ctx, ctx.destination, style, seed);
    const raw = await ctx.startRendering();
    // Les fins de notes qui dépassent la boucle sont replacées au début : raccord sans coupure.
    const n = Math.round(cyc * SR), d = raw.getChannelData(0);
    const out = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: SR }), o = out.getChannelData(0);
    o.set(d.subarray(0, n));
    for (let i = n; i < d.length; i++) o[i - n] += d[i];
    if (loops.size > 8) loops.delete(loops.keys().next().value);
    loops.set(key, out);
    return out;
  }

  /**
   * Rend le lit sonore d'un clip.
   * o = { len, music, musicVol (0–1), sfx (bool), speech: [[a,b]…] (temps monté), cuts: […], pops: […], seed }
   */
  async function build(o) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC || !(o.len > 0)) return null;
    const len = Math.min(o.len, 240);
    const ctx = new OAC(2, Math.ceil((len + 0.2) * SR), SR);
    const master = ctx.createDynamicsCompressor(); master.threshold.value = -14; master.ratio.value = 3; master.connect(ctx.destination);
    // Musique, baissée sous la voix
    if (o.music && o.music !== 'aucune' && o.musicVol > 0) {
      const bus = ctx.createGain(), duck = bus.gain;
      const up = 0.8 * o.musicVol, down = 0.3 * o.musicVol;
      duck.setValueAtTime(0.0001, 0); duck.linearRampToValueAtTime(up, 0.6);
      // On regroupe les paroles séparées de moins de 1,2 s : la musique ne remonte que dans les vraies pauses.
      const sp = [];
      (o.speech || []).slice().sort((x, y) => x[0] - y[0]).forEach(([a, b]) => { const l = sp[sp.length - 1]; if (l && a - l[1] < 1.2) l[1] = Math.max(l[1], b); else sp.push([a, b]); });
      let last = up, tPrev = 0.6;
      sp.forEach(([a, b]) => {
        const s = Math.max(tPrev, a - 0.25), e = Math.max(s + 0.05, a);
        duck.setValueAtTime(last, s); duck.linearRampToValueAtTime(down, e); last = down; tPrev = e;
        if (b + 0.6 < len - 1.6) { duck.setValueAtTime(down, b + 0.15); duck.linearRampToValueAtTime(up, b + 0.6); last = up; tPrev = b + 0.6; }
      });
      const fo = Math.max(tPrev + 0.05, len - 1.6);
      duck.setValueAtTime(last, fo); duck.linearRampToValueAtTime(0.0001, Math.max(fo + 0.1, len));
      bus.connect(master);
      const loop = await musicLoop(o.music, o.seed || 0, OAC);
      const src = ctx.createBufferSource(); src.buffer = loop; src.loop = true; src.connect(bus); src.start(0);
    }
    // Effets
    if (o.sfx) {
      const fx = ctx.createGain(); fx.gain.value = 0.9; fx.connect(master);
      const nb = noiseBuffer(ctx, 2);
      hit(ctx, fx, 0.02, 0.55, nb);
      (o.cuts || []).forEach((t) => { if (t > 0.5 && t < len - 0.3) whoosh(ctx, fx, t, 0.22, nb); });
      let lastPop = -9;
      (o.pops || []).forEach((t) => { if (t - lastPop >= 2.2 && t > 0.6 && t < len - 0.2) { pop(ctx, fx, t, 0.16); lastPop = t; } });
      if (len > 3) ding(ctx, fx, Math.max(0.5, len - 1.3), 0.12);
    }
    return ctx.startRendering();
  }

  /* ---------- Lecture synchronisée avec le montage ---------- */
  let ac = null, out = null, buf = null, node = null, nodeAt = 0, nodeOff = 0;
  function attach(audioCtx, dests) {
    if (ac === audioCtx) return;
    ac = audioCtx; out = ac.createGain(); out.gain.value = 1;
    dests.filter(Boolean).forEach((d) => out.connect(d));
  }
  function stop() { if (node) { try { node.stop(); } catch (e) { /* */ } node.disconnect(); node = null; } }
  function setBuffer(b) { stop(); buf = b; }
  // À appeler à chaque image : lance, arrête ou recale le lit sonore sur le temps monté « rel ».
  function sync(rel, playing) {
    if (!ac || !buf) { stop(); return; }
    if (!playing || rel >= buf.duration - 0.05) { stop(); return; }
    const pos = node ? nodeOff + (ac.currentTime - nodeAt) : -1;
    if (node && Math.abs(pos - rel) < 0.3) return; // tolérance : currentTime de la vidéo avance par à-coups sur certains navigateurs
    stop();
    node = ac.createBufferSource(); node.buffer = buf; node.connect(out);
    nodeAt = ac.currentTime; nodeOff = rel; node.start(0, Math.max(0, rel));
  }

  window.CMSound = { STYLES, build, attach, sync, stop, setBuffer, hash };
})();
