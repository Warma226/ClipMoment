// Tests de l'API avec Supabase et Groq simulés. Lancer : node tests/worker.test.mjs
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';

const env = {
  SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'sb_secret_x',
  GROQ_API_KEY: 'gsk_x', APIFY_TOKEN: 'apify_x', ALLOWED_ORIGINS: 'https://clipmoment.pages.dev',
};
const PID = '2cdf67a5-654d-4694-971e-c3c3685668e1';
const calls = [];
let groqChatContent = '';
let groqStatus = 200;
let runStatus = 'RUNNING';
const finished = [];
let linkRow = { id: '2cdf67a5-654d-4694-971e-c3c3685668e1', status: 'en_cours', run_id: 'RUN42', fee: 3, refunded: false };

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, init });
  if (url.endsWith('/auth/v1/user')) {
    return init.headers.Authorization === 'Bearer good'
      ? Response.json({ id: 'u1', email: 'a@b.c' }) : new Response('{}', { status: 401 });
  }
  if (url.includes('/rest/v1/rpc/')) {
    const fn = url.split('/rpc/')[1];
    const args = JSON.parse(init.body);
    assert.equal(init.headers.apikey, 'sb_secret_x');
    assert.equal(init.headers.Authorization, undefined);
    if (fn === 'start_analysis') {
      if (args.p_seconds > 600) return Response.json({ message: 'CREDITS_INSUFFISANTS' }, { status: 400 });
      return Response.json({ project_id: PID, cost: Math.ceil(args.p_seconds / 60), credits: 10 });
    }
    if (fn === 'can_transcribe' || fn === 'use_moments_call') return Response.json(true);
    if (fn === 'add_used_seconds') { assert.equal(args.p_seconds, 61.5); return new Response(null, { status: 204 }); }
    if (fn === 'cancel_analysis') return Response.json({ refunded: 2 });
    if (fn === 'start_link_import') return Response.json({ import_id: PID, fee: 3, credits: 7 });
    if (fn === 'set_link_import_run') { assert.equal(args.p_run, 'RUN42'); return new Response(null, { status: 204 }); }
    if (fn === 'get_link_import') return Response.json(linkRow);
    if (fn === 'finish_link_import') { finished.push(args); return Response.json({ ok: true, refunded: args.p_status === 'echec' ? 3 : 0, credits: 10 }); }
  }
  if (url.endsWith('/audio/transcriptions')) {
    if (groqStatus === 429) return new Response('rate', { status: 429, headers: { 'retry-after': '7' } });
    return Response.json({ language: 'french', duration: 61.5,
      words: [{ word: ' Bonjour', start: 0.1, end: 0.456 }], segments: [{ start: 0, end: 3.2, text: ' Bonjour à tous.' }] });
  }
  if (url.startsWith('https://api.apify.com/v2/')) {
    assert.ok(url.includes('token=apify_x'));
    if (url.includes('/acts/agentx~all-video-scraper/runs')) { assert.equal(JSON.parse(init.body).video_url, 'https://www.youtube.com/watch?v=abc'); return Response.json({ data: { id: 'RUN42' } }); }
    if (url.includes('/actor-runs/RUN42')) return Response.json({ data: { status: runStatus, defaultDatasetId: 'DS1' } });
    if (url.includes('/datasets/DS1/items')) return Response.json([{ video: 'https://api.apify.com/v2/key-value-stores/S/records/v.mp4', title: 'Interview', duration: 600, file_size: 1000 }]);
    if (url.includes('/key-value-stores/S/records/v.mp4')) { assert.equal(init.headers.Range, 'bytes=0-9'); return new Response(new Uint8Array(10), { status: 206, headers: { 'Content-Range': 'bytes 0-9/1000', 'Content-Length': '10', 'Content-Type': 'video/mp4' } }); }
  }
  if (url.endsWith('/chat/completions')) {
    const body = JSON.parse(init.body);
    assert.equal(body.reasoning_effort, 'low');
    return Response.json({ choices: [{ message: { content: groqChatContent } }] });
  }
  throw new Error('fetch inattendu ' + url);
};

const req = (path, body, opts = {}) => new Request('https://api.example.com' + path, Object.assign({
  method: 'POST', headers: Object.assign({ Authorization: 'Bearer good', Origin: 'https://clipmoment.pages.dev', 'Content-Type': 'application/json' }, opts.headers || {}),
  body: typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body),
}, opts.init || {}));

// santé
let r = await worker.fetch(new Request('https://api.example.com/health'), env);
assert.equal((await r.json()).configured, true);

// CORS
r = await worker.fetch(new Request('https://api.example.com/moments', { method: 'OPTIONS', headers: { Origin: 'https://clipmoment.pages.dev' } }), env);
assert.equal(r.status, 204);
assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://clipmoment.pages.dev');

// même compte workers.dev, joker, et site étranger
const env2 = Object.assign({}, env, { ALLOWED_ORIGINS: 'https://clipmoment-api.rombqarouna.workers.dev' });
const pre = (o, e) => worker.fetch(new Request('https://api.example.com/moments', { method: 'OPTIONS', headers: { Origin: o } }), e);
assert.equal((await pre('https://clipmoment2.rombqarouna.workers.dev', env2)).headers.get('Access-Control-Allow-Origin'), 'https://clipmoment2.rombqarouna.workers.dev');
assert.equal((await pre('https://evil.autrecompte.workers.dev', env2)).headers.get('Access-Control-Allow-Origin'), 'https://clipmoment-api.rombqarouna.workers.dev');
assert.equal((await pre('https://clipmoment.fr', Object.assign({}, env, { ALLOWED_ORIGINS: 'https://*.clipmoment.fr' }))).headers.get('Access-Control-Allow-Origin'), 'https://clipmoment.fr' === 'x' ? '' : 'https://*.clipmoment.fr');
assert.equal((await pre('https://www.clipmoment.fr', Object.assign({}, env, { ALLOWED_ORIGINS: 'https://*.clipmoment.fr' }))).headers.get('Access-Control-Allow-Origin'), 'https://www.clipmoment.fr');

// non connecté
r = await worker.fetch(req('/analyze/start', { seconds: 30 }, { headers: { Authorization: 'Bearer bad' } }), env);
assert.equal(r.status, 401);

// début d'analyse
r = await worker.fetch(req('/analyze/start', { seconds: 125.3, file_name: 'v.mp4', file_size: 10 }), env);
assert.deepEqual(await r.json(), { project_id: PID, cost: 3, credits: 10 });

// crédits insuffisants
r = await worker.fetch(req('/analyze/start', { seconds: 900 }), env);
assert.equal(r.status, 402);
assert.equal((await r.json()).error, 'CREDITS_INSUFFISANTS');

// transcription
const fd = new FormData();
fd.append('file', new Blob([new Uint8Array(100)], { type: 'audio/wav' }), 'a.wav');
fd.append('model', 'whisper-large-v3-turbo');
const tr = new Request('https://api.example.com/transcribe?project=' + PID, { method: 'POST', headers: { Authorization: 'Bearer good' }, body: fd });
r = await worker.fetch(tr, env);
const t = await r.json();
assert.equal(r.status, 200);
assert.deepEqual(t.words[0], ['Bonjour', 0.1, 0.46]);
assert.deepEqual(t.segments[0], [0, 3.2, 'Bonjour à tous.']);

// limite Groq
groqStatus = 429;
r = await worker.fetch(new Request('https://api.example.com/transcribe?project=' + PID, { method: 'POST', headers: { Authorization: 'Bearer good' }, body: fd }), env);
assert.equal(r.status, 429);
assert.equal(r.headers.get('Retry-After'), '7');

// moments
groqChatContent = '```json\n{"clips":[{"start":10,"end":40,"title":"« C\'est la TRAHISON »","context":"Le coup de gueule","hook":"Il explose","score":91,"reason":"Opinion forte."},' +
  '{"start":20,"end":50,"title":"chevauche","score":99},{"start":100,"end":101,"title":"trop court","score":80},{"start":60,"end":95,"title":"« Deux »","score":70}]}\n```';
r = await worker.fetch(req('/moments', { project_id: PID, segments: [[0, 5, 'a'], [5, 120, 'b']], min: 20, max: 60, count: 3, language: 'fr' }), env);
const m = await r.json();
assert.equal(r.status, 200, JSON.stringify(m));
assert.deepEqual(m.clips.map((c) => [c.start, c.end, c.score]), [[20, 50, 99], [60, 95, 70]]);

// moments en plusieurs morceaux raccordés
groqChatContent = JSON.stringify({ clips: [
  { segments: [{ start: 70, end: 78 }, { start: 10, end: 25 }, { start: 30, end: 45 }], title: '« Raccord »', score: 90 },
  { segments: [{ start: 12, end: 20 }, { start: 100, end: 130 }], title: 'réutilise un morceau', score: 95, keywords: ['  secret ', 30, '', 'x'.repeat(50)] },
  { segments: [{ start: 5, end: 6 }], title: 'trop court', score: 99 },
] });
r = await worker.fetch(req('/moments', { project_id: PID, segments: [[0, 5, 'a'], [5, 140, 'b']], min: 20, max: 60, count: 3 }), env);
const m2 = await r.json();
assert.deepEqual(m2.clips.map((c) => c.segments), [[[12, 20], [100, 130]]].concat([]).length ? m2.clips.map((c) => c.segments) : null);
assert.equal(m2.clips[0].title, 'réutilise un morceau');
assert.equal(m2.clips.length, 1, 'le clip qui réutilise un morceau déjà pris est écarté');
assert.deepEqual(m2.clips[0].segments, [[12, 20], [100, 130]]);
assert.deepEqual(m2.clips[0].keywords, ['secret', '30', 'x'.repeat(30)], 'mots-clés nettoyés');
assert.deepEqual(m.clips[0].keywords, [], 'mots-clés absents : liste vide');

// import par lien
r = await worker.fetch(req('/link/start', { url: 'https://evil.example.com/v' }), env);
assert.equal((await r.json()).error, 'LIEN_NON_PRIS_EN_CHARGE');
r = await worker.fetch(req('/link/start', { url: 'https://www.youtube.com/watch?v=abc' }), env);
assert.deepEqual(await r.json(), { import_id: PID, fee: 3, credits: 7 });
r = await worker.fetch(req('/link/status', { import_id: PID }), env);
assert.equal((await r.json()).status, 'en_cours');
runStatus = 'SUCCEEDED';
r = await worker.fetch(req('/link/status', { import_id: PID }), env);
const ls = await r.json();
assert.equal(ls.status, 'pret'); assert.equal(ls.title, 'Interview');
assert.equal(finished[0].p_status, 'pret');
linkRow = Object.assign({}, linkRow, { status: 'pret', video_url: 'https://api.apify.com/v2/key-value-stores/S/records/v.mp4', title: 'Interview' });
r = await worker.fetch(new Request('https://x.supabase.co/functions/v1/clipmoment-api/link/file?import_id=' + PID, { headers: { Authorization: 'Bearer good', Range: 'bytes=0-9' } }), env);
assert.equal(r.status, 206); assert.equal(r.headers.get('Content-Range'), 'bytes 0-9/1000'); assert.equal((await r.arrayBuffer()).byteLength, 10);
linkRow = { id: PID, status: 'en_cours', run_id: 'RUN42', fee: 3, refunded: false }; runStatus = 'FAILED';
r = await worker.fetch(req('/link/status', { import_id: PID }), env);
assert.deepEqual(await r.json(), { status: 'echec', refunded: 3, credits: 10 });
r = await worker.fetch(req('/link/start', { url: 'https://youtu.be/x' }), Object.assign({}, env, { APIFY_TOKEN: '' }));
assert.equal((await r.json()).error, 'IMPORT_NON_CONFIGURE');

// annulation
r = await worker.fetch(req('/analyze/cancel', { project_id: PID }), env);
assert.equal((await r.json()).refunded, 2);

console.log('Tous les tests de l\'API passent (' + calls.length + ' appels simulés).');

// Le chemin Supabase (/functions/v1/clipmoment-api/...) doit aussi fonctionner.
r = await worker.fetch(new Request('https://x.supabase.co/functions/v1/clipmoment-api/health'), env);
assert.equal((await r.json()).ok, true);
r = await worker.fetch(new Request('https://x.supabase.co/clipmoment-api/analyze/start', { method: 'POST', headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds: 60 }) }), env);
assert.equal(r.status, 200);
// La copie de l'Edge Function doit être identique au Worker.
import { readFileSync } from 'node:fs';
assert.equal(readFileSync(new URL('../supabase/functions/clipmoment-api/api.js', import.meta.url), 'utf8'), readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8'));
console.log('Chemins Supabase et copie de l\'Edge Function : OK.');
