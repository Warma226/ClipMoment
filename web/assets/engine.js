/* ClipMoment — moteur d'analyse : audio, transcription par morceaux, choix des moments. */
(function () {
  'use strict';
  const HOP = 0.25;              // une mesure d'intensité toutes les 0,25 s
  const SR = 16000;              // fréquence envoyée à Whisper
  const CHUNK = 600;             // morceaux d'environ 10 min (≈ 19 Mo en WAV 16 kHz mono)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Audio ---------- */

  async function decodeMono(file) {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) throw new Error('Ton navigateur ne sait pas lire l\'audio. Mets-le à jour.');
    let buf = await file.arrayBuffer();
    let ctx = null;
    for (const sr of [SR, 22050, 44100]) { try { ctx = new AC(1, sr, sr); break; } catch (e) { /* ancien Safari */ } }
    if (!ctx) throw new Error('Impossible de préparer l\'audio sur ce navigateur.');
    let ab = await new Promise((res, rej) => {
      try { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); } catch (err) { rej(err); }
    }).catch(() => { throw new Error('La piste audio de cette vidéo est illisible ou absente.'); });
    buf = null;
    const ch = ab.numberOfChannels, n = ab.length, rate = ab.sampleRate;
    let mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
    ab = null;
    if (rate !== SR) { // rééchantillonnage simple si le navigateur a imposé une autre fréquence
      const m = Math.floor(n * SR / rate), out = new Float32Array(m), k = rate / SR;
      for (let i = 0; i < m; i++) { const x = i * k, i0 = Math.floor(x), f = x - i0; out[i] = mono[i0] * (1 - f) + (mono[Math.min(n - 1, i0 + 1)] || 0) * f; }
      mono = out;
    }
    return { pcm: mono, duration: mono.length / SR };
  }

  function pct(a, p) { const b = Float32Array.from(a).sort(); return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1)))]; }
  function smooth(a, r) {
    const n = a.length, o = new Float32Array(n), P = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) P[i + 1] = P[i] + a[i];
    for (let i = 0; i < n; i++) { const lo = Math.max(0, i - r), hi = Math.min(n, i + r + 1); o[i] = (P[hi] - P[lo]) / (hi - lo); }
    return o;
  }

  function energy(pcm) {
    const hop = Math.round(SR * HOP), n = Math.floor(pcm.length / hop), db = new Float32Array(Math.max(1, n));
    for (let i = 0; i < n; i++) { let s = 0; const o = i * hop; for (let j = 0; j < hop; j++) { const v = pcm[o + j]; s += v * v; } db[i] = 20 * Math.log10(Math.sqrt(s / hop) + 1e-5); }
    const lo = pct(db, 0.1), hi = pct(db, 0.99), span = Math.max(6, hi - lo);
    const e = db.map((v) => clamp((v - lo) / span, 0, 1));
    const es = smooth(e, 2), d = new Float32Array(e.length);
    for (let i = 1; i < e.length; i++) d[i] = Math.max(0, e[i] - e[i - 1]);
    let on = smooth(d, 3); const ho = pct(on, 0.98) || 1; on = on.map((v) => Math.min(1, v / ho));
    const f = new Float32Array(e.length); for (let i = 0; i < e.length; i++) f[i] = 0.65 * es[i] + 0.35 * on[i];
    return { e, es, on, f, hop: HOP };
  }

  // Points de coupe des morceaux, placés sur un silence proche de chaque 10e minute.
  function chunkBounds(feat, duration) {
    const cuts = [0];
    for (let t = CHUNK; t < duration - 30; t += CHUNK) {
      const a = Math.floor((t - 8) / HOP), b = Math.floor((t + 8) / HOP);
      let best = Math.floor(t / HOP);
      for (let k = Math.max(0, a); k <= Math.min(feat.e.length - 1, b); k++) if (feat.e[k] < feat.e[best]) best = k;
      cuts.push(best * HOP);
    }
    cuts.push(duration);
    const out = [];
    for (let i = 0; i < cuts.length - 1; i++) out.push([cuts[i], cuts[i + 1]]);
    return out;
  }

  function wavBlob(pcm, from, to) {
    const a = Math.floor(from * SR), b = Math.min(pcm.length, Math.floor(to * SR)), n = Math.max(0, b - a);
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const W = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    W(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); W(8, 'WAVE'); W(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true);
    v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); W(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = clamp(pcm[a + i], -1, 1); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ---------- Appels API avec patience en cas de saturation ---------- */

  async function withRetry(fn, onWait, signal) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (signal && signal.aborted) throw e;
        const retryable = e.code === 'LIMITE_GROQ' || e.code === 'RESEAU' || (e.status >= 500 && e.code !== 'API_NON_CONFIGUREE');
        if (!retryable || attempt >= 5) throw e;
        const s = clamp(e.retryAfter || 6 * (attempt + 1), 3, 90);
        if (onWait) onWait(s);
        await sleep(s * 1000);
      }
    }
  }

  async function transcribe(projectId, pcm, bounds, language, onProgress, signal) {
    const words = [], segments = [];
    let lang = null;
    for (let i = 0; i < bounds.length; i++) {
      if (signal && signal.aborted) throw new DOMException('Annulé', 'AbortError');
      const [from, to] = bounds[i];
      onProgress(i, bounds.length, null);
      const blob = wavBlob(pcm, from, to);
      const res = await withRetry(() => {
        const fd = new FormData();
        fd.append('file', blob, 'morceau-' + (i + 1) + '.wav');
        fd.append('model', (window.CM_CONFIG && window.CM_CONFIG.STT_MODEL) || 'whisper-large-v3-turbo');
        fd.append('response_format', 'verbose_json');
        fd.append('timestamp_granularities[]', 'word');
        fd.append('timestamp_granularities[]', 'segment');
        fd.append('temperature', '0');
        if (language) fd.append('language', language);
        return CM.api('/transcribe?project=' + encodeURIComponent(projectId), { form: fd, signal });
      }, (s) => onProgress(i, bounds.length, s), signal);
      lang = lang || res.language;
      (res.words || []).forEach((w) => words.push([w[0], +(w[1] + from).toFixed(2), +(w[2] + from).toFixed(2)]));
      (res.segments || []).forEach((s) => segments.push([+(s[0] + from).toFixed(2), +(s[1] + from).toFixed(2), s[2]]));
    }
    onProgress(bounds.length, bounds.length, null);
    return { language: lang, words, segments };
  }

  /* ---------- Choix des moments ---------- */

  // Durée finale des clips, une fois les silences et les « euh » retirés.
  const LENGTHS = { auto: [45, 90], moyen: [45, 60], long: [60, 90] };

  // Un clip de 45 s à 1 min 30 pour environ 3 minutes de vidéo.
  function autoCount(duration) { return clamp(Math.round(duration / 180), 1, 10); }

  // Découpe la transcription en fenêtres d'environ 7 min pour rester sous les quotas gratuits de l'IA.
  function windows(segments) {
    const out = []; let cur = [];
    for (const s of segments) {
      cur.push(s);
      if (cur[cur.length - 1][1] - cur[0][0] >= 420) { out.push(cur); cur = cur.slice(-3); }
    }
    if (cur.length && (!out.length || cur[cur.length - 1][1] - cur[0][0] > 40)) out.push(cur);
    return out;
  }

  function overlap(a, b) { return a.start < b.end && b.start < a.end; }

  async function aiMoments(projectId, tr, opts, onProgress, signal) {
    const [lo, hi] = LENGTHS[opts.length] || LENGTHS.auto;
    // L'IA mesure la durée avant le retrait des silences : on lui demande un peu plus long.
    const min = lo + 5, max = hi + 8;
    const wins = windows(tr.segments);
    const per = clamp(Math.ceil((opts.count * 1.5) / Math.max(1, wins.length)), 1, 4);
    let all = [], failures = 0;
    for (let i = 0; i < wins.length; i++) {
      if (signal && signal.aborted) throw new DOMException('Annulé', 'AbortError');
      onProgress(i, wins.length, null);
      try {
        const r = await withRetry(() => CM.api('/moments', { json: {
          project_id: projectId, segments: wins[i].map((s) => [s[0], s[1], s[2]]),
          min, max, count: per, language: tr.language || opts.language || '' }, signal }), (s) => onProgress(i, wins.length, s), signal);
        all = all.concat(r.clips || []);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failures++;
        if (e.code === 'NON_CONNECTE' || e.code === 'QUOTA_PROJET_DEPASSE') throw e;
      }
    }
    onProgress(wins.length, wins.length, null);
    all.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of all) if (!kept.some((k) => overlap(k, c))) kept.push(c);
    return { clips: kept.slice(0, opts.count), failed: failures === wins.length && wins.length > 0 };
  }

  // Secours sans IA : on choisit les passages les plus intenses du son.
  function energyMoments(feat, duration, opts) {
    const [min, max] = LENGTHS[opts.length] || LENGTHS.auto;
    const D = (min + max) / 2, f = feat.f, es = feat.es, n = f.length, w = Math.max(1, Math.round(D / HOP));
    if (w >= n - 1) return [{ start: 0, end: duration, segments: [[0, duration]], score: 50, title: '', context: '', hook: '', reason: 'Vidéo entière.' }];
    const P = new Float64Array(n + 1); for (let i = 0; i < n; i++) P[i + 1] = P[i] + f[i];
    const m = n - w + 1, sc = new Float32Array(m);
    for (let s = 0; s < m; s++) sc[s] = (P[s + w] - P[s]) / w;
    const idx = Array.from({ length: m }, (_, i) => i).sort((a, b) => sc[b] - sc[a]);
    const gap = Math.round(2 / HOP), chosen = [];
    for (const s of idx) {
      const e = s + w;
      if (chosen.every((c) => e + gap <= c.s || s >= c.e + gap)) { chosen.push({ s, e, v: sc[s] }); if (chosen.length >= opts.count) break; }
    }
    return chosen.map((c) => { const st = c.s * HOP, en = Math.min(duration, c.e * HOP); return { start: st, end: en, segments: [[st, en]], score: Math.round(clamp(c.v * 100, 1, 99)),
      title: '', context: '', hook: '', reason: 'Passage choisi d\'après l\'intensité du son.' }; });
  }

  /* ---------- Finition : clips complets, de la bonne durée, qui finissent sur une fin de phrase ---------- */

  const END_PUNCT = /[.!?…]["»”']?$/;
  // Instants où une phrase se termine : ponctuation finale (mots ou segments de la transcription) ou vraie pause.
  function sentenceEnds(tr) {
    const words = tr.words || [], ends = [];
    (tr.segments || []).forEach((g) => { if (END_PUNCT.test(String(g[2] || '').trim())) ends.push(+g[1]); });
    words.forEach((w, i) => {
      if (END_PUNCT.test(String(w[0]).trim())) ends.push(+w[2]);
      if (i + 1 < words.length && words[i + 1][1] - w[2] >= 0.9) ends.push(+w[2]);
    });
    if (words.length) ends.push(+words[words.length - 1][2]);
    // On recale chaque fin sur la fin du mot le plus proche.
    const snapped = ends.map((t) => { let best = t, d = 1e9; for (const w of words) { const x = Math.abs(w[2] - t); if (x < d) { d = x; best = w[2]; } if (w[1] > t + 1) break; } return d <= 0.6 ? best : t; });
    return Array.from(new Set(snapped.map((t) => +t.toFixed(2)))).sort((a, b) => a - b);
  }
  const editedLen = (segs, words) => piecesDuration(computePieces(segs.map(([a, b]) => ({ s: a, e: b, on: true })), words, { cutSilence: true, cutFillers: true }));
  const hits = (a, b, taken) => taken.some(([x, y]) => a < y - 0.05 && b > x + 0.05);

  function finishClip(clip, tr, range, duration, taken) {
    const words = tr.words || [], ends = clip._ends;
    const [min, max] = range;
    let segs = (Array.isArray(clip.segments) && clip.segments.length ? clip.segments : [[clip.start, clip.end]])
      .map(([a, b]) => [Math.max(0, +a), Math.min(duration, +b)]).filter(([a, b]) => b - a >= 0.5);
    if (!segs.length) return null;
    const last = () => segs[segs.length - 1], first = () => segs[0];
    const nextEnd = (t) => ends.find((e) => e > t + 0.25);
    const prevEnd = (t) => { let r = null; for (const e of ends) { if (e < t - 0.25) r = e; else break; } return r; };
    const startAfter = (t) => { const w = words.find((x) => x[1] >= t - 0.01); return w ? w[1] : t; };

    // 1 et 2. Chaque morceau commence au début d'une phrase et finit à la fin d'une phrase
    // (raccord propre entre les morceaux, et dernière phrase jamais coupée).
    segs.forEach((g, i) => {
      const lo = i > 0 ? segs[i - 1][1] : -1, hi = i + 1 < segs.length ? segs[i + 1][0] : duration + 1;
      const isLast = i === segs.length - 1;
      if (!ends.some((e) => Math.abs(e - g[1]) <= 0.35)) {
        const before = ends.filter((e) => e <= g[1]).pop();
        const silentTail = before != null && before > g[0] + 1 && !words.some((w) => w[1] > before && w[1] < g[1]);
        const e = nextEnd(g[1] - 0.3);
        if (silentTail) g[1] = before; // après la phrase il n'y a que du silence : on s'arrête sur elle
        else if (e != null && e - g[1] <= (isLast ? 12 : 8) && e < hi - 0.1 && !hits(g[1], e, taken)) g[1] = e;
        else if (!isLast && before != null && before > g[0] + 1.5) g[1] = before; // sinon on recule à la phrase précédente
      }
      const p = prevEnd(g[0] + 0.3);
      if (p != null) { const st = startAfter(p); if (st < g[0] && g[0] - st <= 4 && st > lo + 0.05 && !hits(st, g[0], taken)) g[0] = st; }
    });
    segs = segs.filter(([a, b]) => b - a >= 0.8);
    if (!segs.length) return null;

    // 3. Trop court : on ajoute des phrases entières à la fin, puis au début.
    let len = editedLen(segs, words), guard = 0;
    while (len < min && guard++ < 40) {
      const e = nextEnd(last()[1]);
      if (e == null || e > duration + 0.01 || hits(last()[1], e, taken) || (len + (e - last()[1]) > max + 12)) break;
      last()[1] = e; len = editedLen(segs, words);
    }
    guard = 0;
    while (len < min && guard++ < 40) {
      // La phrase précédente commence juste après la fin de l'avant-dernière.
      const pe = prevEnd(first()[0]), pe2 = pe == null ? null : prevEnd(pe);
      const st = pe == null ? first()[0] : pe2 == null ? (words.length ? words[0][1] : 0) : startAfter(pe2);
      if (st >= first()[0] - 0.2 || hits(st, first()[0], taken)) break;
      first()[0] = st; len = editedLen(segs, words);
    }
    // 4. Trop long : on raccourcit la fin, toujours sur une fin de phrase.
    guard = 0;
    while (len > max + 3 && guard++ < 40) {
      const cands = ends.filter((e) => e < last()[1] - 0.25 && e > last()[0] + 2);
      if (!cands.length) {
        if (segs.length > 1) { segs.pop(); len = editedLen(segs, words); continue; }
        break;
      }
      last()[1] = cands[cands.length - 1]; len = editedLen(segs, words);
    }
    clip.segments = segs.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]);
    clip.start = clip.segments[0][0]; clip.end = Math.max(...clip.segments.map((g) => g[1]));
    clip._len = len;
    return clip;
  }

  // Finit tous les clips (le meilleur score d'abord) sans qu'ils se marchent dessus. Garde ceux d'au moins 30 s si possible.
  function finishClips(clips, tr, length, duration) {
    const range = LENGTHS[length] || LENGTHS.auto;
    const ends = sentenceEnds(tr);
    const taken = [], out = [];
    if (duration <= range[0] + 5) {
      const c = Object.assign({}, clips[0] || { score: 50, title: '', context: '', hook: '', reason: 'Vidéo entière.' });
      c.segments = [[0, duration]]; c.start = 0; c.end = duration; return [c];
    }
    clips.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).forEach((c0) => {
      const c = Object.assign({}, c0, { _ends: ends });
      const segs = (c.segments && c.segments.length ? c.segments : [[c.start, c.end]]);
      if (segs.some(([a, b]) => hits(a, b, taken))) return;
      const f = finishClip(c, tr, range, duration, taken);
      delete c._ends;
      if (!f) return;
      f.segments.forEach((g) => taken.push(g));
      out.push(f);
    });
    const good = out.filter((c) => c._len >= Math.min(30, range[0]));
    return (good.length ? good : out).map((c) => { delete c._len; return c; });
  }

  // Cale le début et la fin d'un clip sur des mots entiers, avec une petite marge.
  function snapToWords(clip, words, duration) {
    if (!words || !words.length) return clip;
    let a = -1, b = -1;
    for (let i = 0; i < words.length; i++) { if (words[i][2] > clip.start - 0.05) { a = i; break; } }
    for (let i = words.length - 1; i >= 0; i--) { if (words[i][1] < clip.end + 0.05) { b = i; break; } }
    if (a < 0 || b < a) return clip;
    clip.start = Math.max(0, +(words[a][1] - 0.12).toFixed(2));
    clip.end = Math.min(duration, +(words[b][2] + 0.3).toFixed(2));
    return clip;
  }

  // Cale chaque morceau d'un clip sur des mots entiers.
  function snapSegments(segments, words, duration) {
    return segments.map(([s, e]) => { const x = snapToWords({ start: s, end: e }, words, duration); return [x.start, x.end]; })
      .filter(([s, e]) => e - s >= 0.8);
  }

  /* ---------- Montage : silences et hésitations retirés au mot près ---------- */
  const FILLER = /^(euh+|heu+|euhm+|hum+|hmm+|mmh*|uh+|um+|erm+|bah|ben|hein)[.,!?…]*$/i;
  function isFiller(w) { return FILLER.test(String(w).trim()); }

  function computePieces(parts, words, opt) {
    const out = [];
    for (const p of parts) {
      if (!p.on) continue;
      const ws = (words || []).filter((w) => w[2] > p.s + 0.02 && w[1] < p.e - 0.02);
      if ((!opt.cutSilence && !opt.cutFillers) || !ws.length) { out.push([p.s, p.e]); continue; }
      let cur = null; let first = true;
      for (const w of ws) {
        if (opt.cutFillers && isFiller(w[0])) { if (cur) { out.push(cur); cur = null; } continue; }
        const a = Math.max(p.s, w[1] - (first ? 0.12 : 0.08)), b = Math.min(p.e, w[2] + 0.12);
        first = false;
        if (!cur) cur = [a, b];
        else if (opt.cutSilence && a - cur[1] > 0.35) { out.push(cur); cur = [a, b]; }
        else cur[1] = Math.max(cur[1], b);
      }
      if (cur) { cur[1] = Math.min(p.e, cur[1] + 0.08); out.push(cur); }
    }
    const merged = [];
    for (const q of out) {
      const last = merged[merged.length - 1];
      if (last && q[0] >= last[0] && q[0] - last[1] < 0.06) last[1] = Math.max(last[1], q[1]);
      else if (q[1] - q[0] >= 0.2) merged.push([+q[0].toFixed(2), +q[1].toFixed(2)]);
    }
    return merged.length ? merged : parts.filter((p) => p.on).map((p) => [p.s, p.e]);
  }
  const piecesDuration = (P) => P.reduce((s, q) => s + (q[1] - q[0]), 0);

  window.CMEngine = { HOP, SR, decodeMono, energy, chunkBounds, wavBlob, transcribe, aiMoments, energyMoments, snapToWords, snapSegments, computePieces, piecesDuration, isFiller, autoCount, LENGTHS, windows, sentenceEnds, finishClips };
})();
