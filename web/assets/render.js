/* ClipMoment — rendu vertical 9:16 : gabarits, titres, sous-titres animés, cadrage sur le visage, export. */
(function () {
  'use strict';
  const W = 720, H = 1280;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const TEMPLATES = {
    citation: { label: 'Citation', note: 'Citation entre guillemets dans des bandes blanches, façon chaîne TV.', captions: false },
    dynamique: { label: 'Sous-titres animés', note: 'Gros sous-titres mot par mot, le mot prononcé en couleur.', captions: true },
    sobre: { label: 'Sobre', note: 'Sous-titres blancs discrets, phrase par phrase.', captions: true },
    punch: { label: 'Mots-clés', note: 'Le mot important en grand et en couleur, zoom à chaque coupe.', captions: true },
    podcast: { label: 'Podcast', note: 'Ouverture titre + plan large, puis plein écran sur la personne qui parle.', captions: true },
    tuto: { label: 'Tuto', note: 'Gros titre au début, consignes en majuscules avec un mot en couleur.', captions: true },
  };
  const KEY_TPL = { punch: 1, podcast: 1, tuto: 1 };

  const FONTS = {
    quote: '"Roboto Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif',
    bold: 'Montserrat, "Arial Black", Impact, sans-serif',
    body: 'Onest, "Instrument Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    serif: '"Playfair Display", Georgia, "Times New Roman", serif',
  };

  function defaultStyle(template) {
    return { template: template || 'citation', titleSec: template === 'citation' || !template ? 14 : template === 'podcast' ? 5 : 3,
      captions: !!(TEMPLATES[template || 'citation'] || {}).captions, capY: 0.7, frame: 'auto', manualX: 0.5, track: null, trackV: 2, edits: {},
      cutSilence: true, cutFillers: true,
      music: MUSIC_FOR[template || 'citation'] || 'douce', musicVol: 0.5, sfx: true, grade: 'aucun', gradeAmt: 0.7 };
  }
  const MUSIC_FOR = { citation: 'douce', dynamique: 'energique', sobre: 'douce', punch: 'energique', podcast: 'douce', tuto: 'energique' };

  /* ---------- Sous-titres : regroupement des mots ---------- */

  function buildGroups(words, start, end, mode) {
    const ws = (words || []).filter((w) => w[2] > start + 0.02 && w[1] < end - 0.02);
    const karaoke = mode === 'dynamique';
    const LIM = { dynamique: [3, 18], punch: [4, 26], tuto: [5, 30], podcast: [6, 34] }[mode] || [7, 38];
    const maxN = LIM[0], maxC = LIM[1], stop = karaoke || mode === 'punch' || mode === 'tuto' ? /[.!?…,;:]$/ : /[.!?…]$/;
    const out = []; let cur = [];
    const flush = () => { if (cur.length) { out.push({ words: cur, start: cur[0][1], end: cur[cur.length - 1][2] }); cur = []; } };
    for (const w of ws) {
      const prev = cur[cur.length - 1];
      const len = cur.reduce((s, x) => s + x[0].length + 1, 0);
      if (cur.length && (cur.length >= maxN || len + w[0].length > maxC || w[1] - prev[2] > 0.6)) flush();
      cur.push(w);
      if (stop.test(w[0])) flush();
    }
    flush();
    out.forEach((g, i) => { const nx = out[i + 1]; g.until = nx ? Math.min(nx.start, g.end + 0.8) : g.end + 0.6; g.key = g.start.toFixed(2); });
    return out;
  }

  /* ---------- Mots-clés : le mot à mettre en avant dans un groupe ---------- */

  const STOP = new Set(('le la les un une des de du d l à a au aux et ou mais donc or ni car que qu qui quoi dont où ce c cet cette ces mon ma mes ton ta tes son sa ses ' +
    'notre nos votre vos leur leurs je j tu il elle on nous vous ils elles me m te t se s lui y en ne n pas plus très bien tout tous toute toutes est était sont ' +
    'être avoir ai as ont fait faire dans sur sous avec sans pour par comme quand alors aussi même encore déjà si oui non là ça cela ceci voilà vraiment ' +
    'parce juste après avant chez entre vers peut veux veut dit dire the an and or but to of in on at for with is are was were be it this that you we they ' +
    'he she my your our their so just very really what when how do does did have has had not no yes him her them its euh hum ben bon').split(' '));
  const norm = (w) => String(w || '').toLowerCase().replace(/^[a-zà-ÿ]{1,2}['’]/i, '').replace(/[^\p{L}\p{N}$€%]/gu, '');
  function kwSet(clip) {
    const src = Array.isArray(clip.keywords) ? clip.keywords : [];
    const sig = src.join('|');
    if (clip._kwSig !== sig) { clip._kwSig = sig; clip._kw = new Set(src.flatMap((k) => String(k).split(/\s+/)).map(norm).filter((k) => k.length > 1)); }
    return clip._kw;
  }
  // Index du mot à mettre en avant : mot-clé donné par l'IA, sinon nombre, sinon mot long et porteur de sens.
  function keyIndex(texts, kw, force) {
    let best = -1, bs = 0;
    texts.forEach((t, i) => {
      const n = norm(t); if (!n) return;
      let sc = 0;
      if (kw && kw.has(n)) sc = 100 + n.length;
      else if (/\d/.test(n)) sc = 80;
      else if (!STOP.has(n) && n.length >= 5) sc = n.length;
      if (sc > bs) { bs = sc; best = i; }
    });
    if (best < 0 && force) texts.forEach((t, i) => { const n = norm(t); if (n && !STOP.has(n) && (best < 0 || n.length > norm(texts[best]).length)) best = i; });
    if (best < 0 && force && texts.length) best = texts.length - 1;
    return best;
  }

  // Instants (temps de la vidéo source) où un mot est mis en avant : sert aux « pops » du sound design.
  function keyTimes(clip, groups) {
    const t = clip.style && clip.style.template;
    if (!KEY_TPL[t] || !groups) return [];
    const kw = kwSet(clip);
    return groups.map((g) => {
      const i = keyIndex(g.words.map((w) => w[0]), kw, false);
      return i >= 0 && (kw.has(norm(g.words[i][0])) || /\d/.test(g.words[i][0]) || t === 'punch') ? g.words[i][1] : null;
    }).filter((x) => x != null);
  }

  /* ---------- Étalonnage : filtres de couleur appliqués à l'image ---------- */
  // f : filtre CSS du canvas (Chrome, Firefox, Safari récent) ; tint : couleur mélangée en « soft-light » (marche partout) ; vig : vignettage.
  const GRADES = {
    aucun: { label: 'Aucun' },
    cine: { label: 'Ciné', f: (k) => `contrast(${1 + 0.18 * k}) saturate(${1 + 0.12 * k})`, tint: [[0, 128, 128], 0.18], warm: [[255, 140, 60], 0.12], vig: 0.45 },
    chaud: { label: 'Chaud', f: (k) => `saturate(${1 + 0.15 * k}) sepia(${0.18 * k})`, tint: [[255, 150, 70], 0.2] },
    froid: { label: 'Froid', f: (k) => `saturate(${1 - 0.1 * k}) brightness(${1 + 0.03 * k})`, tint: [[70, 140, 255], 0.2] },
    vif: { label: 'Vif', f: (k) => `contrast(${1 + 0.12 * k}) saturate(${1 + 0.45 * k})` },
    doux: { label: 'Doux', f: (k) => `contrast(${1 - 0.12 * k}) brightness(${1 + 0.06 * k}) saturate(${1 - 0.15 * k})`, tint: [[255, 230, 210], 0.12] },
    nb: { label: 'Noir et blanc', f: (k) => `grayscale(${k}) contrast(${1 + 0.15 * k})`, gray: true },
    nuit: { label: 'Nuit', f: (k) => `brightness(${1 - 0.12 * k}) contrast(${1 + 0.15 * k}) saturate(${1 - 0.2 * k})`, tint: [[20, 60, 140], 0.25], vig: 0.6 },
  };
  const HAS_FILTER = (() => { try { const c = document.createElement('canvas').getContext('2d'); return c && 'filter' in c; } catch (e) { return false; } })();
  function gradeFilter(st) { const g = GRADES[st.grade]; return g && g.f && HAS_FILTER ? g.f(st.gradeAmt != null ? st.gradeAmt : 0.7) : 'none'; }
  function gradeLayers(ctx, st) {
    const g = GRADES[st.grade]; if (!g || st.grade === 'aucun') return;
    const k = st.gradeAmt != null ? st.gradeAmt : 0.7;
    ctx.save();
    if (g.gray && !HAS_FILTER) { ctx.globalCompositeOperation = 'saturation'; ctx.globalAlpha = k; ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, W, H); }
    [g.tint, g.warm].forEach((t) => { if (!t) return; ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = t[1] * k * 2; ctx.fillStyle = 'rgb(' + t[0].join(',') + ')'; ctx.fillRect(0, 0, W, H); });
    if (g.vig) {
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      const v = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.28, W / 2, H * 0.45, H * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,' + (g.vig * k).toFixed(2) + ')');
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  /* ---------- Habillage : cartes animées (chiffre, liste, mot, emoji, alerte) et images ---------- */
  const OV_TYPES = { chiffre: 'Chiffre', liste: 'Liste', mot: 'Mot fort', emoji: 'Emoji', alerte: 'Alerte', texte: 'Texte', image: 'Image' };
  const imgCache = new Map();
  function ovImage(o) {
    if (!o.img) return null;
    let im = imgCache.get(o.img);
    if (!im) { im = new Image(); im.decoding = 'async'; im.src = o.img; imgCache.set(o.img, im); if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value); }
    return im.complete && im.naturalWidth ? im : null;
  }
  const ovDur = (o) => o.d || (o.type === 'liste' ? 2.4 + 0.9 * (o.items || []).length : o.type === 'image' ? 3.5 : 3);
  function ovPhase(o, t) { const d = ovDur(o), r = t - o.t; if (r < 0 || r > d) return null; return { r, d, a: clamp(Math.min(r / 0.22, (d - r) / 0.28), 0, 1), p: clamp(r / 0.32, 0, 1) }; }
  const easeBack = (x) => { const c = 1.6; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  function fitFont(ctx, text, weight, size, family, maxW, min) {
    ctx.font = weight + ' ' + size + 'px ' + family;
    while (ctx.measureText(text).width > maxW && size > min) { size -= 2; ctx.font = weight + ' ' + size + 'px ' + family; }
    return size;
  }
  function cardShadow(ctx) { ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10; }
  const OV_Y = { haut: 0.24, centre: 0.42, bas: 0.6 };

  // Images en plein écran (plan de coupe) : dessinées juste après la vidéo, avant les sous-titres.
  function drawCutaways(ctx, clip, t, st) {
    (clip.overlays || []).forEach((o) => {
      if (o.type !== 'image' || o.pos !== 'plein') return;
      const ph = ovPhase(o, t); if (!ph) return;
      const im = ovImage(o); if (!im) return;
      ctx.save(); ctx.globalAlpha = ph.a;
      let s = Math.max(W / im.naturalWidth, H / im.naturalHeight) * (1.04 + 0.06 * (ph.r / ph.d)); // léger zoom lent
      const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
      ctx.filter = gradeFilter(st); ctx.drawImage(im, (W - dw) / 2, (H - dh) / 2, dw, dh); ctx.filter = 'none';
      ctx.restore();
    });
  }

  function drawOverlays(ctx, clip, t, brand) {
    const accent = brand.highlight && brand.highlight !== '#FFE600' ? brand.highlight : '#FF7A1A';
    (clip.overlays || []).forEach((o) => {
      if (o.type === 'image' && o.pos === 'plein') return;
      const ph = ovPhase(o, t); if (!ph) return;
      const cy = H * (OV_Y[o.pos] || OV_Y.centre), sc = 0.82 + 0.18 * easeBack(ph.p);
      ctx.save(); ctx.globalAlpha = ph.a; ctx.translate(W / 2, cy); ctx.scale(sc, sc); ctx.translate(-W / 2, -cy);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const title = String(o.title || '').trim(), text = String(o.text || '').trim();
      if (o.type === 'emoji') {
        const z = 1 + 0.08 * Math.sin(ph.r * 6);
        ctx.translate(W / 2, cy); ctx.rotate(Math.sin(ph.r * 4) * 0.08); ctx.scale(z, z);
        ctx.font = '170px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 24;
        ctx.fillText(o.emoji || text || '🔥', 0, 0);
        if (title) { ctx.font = '900 40px ' + FONTS.bold; ctx.fillStyle = '#fff'; ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(title.toUpperCase(), 0, 130); ctx.fillText(title.toUpperCase(), 0, 130); }
      } else if (o.type === 'mot') {
        const word = (text || title).toUpperCase();
        const size = fitFont(ctx, word, '900', 74, FONTS.bold, W * 0.74, 34);
        const tw = ctx.measureText(word).width, bw = tw + 64, bh = size * 1.5;
        ctx.translate(W / 2, cy); ctx.rotate(-0.045);
        cardShadow(ctx); ctx.fillStyle = accent; roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 18); ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.fillStyle = '#fff'; ctx.fillText(word, 0, 3);
      } else if (o.type === 'image') {
        const im = ovImage(o); if (im) {
          const maxW = W * 0.72, maxH = H * 0.34, s = Math.min(maxW / im.naturalWidth, maxH / im.naturalHeight);
          const dw = im.naturalWidth * s, dh = im.naturalHeight * s, b = 10;
          ctx.translate(W / 2, cy); ctx.rotate(-0.03);
          cardShadow(ctx); ctx.fillStyle = '#fff'; roundRect(ctx, -dw / 2 - b, -dh / 2 - b, dw + 2 * b, dh + 2 * b + (title ? 54 : 0), 18); ctx.fill();
          ctx.shadowColor = 'transparent'; ctx.save(); roundRect(ctx, -dw / 2, -dh / 2, dw, dh, 10); ctx.clip(); ctx.drawImage(im, -dw / 2, -dh / 2, dw, dh); ctx.restore();
          if (title) { fitFont(ctx, title, '800', 30, FONTS.body, dw, 18); ctx.fillStyle = '#111'; ctx.fillText(title, 0, dh / 2 + 28); }
        }
      } else if (o.type === 'liste') {
        const items = (o.items || []).filter(Boolean).slice(0, 4), cw = W * 0.84, rowH = 86, head = title ? 74 : 20;
        const ch = head + items.length * rowH + 16, x0 = (W - cw) / 2, y0 = cy - ch / 2;
        if (title) { ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 16; fitFont(ctx, title.toUpperCase(), '900', 46, FONTS.bold, cw, 28); ctx.fillStyle = '#FFC233'; ctx.fillText(title.toUpperCase(), W / 2, y0 + 26); ctx.restore(); }
        items.forEach((it, i) => {
          const ap = clamp((ph.r - 0.35 - i * 0.7) / 0.25, 0, 1); if (ap <= 0) return;
          const y = y0 + head + i * rowH, slide = (1 - ap) * 40;
          ctx.save(); ctx.globalAlpha = ph.a * ap; ctx.translate(slide, 0);
          cardShadow(ctx); ctx.fillStyle = '#fff'; roundRect(ctx, x0, y, cw, rowH - 14, 16); ctx.fill(); ctx.shadowColor = 'transparent';
          ctx.fillStyle = '#1B74E8'; ctx.beginPath(); ctx.arc(x0 + 40, y + (rowH - 14) / 2, 20, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = '800 22px ' + FONTS.body; ctx.fillText(String(i + 1), x0 + 40, y + (rowH - 14) / 2 + 1);
          ctx.textAlign = 'left'; ctx.fillStyle = '#111'; fitFont(ctx, it, '700', 28, FONTS.body, cw - 96, 18);
          ctx.fillText(it, x0 + 74, y + (rowH - 14) / 2 + 1); ctx.restore();
        });
      } else { // chiffre, alerte, texte : carte blanche (ou jaune pour l'alerte)
        const alert = o.type === 'alerte', big = o.type === 'chiffre';
        const cw = W * 0.8, pad = 30, x0 = (W - cw) / 2;
        let bigSize = 0, lines = [];
        if (big) bigSize = fitFont(ctx, text, '900', 104, FONTS.bold, cw - pad * 2, 40);
        ctx.font = '600 30px ' + FONTS.body;
        const bodyTxt = big ? '' : text;
        if (bodyTxt) lines = wrap(ctx, bodyTxt, cw - pad * 2 - (alert ? 70 : 0)).slice(0, 4);
        const ch = pad * 2 + (title ? 40 : 0) + (big ? bigSize * 1.05 : 0) + lines.length * 40;
        const y0 = cy - ch / 2;
        cardShadow(ctx); ctx.fillStyle = alert ? '#FFD43B' : '#fff'; roundRect(ctx, x0, y0, cw, ch, 24); ctx.fill(); ctx.shadowColor = 'transparent';
        if (!alert) { ctx.fillStyle = accent; roundRect(ctx, x0, y0 + 22, 8, ch - 44, 4); ctx.fill(); }
        let y = y0 + pad;
        ctx.textAlign = 'left';
        const tx = x0 + pad + (alert ? 70 : 6);
        if (alert) { ctx.font = '52px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; ctx.textAlign = 'center'; ctx.fillText(o.emoji || '⚠️', x0 + pad + 26, y0 + ch / 2); ctx.textAlign = 'left'; }
        if (title) { ctx.fillStyle = alert ? '#3A2A00' : '#5A6A80'; fitFont(ctx, title, '700', 28, FONTS.body, cw - pad * 2 - (alert ? 70 : 6), 18); ctx.fillText(title, tx, y + 18); y += 40; }
        if (big) {
          // Le chiffre « compte » jusqu'à sa valeur quand il est simple (ex. 48, 90 %).
          const m = /^(\D*?)(\d+)(\D*)$/.exec(text.replace(/\s/g, ''));
          const shown = m && +m[2] < 100000 ? m[1] + Math.round(+m[2] * easeBack(clamp(ph.r / 0.8, 0, 1)) / easeBack(1)) + m[3] : text;
          ctx.fillStyle = accent; ctx.font = '900 ' + bigSize + 'px ' + FONTS.bold; ctx.fillText(shown, tx, y + bigSize * 0.52); y += bigSize * 1.05;
        }
        ctx.fillStyle = alert ? '#2A1E00' : '#111'; ctx.font = (alert ? '800 ' : '600 ') + '30px ' + FONTS.body;
        lines.forEach((l) => { ctx.fillText(l, tx, y + 20); y += 40; });
      }
      ctx.restore();
    });
  }

  /* ---------- Dessin ---------- */

  const tiny = document.createElement('canvas'); tiny.width = 18; tiny.height = 32;
  const tctx = tiny.getContext('2d');

  function trackAt(track, t) {
    if (!track || !track.length) return 0.5;
    if (t <= track[0][0]) return track[0][1];
    for (let i = 1; i < track.length; i++) {
      if (t < track[i][0]) {
        const a = track[i - 1], b = track[i];
        if (Math.abs(b[1] - a[1]) > 0.2 || b[0] - a[0] > 1.5) return a[1]; // changement de plan ou raccord : pas de glissement
        return a[1] + (b[1] - a[1]) * ((t - a[0]) / (b[0] - a[0]));
      }
    }
    return track[track.length - 1][1];
  }

  function drawVideo(ctx, src, sw, sh, st, rel, zoom) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (!sw || !sh) return;
    const vertical = sh / sw >= 1.5;
    const mode = vertical && (st.frame === 'auto' || st.frame === 'manuel') ? 'cover' : st.frame;
    try {
      if (mode === 'flou' || mode === 'entier') {
        if (mode === 'flou') {
          const s = Math.max(18 / sw, 32 / sh);
          tctx.drawImage(src, (18 - sw * s) / 2, (32 - sh * s) / 2, sw * s, sh * s);
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(tiny, 0, 0, W, H);
          ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(0, 0, W, H);
        }
        const s = Math.min(W / sw, H / sh), dw = sw * s, dh = sh * s;
        ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
        return;
      }
      let s = H / sh; if (sw * s < W) s = W / sw;
      s *= zoom || 1;
      const dw = sw * s, dh = sh * s;
      const cx = mode === 'cover' ? 0.5 : st.frame === 'manuel' ? st.manualX : trackAt(st.track, rel);
      const x = clamp(W / 2 - cx * dw, W - dw, 0);
      // Avec un zoom, on garde le haut du cadre (le visage) à la même hauteur.
      const y = zoom && zoom !== 1 ? clamp(H * 0.38 - 0.38 * dh, H - dh, 0) : (H - dh) / 2;
      ctx.drawImage(src, x, y, dw, dh);
    } catch (e) { /* image pas encore prête */ }
  }

  function wrap(ctx, text, maxW) {
    const words = String(text || '').split(/\s+/).filter(Boolean), lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }

  function fadeAlpha(rel, sec, len) {
    if (!sec || sec >= len) return 1;
    if (rel > sec) return 0;
    return clamp((sec - rel) / 0.3, 0, 1);
  }

  // Gabarit « Citation » : bandes blanches alignées à gauche, texte noir condensé, ligne de contexte.
  function drawQuote(ctx, clip, st, rel, len) {
    const a = fadeAlpha(rel, st.titleSec, len);
    if (a <= 0 || !(clip.title || clip.context)) return;
    ctx.save(); ctx.globalAlpha = a; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const x0 = 52, padX = 13, maxW = W - x0 * 2 - padX * 2;
    let size = 46;
    ctx.font = '700 ' + size + 'px ' + FONTS.quote;
    let lines = wrap(ctx, clip.title, maxW);
    while (lines.length > 4 && size > 34) { size -= 3; ctx.font = '700 ' + size + 'px ' + FONTS.quote; lines = wrap(ctx, clip.title, maxW); }
    lines = lines.slice(0, 5);
    const lh = Math.round(size * 1.24), cs = 26, clh = 38;
    ctx.font = '400 ' + cs + 'px ' + FONTS.quote;
    const clines = clip.context ? wrap(ctx, clip.context, maxW).slice(0, 2) : [];
    const block = lines.length * lh + (clines.length ? 10 + clines.length * clh : 0);
    let y = Math.min(H * 0.655, H - 170 - block);
    ctx.font = '700 ' + size + 'px ' + FONTS.quote;
    for (const ln of lines) {
      const w = ctx.measureText(ln).width;
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x0, y, w + padX * 2, lh);
      ctx.fillStyle = '#0B0B0B'; ctx.fillText(ln, x0 + padX, y + lh / 2 + 1);
      y += lh;
    }
    if (clines.length) {
      y += 10; ctx.font = '400 ' + cs + 'px ' + FONTS.quote;
      for (const ln of clines) {
        const w = ctx.measureText(ln).width;
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x0, y, w + 20, clh);
        ctx.fillStyle = '#1A1A1A'; ctx.fillText(ln, x0 + 10, y + clh / 2 + 1);
        y += clh;
      }
    }
    ctx.restore();
  }

  // Accroche en haut de l'écran (gabarits animé et sobre).
  function drawHook(ctx, clip, st, rel, len) {
    const text = (clip.hook || clip.title || '').trim();
    const a = fadeAlpha(rel, st.titleSec, len);
    if (!text || a <= 0) return;
    ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let size = 42; ctx.font = '800 ' + size + 'px ' + FONTS.bold;
    let lines = wrap(ctx, text, W * 0.8);
    if (lines.length > 3) { size = 34; ctx.font = '800 ' + size + 'px ' + FONTS.bold; lines = wrap(ctx, text, W * 0.82).slice(0, 4); }
    const lh = size * 1.22, padX = 18, padY = 12;
    const bw = Math.max.apply(null, lines.map((l) => ctx.measureText(l).width)) + padX * 2, bh = lines.length * lh + padY * 2;
    const x = (W - bw) / 2, y = H * 0.1;
    ctx.fillStyle = '#FFFFFF'; roundRect(ctx, x, y, bw, bh, 14); ctx.fill();
    ctx.fillStyle = '#0B0B0B';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y + padY + lh * i + lh / 2 + 1));
    ctx.restore();
  }

  // Gros titre sans boîte (Mots-clés, Tuto) : mot-clé en couleur, apparition en zoom.
  function drawBigTitle(ctx, clip, st, rel, len, brand, tuto) {
    const text = String(clip.hook || clip.title || '').replace(/[«»"“”]/g, '').trim().toUpperCase();
    const a = fadeAlpha(rel, st.titleSec, len);
    if (!text || a <= 0) return;
    const words = text.split(/\s+/).slice(0, 7);
    const hl = brand.highlight || (tuto ? '#FF8A1F' : '#FFB21E');
    const ki = tuto ? -1 : keyIndex(words, kwSet(clip), true);
    const pop = clamp(rel / 0.25, 0, 1), sc = 1.18 - 0.18 * (1 - Math.pow(1 - pop, 3));
    ctx.save(); ctx.globalAlpha = a * pop; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let size = tuto ? 92 : 78;
    const font = (z) => '900 ' + z + 'px ' + FONTS.bold;
    ctx.font = font(size);
    let lines = wrap(ctx, words.join(' '), W * 0.86);
    while ((lines.length > 3 || lines.some((l) => ctx.measureText(l).width > W * 0.9)) && size > 44) { size -= 6; ctx.font = font(size); lines = wrap(ctx, words.join(' '), W * 0.86); }
    const lh = size * 1.05, y0 = H * (tuto ? 0.13 : 0.12);
    ctx.translate(W / 2, y0 + (lines.length * lh) / 2); ctx.scale(sc, sc); ctx.translate(-W / 2, -(y0 + (lines.length * lh) / 2));
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 3;
    let wi = 0;
    lines.forEach((l, r) => {
      const ws = l.split(' '), cy = y0 + lh * r + lh / 2;
      const sp = ctx.measureText(' ').width, tw = ws.reduce((t, w) => t + ctx.measureText(w).width, 0) + sp * (ws.length - 1);
      let x = (W - tw) / 2;
      ws.forEach((w) => {
        const ww = ctx.measureText(w).width;
        ctx.fillStyle = tuto ? (r === 0 ? hl : '#FFFFFF') : (wi === ki ? hl : '#FFFFFF');
        ctx.textAlign = 'left'; ctx.fillText(w, x, cy);
        x += ww + sp; wi++;
      });
    });
    ctx.restore();
  }

  // Podcast : pendant l'ouverture, plan large sur fond noir et titre entre guillemets au-dessus.
  function podcastIntro(st, rel, len, sw, sh) { return st.titleSec > 0 && rel < Math.min(st.titleSec, len) && sw && sh && sh / sw < 1.2; }
  function drawPodcastIntro(ctx, src, sw, sh, clip, st, rel, len) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const dw = W, dh = sw ? sh * (W / sw) : 0, y = H * 0.47 - dh / 2;
    try { ctx.drawImage(src, 0, y, dw, dh); } catch (e) { /* image pas encore prête */ }
    const text = String(clip.title || clip.hook || '').replace(/[«»"“”]/g, '').trim();
    if (!text) return;
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#FFFFFF';
    let size = 46; ctx.font = '700 ' + size + 'px ' + FONTS.body;
    // « § » colle les guillemets aux mots voisins pendant le retour à la ligne (pas de guillemet seul sur une ligne).
    const q = '«§' + text + '§»';
    let lines = wrap(ctx, q, W * 0.86);
    while (lines.length > 3 && size > 32) { size -= 4; ctx.font = '700 ' + size + 'px ' + FONTS.body; lines = wrap(ctx, q, W * 0.86); }
    lines = lines.slice(0, 4).map((l) => l.replace(/§/g, '\u202f'));
    const lh = size * 1.22, bottom = y - 34, top = Math.max(70, bottom - lines.length * lh);
    lines.forEach((l, i) => ctx.fillText(l, W / 2, top + lh * i + lh / 2));
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // Sous-titres avec un mot mis en avant : Mots-clés (petit italique + gros mot en couleur), Podcast (phrase + mot en gras), Tuto (majuscules + mot en couleur).
  function drawKeyCaptions(ctx, g, edited, st, tAbs, brand, y, kw) {
    const timed = edited == null;
    const toks = timed ? g.words.map((w) => ({ t: w[0], s: w[1] })) : edited.split(/\s+/).filter(Boolean).map((t) => ({ t, s: -1 }));
    if (!toks.length) return;
    const ki = keyIndex(toks.map((x) => x.t), kw, st.template === 'punch');
    const said = (i) => !timed || tAbs >= toks[i].s - 0.04;
    ctx.shadowColor = 'rgba(0,0,0,.75)';
    if (st.template === 'punch') {
      const hl = brand.highlight || '#FFB21E';
      const pre = toks.slice(0, ki).filter((x, i) => said(i)).map((x) => x.t).join(' ');
      const post = toks.slice(ki + 1).filter((x, i) => said(ki + 1 + i)).map((x) => x.t).join(' ');
      const key = toks[ki].t.replace(/[.,;:!?…]+$/, '').toUpperCase();
      const shown = said(ki);
      let ks = 104; ctx.font = '900 ' + ks + 'px ' + FONTS.bold;
      while (ctx.measureText(key).width > W * 0.88 && ks > 46) { ks -= 6; ctx.font = '900 ' + ks + 'px ' + FONTS.bold; }
      const small = 40, gap = 6;
      ctx.textAlign = 'center';
      ctx.font = 'italic 500 ' + small + 'px ' + FONTS.serif; ctx.shadowBlur = 14;
      const preL = pre ? wrap(ctx, pre, W * 0.8).slice(-2) : [], postL = post ? wrap(ctx, post, W * 0.8).slice(0, 1) : [];
      const total = preL.length * small * 1.15 + ks + postL.length * small * 1.15 + gap * 2;
      let cy = y - total / 2;
      ctx.fillStyle = '#FFFFFF';
      preL.forEach((l) => { ctx.fillText(l, W / 2, cy + small * 0.58); cy += small * 1.15; });
      cy += gap;
      if (shown) {
        const t0 = timed ? toks[ki].s : -1, p = timed ? clamp((tAbs - t0) / 0.16, 0, 1) : 1;
        ctx.save(); ctx.translate(W / 2, cy + ks / 2); const z = 1.25 - 0.25 * p; ctx.scale(z, z);
        ctx.globalAlpha = 0.25 + 0.75 * p;
        if (p < 1 && 'filter' in ctx) ctx.filter = 'blur(' + ((1 - p) * 6).toFixed(1) + 'px)';
        ctx.font = '900 ' + ks + 'px ' + FONTS.bold; ctx.shadowBlur = 22; ctx.shadowOffsetY = 4;
        ctx.fillStyle = hl; ctx.fillText(key, 0, 0); ctx.restore();
      }
      cy += ks + gap;
      ctx.font = 'italic 500 ' + small + 'px ' + FONTS.serif; ctx.fillStyle = '#FFFFFF';
      postL.forEach((l) => { ctx.fillText(l, W / 2, cy + small * 0.58); cy += small * 1.15; });
      return;
    }
    // Podcast et Tuto : une ligne riche, mot par mot, avec retour à la ligne.
    const tuto = st.template === 'tuto';
    const size = tuto ? 40 : 36;
    const fNorm = tuto ? '800 ' + size + 'px ' + FONTS.bold : '500 ' + size + 'px ' + FONTS.body;
    const fKey = tuto ? '900 ' + size + 'px ' + FONTS.bold : '800 ' + (size + 2) + 'px ' + FONTS.body;
    const txt = toks.map((x) => (tuto ? x.t.toUpperCase() : x.t));
    ctx.font = fNorm; const sp = ctx.measureText(' ').width;
    const widths = txt.map((t, i) => { ctx.font = i === ki ? fKey : fNorm; return ctx.measureText(t).width; });
    const rows = [[]], rw = [0], maxW = W * 0.84;
    widths.forEach((w, i) => { const r = rows.length - 1, need = rw[r] + (rows[r].length ? sp : 0) + w; if (need > maxW && rows[r].length) { rows.push([i]); rw.push(w); } else { rows[r].push(i); rw[r] = need; } });
    const lh = size * 1.32, top = y - (rows.length * lh) / 2;
    ctx.textAlign = 'left'; ctx.shadowBlur = tuto ? 10 : 12;
    rows.slice(0, 3).forEach((r, ri) => {
      let x = (W - rw[ri]) / 2; const cy = top + lh * ri + lh / 2;
      r.forEach((i) => {
        ctx.font = i === ki ? fKey : fNorm;
        if (tuto) { ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.strokeText(txt[i], x, cy); }
        ctx.fillStyle = i === ki && tuto ? (brand.highlight || '#FF8A1F') : '#FFFFFF';
        ctx.globalAlpha = said(i) || !tuto ? 1 : 0.55;
        ctx.fillText(txt[i], x, cy);
        x += widths[i] + sp;
      });
    });
    ctx.globalAlpha = 1;
  }

  function drawCaptions(ctx, groups, st, tAbs, brand, kw) {
    const g = groups.find((x) => tAbs >= x.start - 0.05 && tAbs < x.until);
    if (!g) return;
    const edited = st.edits && st.edits[g.key] != null ? String(st.edits[g.key]) : null;
    const y = st.capY * H;
    ctx.save(); ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    if (KEY_TPL[st.template]) { drawKeyCaptions(ctx, g, edited, st, tAbs, brand, y, kw); ctx.restore(); return; }
    if (st.template === 'dynamique') {
      const tokens = edited != null ? edited.split(/\s+/).filter(Boolean).map((w) => [w, -1, -1]) : g.words;
      let size = 60;
      const fontAt = (s) => '900 ' + s + 'px ' + FONTS.bold;
      ctx.font = fontAt(size);
      const txt = tokens.map((w) => w[0].toUpperCase());
      const sp = () => ctx.measureText(' ').width + size * 0.2;
      let lines = [[]], lw = [0];
      const maxW = W * 0.86;
      const layout = () => {
        lines = [[]]; lw = [0];
        txt.forEach((w, i) => {
          const ww = ctx.measureText(w).width, li = lines.length - 1;
          const need = lw[li] + (lines[li].length ? sp() : 0) + ww;
          if (need > maxW && lines[li].length) { lines.push([i]); lw.push(ww); } else { lines[li].push(i); lw[li] = need; }
        });
      };
      layout();
      while ((lines.length > 2 || Math.max.apply(null, lw) > maxW) && size > 34) { size -= 4; ctx.font = fontAt(size); layout(); }
      const lh = size * 1.18, top = y - (lines.length * lh) / 2;
      lines.forEach((li, r) => {
        let x = (W - lw[r]) / 2;
        const cy = top + lh * r + lh / 2;
        li.forEach((i) => {
          const w = tokens[i], word = txt[i], ww = ctx.measureText(word).width;
          const next = tokens[i + 1];
          const active = w[1] >= 0 && tAbs >= w[1] && tAbs < (next && next[1] >= 0 ? next[1] : w[2] + 0.4);
          ctx.save();
          ctx.translate(x + ww / 2, cy);
          if (active) ctx.scale(1.08, 1.08);
          ctx.textAlign = 'center';
          ctx.lineWidth = size * 0.2; ctx.strokeStyle = '#000'; ctx.strokeText(word, 0, 0);
          ctx.fillStyle = active ? (brand.highlight || '#FFE600') : '#FFFFFF'; ctx.fillText(word, 0, 0);
          ctx.restore();
          x += ww + sp();
        });
      });
    } else {
      const text = edited != null ? edited : g.words.map((w) => w[0]).join(' ');
      ctx.font = '600 40px ' + FONTS.body; ctx.textAlign = 'center';
      const lines = wrap(ctx, text, W * 0.84).slice(0, 3), lh = 52, top = y - (lines.length * lh) / 2;
      lines.forEach((l, i) => {
        const cy = top + lh * i + lh / 2;
        ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 12;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(l, W / 2, cy);
        ctx.shadowBlur = 0; ctx.fillStyle = '#FFFFFF'; ctx.fillText(l, W / 2, cy);
      });
    }
    ctx.restore();
  }

  const logoCache = { src: null, img: null };
  function logoImg(src) {
    if (!src) return null;
    if (logoCache.src !== src) { logoCache.src = src; logoCache.img = new Image(); logoCache.img.src = src; }
    return logoCache.img.complete && logoCache.img.naturalWidth ? logoCache.img : null;
  }

  function drawBrand(ctx, brand, prog) {
    const img = logoImg(brand.logo);
    if (img) {
      const size = clamp(Number(brand.logoSize) || 0.24, 0.08, 0.45);
      const s = Math.min(W * size / img.naturalWidth, H * 0.11 / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s, pos = brand.logoPos || 'hd', m = 44;
      const x = pos[1] === 'g' ? m : W - m - w;
      const y = pos[0] === 'b' ? H - 34 - h - (brand.progress ? 12 : 0) : 58;
      ctx.save(); ctx.globalAlpha = clamp(Number(brand.logoOpacity) || 1, 0.3, 1); ctx.drawImage(img, x, y, w, h); ctx.restore();
    }
    if (brand.handle && brand.handle.trim()) {
      // Si le logo est en bas, la signature se place du côté opposé pour ne pas le chevaucher.
      const lp = img && (brand.logoPos || 'hd')[0] === 'b' ? (brand.logoPos || 'hd')[1] : null;
      ctx.save(); ctx.font = '600 28px ' + FONTS.body; ctx.textBaseline = 'middle';
      ctx.textAlign = lp === 'g' ? 'right' : lp === 'd' ? 'left' : 'center';
      const hx = lp === 'g' ? W - 44 : lp === 'd' ? 44 : W / 2;
      ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 8; ctx.fillStyle = 'rgba(255,255,255,.88)';
      ctx.fillText(brand.handle.trim(), hx, H * 0.945); ctx.restore();
    }
    if (brand.progress) {
      ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(0, H - 10, W, 10);
      ctx.fillStyle = brand.highlight || '#FFE600'; ctx.fillRect(0, H - 10, W * clamp(prog, 0, 1), 10);
    }
  }

  // Mots-clés : zoom « punch » qui change à chaque coupe du montage (ou toutes les deux phrases s'il n'y a pas de coupe).
  const ZOOMS = [1, 1.14, 1.06, 1.18];
  function punchZoom(clip, groups, t) {
    const P = clip._pieces;
    let k = P && P.length > 1 ? P.findIndex((q) => t >= q[0] - 0.02 && t <= q[1] + 0.02) : -1;
    if (k < 0) k = groups ? Math.floor(groups.filter((g) => g.start <= t).length / 2) : 0;
    return ZOOMS[Math.max(0, k) % ZOOMS.length];
  }

  /** Dessine une image complète du clip.
   *  tAbs : temps dans la vidéo source (pour l'image, le cadrage et les sous-titres).
   *  relOut / lenOut : position et durée dans le clip monté (pour le titre et la barre de progression). */
  function draw(ctx, src, sw, sh, clip, groups, tAbs, brand, relOut, lenOut) {
    const st = clip.style;
    const len = Math.max(0.1, lenOut != null ? lenOut : clip.end - clip.start);
    const rel = clamp(relOut != null ? relOut : tAbs - clip.start, 0, len);
    const b = brand || {}, kw = kwSet(clip);
    ctx.save();
    const intro = st.template === 'podcast' && podcastIntro(st, rel, len, sw, sh);
    if (intro) drawPodcastIntro(ctx, src, sw, sh, clip, st, rel, len);
    else {
      ctx.filter = gradeFilter(st);
      drawVideo(ctx, src, sw, sh, st, tAbs, st.template === 'punch' ? punchZoom(clip, groups, tAbs) : 1);
      ctx.filter = 'none';
    }
    gradeLayers(ctx, st);
    drawCutaways(ctx, clip, tAbs, st);
    drawOverlays(ctx, clip, tAbs, b);
    if (st.captions && groups) drawCaptions(ctx, groups, st, tAbs, b, kw);
    if (st.template === 'citation') drawQuote(ctx, clip, st, rel, len);
    else if (st.template === 'punch' || st.template === 'tuto') drawBigTitle(ctx, clip, st, rel, len, b, st.template === 'tuto');
    else if (st.template !== 'podcast') drawHook(ctx, clip, st, rel, len);
    drawBrand(ctx, b, rel / len);
    ctx.restore();
  }

  /* ---------- Suivi du visage ---------- */

  const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';
  let detP = null;
  function detector() {
    if (detP) return detP;
    detP = (async () => {
      if ('FaceDetector' in window) {
        try {
          const fd = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
          const probe = document.createElement('canvas'); probe.width = probe.height = 8;
          await fd.detect(probe);
          return { kind: 'natif', detect: async (c) => (await fd.detect(c)).map((f) => f.boundingBox) };
        } catch (e) { /* non disponible */ }
      }
      try {
        let v = null;
        for (const u of [MP, MP + '/vision_bundle.mjs', MP + '/+esm']) { try { v = await import(u); if (v && v.FaceDetector) break; } catch (e) { v = null; } }
        if (!v || !v.FaceDetector) return null;
        const fs = await v.FilesetResolver.forVisionTasks(MP + '/wasm');
        const d = await v.FaceDetector.createFromOptions(fs, { baseOptions: { modelAssetPath: MP_MODEL, delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.45 });
        return { kind: 'mediapipe', detect: async (c) => d.detect(c).detections.map((x) => ({ x: x.boundingBox.originX, y: x.boundingBox.originY, width: x.boundingBox.width, height: x.boundingBox.height })) };
      } catch (e) { return null; }
    })();
    return detP;
  }

  function seek(v, t) {
    return new Promise((res) => {
      const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); res(); };
      const to = setTimeout(done, 3000);
      v.addEventListener('seeked', done);
      try { v.currentTime = t; } catch (e) { done(); }
    });
  }

  /** Analyse le cadrage d'un clip : position horizontale du visage principal toutes les 0,5 s,
   *  sur chaque morceau gardé au montage. Les temps du suivi sont ceux de la vidéo source. */
  async function analyzeFraming(url, clip, onProgress, signal, pieces) {
    const det = await detector();
    if (!det) return { track: null, detector: null };
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(v);
    try {
      await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(res, 8000); });
      const sw = v.videoWidth, sh = v.videoHeight;
      if (!sw || sh / sw >= 1.5) return { track: null, detector: det.kind };
      const c = document.createElement('canvas'); c.width = 384; c.height = Math.round(384 * sh / sw);
      const cx = c.getContext('2d', { willReadFrequently: true });
      const raw = [], step = 0.5;
      const P = (pieces && pieces.length ? pieces : [[clip.start, clip.end]]).slice().sort((a, b) => a[0] - b[0]);
      const times = [];
      for (const [a, b] of P) { for (let t = a; t <= b + 0.01; t += step) times.push(+t.toFixed(2)); }
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        if (signal && signal.aborted) throw new DOMException('Annulé', 'AbortError');
        await seek(v, t);
        cx.drawImage(v, 0, 0, c.width, c.height);
        let boxes = [];
        try { boxes = await det.detect(c); } catch (e) { boxes = []; }
        let best = null;
        for (const b of boxes) if (!best || b.width * b.height > best.width * best.height) best = b;
        raw.push([t, best ? (best.x + best.width / 2) / c.width : null]);
        if (onProgress) onProgress(Math.min(1, (i + 1) / times.length));
      }
      if (!raw.some((p) => p[1] != null)) return { track: null, detector: det.kind };
      for (let i = 0; i < raw.length; i++) if (raw[i][1] == null) {
        let j = i; while (j < raw.length && raw[j][1] == null) j++;
        const fill = j < raw.length ? raw[j][1] : raw[i - 1][1];
        for (let k = i; k < j; k++) raw[k][1] = fill;
      }
      const out = []; let cur = raw[0][1];
      for (const [t, x] of raw) {
        if (Math.abs(x - cur) > 0.22) cur = x;            // changement de plan : saut direct
        else if (Math.abs(x - cur) > 0.03) cur += (x - cur) * 0.35; // petit mouvement : glissement doux
        out.push([t, +cur.toFixed(3)]);
      }
      return { track: out, detector: det.kind };
    } finally { v.removeAttribute('src'); v.load(); v.remove(); }
  }

  /* ---------- Export ---------- */

  function pickMime() {
    const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (const t of types) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t; } catch (e) { /* ignore */ } }
    return '';
  }

  window.CMRender = { W, H, TEMPLATES, defaultStyle, buildGroups, draw, analyzeFraming, detector, pickMime, trackAt, keyIndex, keyTimes, GRADES, OV_TYPES, ovDur };
})();
