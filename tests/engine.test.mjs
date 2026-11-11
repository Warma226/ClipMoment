// Tests de la finition des clips (web/assets/engine.js) sur une transcription synthétique. Lancer : node tests/engine.test.mjs
import fs from 'fs'; import assert from 'assert/strict';
const src = fs.readFileSync(new URL('../web/assets/engine.js', import.meta.url), 'utf8');
const window = {}; const CM = {};
new Function('window', 'CM', 'DOMException', src)(window, CM, class extends Error {});
const E = window.CMEngine;
// Transcription synthétique : phrases de 6 à 16 mots, 0,35 s par mot, pause de 0,5 s entre phrases, quelques « euh ».
let t = 0.5, words = [], segments = [], k = 0;
while (t < 600) {
  const n = 6 + (k * 7) % 11, s0 = t, txt = [];
  for (let i = 0; i < n; i++) {
    if (i === 3 && k % 3 === 0) { words.push(['euh', t, t + 0.3]); t += 0.4; }
    const w = 'mot' + k + '_' + i + (i === n - 1 ? '.' : '');
    words.push([w, +t.toFixed(2), +(t + 0.3).toFixed(2)]); txt.push(w); t += 0.35;
  }
  segments.push([+s0.toFixed(2), +(t - 0.05).toFixed(2), txt.join(' ')]); t += 0.5 + (k % 5 === 0 ? 1.2 : 0); k++;
}
const tr = { words, segments, language: 'fr' };
const dur = t;
const ends = E.sentenceEnds(tr);
const isEnd = (x) => ends.some((e) => Math.abs(e - x) < 0.01);
const len = (c) => E.piecesDuration(E.computePieces(c.segments.map(([a, b]) => ({ s: a, e: b, on: true })), words, { cutSilence: true, cutFillers: true }));
const mid = (x) => { const w = words.find((w) => w[1] > x); return w ? w[1] + 0.1 : x; };
const clips = [
  { score: 95, segments: [[mid(20), mid(33)]] },                       // 13 s, coupé en pleine phrase
  { score: 90, segments: [[mid(100), mid(120)], [mid(140), mid(165)]] }, // deux morceaux, 45 s brut
  { score: 85, segments: [[mid(200), mid(330)]] },                      // 130 s, trop long
  { score: 80, segments: [[mid(dur - 20), dur - 0.2]] },                // fin de vidéo, ne peut que reculer
  { score: 70, segments: [[mid(36), mid(50)]] },                        // collé au clip 1 : ne doit pas le chevaucher
];
const out = E.finishClips(clips, tr, 'auto', dur);

for (const c of out) {
  c.segments.forEach((g) => assert.ok(isEnd(g[1]), 'chaque morceau finit sur une fin de phrase'));
  assert.ok(len(c) >= 30, 'au moins 30 s');
  assert.ok(len(c) <= 93.5, 'pas plus de 1 min 33');
}
const all = out.flatMap((c) => c.segments).sort((a, b) => a[0] - b[0]);
for (let i = 1; i < all.length; i++) assert.ok(all[i][0] >= all[i - 1][1] - 0.05, 'pas de chevauchement');
assert.ok(out.filter((c) => len(c) >= 45).length >= 3, 'la plupart font 45 s ou plus');
// Vidéo très courte : un seul clip, la vidéo entière
const short = E.finishClips([{ score: 50, segments: [[2, 10]] }], tr, 'auto', 40);
assert.deepEqual(short[0].segments, [[0, 40]]);
console.log('Finition des clips (45 s – 1 min 30, fins de phrase, pas de chevauchement) : OK.');
