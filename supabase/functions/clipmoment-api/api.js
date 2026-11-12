/**
 * ClipMoment — API (Cloudflare Worker, fichier unique, aucune compilation).
 *
 * Ce même fichier tourne aussi comme Edge Function Supabase (voir supabase/functions/clipmoment-api).
 *
 * Rôle : garder les clés secrètes hors du navigateur, vérifier la session du client,
 * débiter ses crédits, puis relayer vers Groq (transcription Whisper + IA qui choisit les moments).
 *
 * Variables à définir dans Cloudflare → Worker → Settings → Variables and Secrets :
 *   SUPABASE_URL          https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY     clé "anon" ou "publishable" de Supabase
 *   SUPABASE_SERVICE_KEY  clé "service_role" ou "secret" de Supabase   (Secret)
 *   GROQ_API_KEY          clé API Groq                                 (Secret)
 *   ALLOWED_ORIGINS       adresse(s) du site, séparées par des virgules (ex. https://clipmoment.pages.dev)
 *   GROQ_STT_MODEL        facultatif, défaut : whisper-large-v3-turbo
 *   GROQ_LLM_MODEL        facultatif, défaut : openai/gpt-oss-120b
 *   APIFY_TOKEN           facultatif : active l'import par lien (YouTube, Facebook…) via Apify   (Secret)
 *   APIFY_ACTOR           facultatif, défaut : agentx~all-video-scraper
 */

const GROQ = 'https://api.groq.com/openai/v1';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    // Sur Supabase, l'adresse contient /functions/v1/clipmoment-api : on garde seulement la route.
    const path = url.pathname.replace(/^.*\/clipmoment-api(?=\/|$)/, '') || '/';
    try {
      if (path === '/health') {
        return json({ ok: true, stt: sttModel(env), llm: llmModel(env), configured: isConfigured(env) }, 200, cors);
      }
      if (!isConfigured(env)) return json({ error: 'API_NON_CONFIGUREE' }, 500, cors);
      if (request.method !== 'POST' && !(request.method === 'GET' && path === '/link/file')) return json({ error: 'METHODE' }, 405, cors);

      const user = await getUser(request, env);
      if (!user) return json({ error: 'NON_CONNECTE' }, 401, cors);

      switch (path) {
        case '/analyze/start': return await startAnalysis(request, env, user, cors);
        case '/analyze/cancel': return await cancelAnalysis(request, env, user, cors);
        case '/transcribe': return await transcribe(request, env, user, url, cors);
        case '/moments': return await moments(request, env, user, cors);
        case '/link/start': return await linkStart(request, env, user, cors);
        case '/link/status': return await linkStatus(request, env, user, cors);
        case '/link/file': return await linkFile(request, env, user, url, cors);
        default: return json({ error: 'INTROUVABLE' }, 404, cors);
      }
    } catch (err) {
      const code = err && err.code ? err.code : 'ERREUR_SERVEUR';
      const status = err && err.status ? err.status : 500;
      return json({ error: code, detail: err && err.detail ? String(err.detail).slice(0, 300) : undefined }, status, cors);
    }
  },
};

/* ---------------- Utilitaires ---------------- */

function isConfigured(env) {
  return !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_KEY && env.GROQ_API_KEY);
}
const sttModel = (env) => env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const llmModel = (env) => env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b';

// Une adresse autorisée sur *.workers.dev ou *.pages.dev autorise aussi les autres sites du même compte
// (ex. clipmoment-api.toncompte.workers.dev → clipmoment2.toncompte.workers.dev). « * » est accepté en début de nom.
function originAllowed(origin, allowed) {
  let o;
  try { o = new URL(origin); } catch (e) { return false; }
  if (o.protocol !== 'https:' && o.hostname !== 'localhost') return false;
  return allowed.some((a) => {
    if (a === origin) return true;
    let u;
    try { u = new URL(a.replace('://*.', '://wildcard.')); } catch (e) { return false; }
    const parts = u.hostname.split('.');
    if (a.includes('://*.')) return o.hostname.endsWith('.' + parts.slice(1).join('.'));
    if (/\.(workers|pages)\.dev$/.test(u.hostname) && parts.length >= 4) return o.hostname.endsWith('.' + parts.slice(-3).join('.'));
    return false;
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  let allow = '*';
  if (allowed.length) allow = originAllowed(origin, allowed) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
    'Access-Control-Expose-Headers': 'Retry-After, Content-Length, Content-Range, Accept-Ranges, X-File-Name',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}),
  });
}

function fail(code, status, detail) {
  const e = new Error(code);
  e.code = code; e.status = status || 400; e.detail = detail;
  return e;
}

function supaHeaders(key) {
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key; // anciennes clés JWT
  return h;
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u && u.id ? u : null;
}

async function rpc(env, fn, args) {
  const res = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: supaHeaders(env.SUPABASE_SERVICE_KEY),
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const msg = data && data.message ? data.message : 'ERREUR_BASE';
    const known = ['CREDITS_INSUFFISANTS', 'VIDEO_TROP_LONGUE', 'DUREE_INVALIDE', 'IMPORTS_EN_COURS'];
    throw fail(known.includes(msg) ? msg : 'ERREUR_BASE', known.includes(msg) ? 402 : 500, msg);
  }
  return data;
}

async function readJson(request) {
  try { return await request.json(); } catch (e) { throw fail('JSON_INVALIDE', 400); }
}

const isUuid = (s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);

/* ---------------- Analyse : début / annulation ---------------- */

async function startAnalysis(request, env, user, cors) {
  const b = await readJson(request);
  const seconds = Math.ceil(Number(b.seconds));
  if (!Number.isFinite(seconds) || seconds <= 0) throw fail('DUREE_INVALIDE', 400);
  const r = await rpc(env, 'start_analysis', {
    p_user: user.id,
    p_seconds: seconds,
    p_title: String(b.title || b.file_name || 'Vidéo').slice(0, 200),
    p_file_name: String(b.file_name || '').slice(0, 300),
    p_file_size: Math.max(0, Math.round(Number(b.file_size) || 0)),
  });
  return json(r, 200, cors);
}

async function cancelAnalysis(request, env, user, cors) {
  const b = await readJson(request);
  if (!isUuid(b.project_id)) throw fail('PROJET_INVALIDE', 400);
  const r = await rpc(env, 'cancel_analysis', { p_user: user.id, p_project: b.project_id });
  return json(r, 200, cors);
}

/* ---------------- Transcription (Groq Whisper) ---------------- */

async function transcribe(request, env, user, url, cors) {
  const project = url.searchParams.get('project');
  if (!isUuid(project)) throw fail('PROJET_INVALIDE', 400);
  const ok = await rpc(env, 'can_transcribe', { p_user: user.id, p_project: project });
  if (ok !== true) throw fail('QUOTA_PROJET_DEPASSE', 403);

  const ctype = request.headers.get('Content-Type') || '';
  if (!ctype.startsWith('multipart/form-data')) throw fail('FORMAT_INVALIDE', 400);

  // Le corps (audio + paramètres) est transmis tel quel à Groq, sans être relu : peu de calcul côté Worker.
  const res = await fetch(GROQ + '/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'Content-Type': ctype },
    body: request.body,
  });
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    const detail = await res.text();
    const h = Object.assign({}, cors);
    if (retry) h['Retry-After'] = retry;
    const code = res.status === 429 ? 'LIMITE_GROQ' : res.status === 413 ? 'AUDIO_TROP_LOURD' : 'ERREUR_TRANSCRIPTION';
    return json({ error: code, detail: detail.slice(0, 300) }, res.status === 429 ? 429 : 502, h);
  }
  const data = await res.json();
  const duration = Number(data.duration) || 0;
  await rpc(env, 'add_used_seconds', { p_project: project, p_seconds: duration });

  const r1 = (n) => Math.round(n * 100) / 100;
  return json({
    language: data.language || null,
    duration,
    words: (data.words || []).map((w) => [String(w.word).trim(), r1(w.start), r1(w.end)]),
    segments: (data.segments || []).map((s) => [r1(s.start), r1(s.end), String(s.text).trim()]),
  }, 200, cors);
}

/* ---------------- Moments viraux (Groq LLM) ---------------- */

const SYSTEM = `Tu es un monteur expert en vidéos courtes virales (TikTok, Reels, YouTube Shorts) pour des médias francophones.
On te donne un extrait de transcription horodatée d'une vidéo longue. Tu choisis les passages qui, découpés seuls, ont le plus de chances de devenir viraux.

Critères, par ordre d'importance :
1. Le passage se comprend seul, sans le reste de la vidéo, et forme une idée complète.
2. Il commence au début d'une phrase et accroche dès les 3 premières secondes.
3. Il contient une émotion forte, une opinion tranchée, un conflit, une révélation, une chute drôle, une phrase qu'on a envie de citer, ou un conseil concret.
4. Il se termine à la fin d'une phrase, idéalement sur une chute.

Chaque clip est une vraie mini-vidéo prête à publier, pas un simple extrait :
- une accroche forte dans les premières secondes ;
- le développement de l'idée, avec ce qu'il faut pour comprendre ;
- une conclusion nette : la chute, la réponse, la morale ou la phrase qui marque.
Ne termine JAMAIS au milieu d'une explication, d'une énumération, d'une histoire, ou sur une question sans réponse, ni sur une phrase qui annonce une suite (« et donc… », « deuxième chose… », « je vais vous dire… »). Si la conclusion arrive plus loin, va la chercher et retire le superflu au milieu.

Tu es aussi monteur : un clip peut raccorder plusieurs morceaux pris dans l'extrait.
- Garde uniquement ce qui sert l'histoire : l'accroche, l'explication essentielle, la chute.
- Retire les digressions, les répétitions, les phrases inachevées, les passages hors sujet et les échanges sans intérêt.
- Chaque morceau commence au début d'une phrase et finit à la fin d'une phrase, et dure au moins 2 secondes.
- Garde l'ordre chronologique, sauf si une phrase très forte mérite d'ouvrir le clip comme accroche : tu peux alors la placer en premier.
- La durée totale (somme des morceaux) respecte la durée demandée. Vise le milieu de la fourchette : un clip trop court n'est pas publiable.
- Le dernier morceau finit sur la fin de la phrase de conclusion.

Pour chaque clip, écris :
- "segments" : la liste des morceaux à enchaîner, dans l'ordre de lecture, chacun {"start": secondes, "end": secondes}.
- "title" : un titre-citation dans la langue de la vidéo, comme le post d'une chaîne de télé sur les réseaux. Reprends une phrase forte réellement prononcée, entre guillemets « », avec 1 ou 2 mots-clés en MAJUSCULES. 90 caractères maximum.
- "context" : une ligne de contexte courte (70 caractères maximum), par exemple « Le coup de gueule de … ». Ne cite un nom que s'il apparaît dans la transcription.
- "hook" : une accroche très courte de 3 à 6 mots pour le haut de l'écran.
- "keywords" : 3 à 8 mots réellement prononcés dans le clip, à mettre en avant dans les sous-titres (chiffres, montants, noms, mots forts ou émotionnels). Un ou deux mots chacun, tels qu'ils sont dits.
- "overlays" : l'habillage du clip, 2 à 5 cartes animées affichées au moment exact où l'idée est dite. Chacune : {"at": secondes, "type": …, "title": "", "text": "", "items": [], "emoji": ""}. Types :
  « chiffre » quand un nombre, un montant ou un pourcentage est prononcé (text = la valeur, ex. « 2 000 000 F » ; title = ce qu'elle représente, court) ;
  « liste » quand l'orateur énumère des conseils ou des étapes (title court, items = 2 à 4 points de 4 à 6 mots) ;
  « mot » pour une idée forte en 1 à 3 mots (text) ;
  « alerte » pour un avertissement ou un piège (title + text courts, emoji) ;
  « emoji » pour une émotion ou un objet facile à illustrer (emoji + title facultatif) ;
  « texte » pour une phrase à retenir (title + text de 12 mots au plus).
  Textes courts, dans la langue de la vidéo, fidèles à ce qui est dit. Espace les cartes d'au moins 5 secondes.
- "score" : de 0 à 100, ton estimation du potentiel viral.
- "reason" : une phrase en français qui explique pourquoi ce passage peut marcher.

Règles strictes :
- Les horodatages viennent de la transcription fournie.
- Deux clips différents ne réutilisent pas les mêmes morceaux.
- Réponds uniquement avec un objet JSON : {"clips":[{"segments":[{"start":0,"end":0}],"title":"","context":"","hook":"","keywords":[""],"overlays":[{"at":0,"type":"chiffre","title":"","text":"","items":[],"emoji":""}],"score":0,"reason":""}]}`;

async function moments(request, env, user, cors) {
  const b = await readJson(request);
  if (!isUuid(b.project_id)) throw fail('PROJET_INVALIDE', 400);
  const segs = Array.isArray(b.segments) ? b.segments.slice(0, 600) : [];
  if (!segs.length) throw fail('TRANSCRIPTION_VIDE', 400);
  const min = clampNum(b.min, 5, 180, 20), max = clampNum(b.max, min + 5, 240, 60);
  const count = clampNum(b.count, 1, 10, 3);

  const allowed = await rpc(env, 'use_moments_call', { p_user: user.id, p_project: b.project_id });
  if (allowed !== true) throw fail('QUOTA_PROJET_DEPASSE', 403);

  let lines = '', total = 0;
  for (const s of segs) {
    const line = '[' + Number(s[0]).toFixed(1) + '-' + Number(s[1]).toFixed(1) + '] ' + String(s[2] || '').slice(0, 400) + '\n';
    if (total + line.length > 14000) break;
    lines += line; total += line.length;
  }
  const first = Number(segs[0][0]) || 0, last = Number(segs[segs.length - 1][1]) || 0;
  const userMsg = `Langue de la vidéo : ${b.language || 'inconnue'}.
Propose jusqu'à ${count} clips, chacun d'une durée totale de ${min} à ${max} secondes.
Transcription (de ${first.toFixed(0)} s à ${last.toFixed(0)} s) :
${lines}`;

  const model = llmModel(env);
  const body = {
    model,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
    temperature: 0.4,
    max_completion_tokens: 4000,
    response_format: { type: 'json_object' },
  };
  if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';

  let res = await callGroqChat(env, body);
  if (res.status === 400) { // certains modèles refusent le mode JSON : on réessaie sans
    delete body.response_format;
    res = await callGroqChat(env, body);
  }
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    const detail = await res.text();
    const h = Object.assign({}, cors);
    if (retry) h['Retry-After'] = retry;
    return json({ error: res.status === 429 ? 'LIMITE_GROQ' : 'ERREUR_IA', detail: detail.slice(0, 300) }, res.status === 429 ? 429 : 502, h);
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || '' : '';
  const clips = parseClips(content, first, last, min, max).slice(0, count);
  return json({ clips, model }, 200, cors);
}

function callGroqChat(env, body) {
  return fetch(GROQ + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function clampNum(v, lo, hi, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

function parseClips(content, first, last, min, max) {
  const txt = String(content).replace(/```(json)?/g, '');
  const a = txt.indexOf('{'), z = txt.lastIndexOf('}');
  if (a < 0 || z <= a) return [];
  let obj;
  try { obj = JSON.parse(txt.slice(a, z + 1)); } catch (e) { return []; }
  const arr = Array.isArray(obj) ? obj : Array.isArray(obj.clips) ? obj.clips : [];
  const r1 = (n) => Math.round(n * 10) / 10;
  const valid = [];
  for (const c of arr) {
    let segs = Array.isArray(c.segments) && c.segments.length ? c.segments : [{ start: c.start, end: c.end }];
    segs = segs.map((g) => ({ start: Number(g.start), end: Number(g.end) }))
      .filter((g) => Number.isFinite(g.start) && Number.isFinite(g.end) && g.end - g.start >= 1 && g.start >= first - 3 && g.end <= last + 3);
    const kept = [];
    for (const g of segs) if (!kept.some((k) => g.start < k.end && g.end > k.start)) kept.push(g); // pas de morceaux qui se chevauchent
    if (!kept.length || kept.length > 12) continue;
    const total = kept.reduce((s2, g) => s2 + (g.end - g.start), 0);
    if (total < min * 0.7 || total > max * 1.4) continue; // le site rallonge ou raccourcit ensuite sur des phrases entières
    valid.push({ c, segs: kept, lo: Math.min(...kept.map((g) => g.start)), hi: Math.max(...kept.map((g) => g.end)), total });
  }
  valid.sort((x, y) => clampNum(y.c.score, 0, 100, 50) - clampNum(x.c.score, 0, 100, 50));
  const out = [];
  for (const v of valid) {
    const overlaps = out.some((o) => o.segments.some((g) => v.segs.some((h) => h.start < g[1] && h.end > g[0])));
    if (overlaps) continue; // on garde le meilleur score quand deux clips utilisent les mêmes morceaux
    const c = v.c;
    out.push({
      start: r1(v.lo),
      end: r1(v.hi),
      segments: v.segs.map((g) => [r1(g.start), r1(g.end)]),
      title: String(c.title || '').slice(0, 120),
      context: String(c.context || '').slice(0, 90),
      hook: String(c.hook || '').slice(0, 60),
      keywords: (Array.isArray(c.keywords) ? c.keywords : []).map((k) => String(k || '').trim().slice(0, 30)).filter(Boolean).slice(0, 10),
      overlays: parseOverlays(c.overlays, v.lo, v.hi),
      score: Math.round(clampNum(c.score, 0, 100, 50)),
      reason: String(c.reason || '').slice(0, 220),
    });
  }
  return out.sort((x, y) => y.score - x.score);
}

const OV_TYPES = ['chiffre', 'liste', 'mot', 'alerte', 'emoji', 'texte'];
function parseOverlays(list, lo, hi) {
  if (!Array.isArray(list)) return [];
  const s = (x, n) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
  return list.filter((o) => o && OV_TYPES.includes(o.type) && Number.isFinite(Number(o.at)) && Number(o.at) >= lo - 1 && Number(o.at) <= hi + 1)
    .slice(0, 6).map((o) => ({
      at: Math.round(Number(o.at) * 10) / 10, type: o.type, title: s(o.title, 40), text: s(o.text, o.type === 'texte' || o.type === 'alerte' ? 120 : 30),
      items: (Array.isArray(o.items) ? o.items : []).map((x) => s(x, 40)).filter(Boolean).slice(0, 4), emoji: Array.from(s(o.emoji, 16)).slice(0, 4).join(''),
    }))
    .filter((o) => o.type === 'emoji' ? !!o.emoji : o.type === 'liste' ? o.items.length >= 2 : !!(o.text || o.title));
}

/* ---------------- Import par lien (YouTube, Facebook…) via Apify ---------------- */

const APIFY = 'https://api.apify.com/v2';
const LINK_HOSTS = /(^|\.)(youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|vimeo\.com|dailymotion\.com)$/i;
const actor = (env) => env.APIFY_ACTOR || 'agentx~all-video-scraper';

function checkLink(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { throw fail('LIEN_INVALIDE', 400); }
  if (!/^https?:$/.test(u.protocol) || !LINK_HOSTS.test(u.hostname)) throw fail('LIEN_NON_PRIS_EN_CHARGE', 400);
  return u.toString();
}

async function apify(env, path, init) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(APIFY + path + sep + 'token=' + encodeURIComponent(env.APIFY_TOKEN), init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) throw fail('ERREUR_IMPORT', 502, typeof data === 'string' ? data : JSON.stringify(data));
  return data;
}

async function linkStart(request, env, user, cors) {
  if (!env.APIFY_TOKEN) throw fail('IMPORT_NON_CONFIGURE', 503);
  const b = await readJson(request);
  const link = checkLink(b.url);
  const quality = ['low', 'medium', 'high'].includes(b.quality) ? b.quality : 'medium';
  const st = await rpc(env, 'start_link_import', { p_user: user.id, p_url: link });
  try {
    const run = await apify(env, '/acts/' + actor(env) + '/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: link, video_quality: quality }),
    });
    await rpc(env, 'set_link_import_run', { p_id: st.import_id, p_run: run.data.id });
  } catch (e) {
    const r = await rpc(env, 'finish_link_import', { p_id: st.import_id, p_status: 'echec', p_video_url: null, p_title: null, p_duration: null, p_file_size: null });
    throw fail('ERREUR_IMPORT', 502, (e && e.detail) || String(e) + (r && r.refunded ? ' (crédits rendus)' : ''));
  }
  return json({ import_id: st.import_id, fee: st.fee, credits: st.credits }, 200, cors);
}

async function linkStatus(request, env, user, cors) {
  const b = await readJson(request);
  if (!isUuid(b.import_id)) throw fail('IMPORT_INVALIDE', 400);
  const li = await rpc(env, 'get_link_import', { p_user: user.id, p_id: b.import_id });
  if (!li || !li.id) throw fail('IMPORT_INVALIDE', 404);
  if (li.status !== 'en_cours') return json(publicImport(li), 200, cors);
  if (!li.run_id) return json({ status: 'en_cours' }, 200, cors);
  const run = (await apify(env, '/actor-runs/' + encodeURIComponent(li.run_id))).data;
  if (['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT'].includes(run.status)) {
    const r = await rpc(env, 'finish_link_import', { p_id: li.id, p_status: 'echec', p_video_url: null, p_title: null, p_duration: null, p_file_size: null });
    return json({ status: 'echec', refunded: r.refunded || 0, credits: r.credits }, 200, cors);
  }
  if (run.status !== 'SUCCEEDED') return json({ status: 'en_cours', step: run.status }, 200, cors);
  const items = await apify(env, '/datasets/' + run.defaultDatasetId + '/items?clean=1&limit=5');
  const it = (Array.isArray(items) ? items : []).find((x) => x && x.video) || null;
  if (!it) {
    const r = await rpc(env, 'finish_link_import', { p_id: li.id, p_status: 'echec', p_video_url: null, p_title: null, p_duration: null, p_file_size: null });
    return json({ status: 'echec', refunded: r.refunded || 0, credits: r.credits }, 200, cors);
  }
  await rpc(env, 'finish_link_import', { p_id: li.id, p_status: 'pret', p_video_url: String(it.video), p_title: String(it.title || 'Vidéo importée'),
    p_duration: Number(it.duration) || null, p_file_size: Number(it.file_size) || null });
  return json({ status: 'pret', title: String(it.title || 'Vidéo importée'), duration: Number(it.duration) || null, file_size: Number(it.file_size) || null }, 200, cors);
}

function publicImport(li) {
  return { status: li.status, title: li.title, duration: li.duration, file_size: li.file_size, refunded: li.refunded ? li.fee : 0 };
}

// Relaie le fichier vidéo vers le téléphone du client (par morceaux grâce à l'en-tête Range).
async function linkFile(request, env, user, url, cors) {
  const id = url.searchParams.get('import_id');
  if (!isUuid(id)) throw fail('IMPORT_INVALIDE', 400);
  const li = await rpc(env, 'get_link_import', { p_user: user.id, p_id: id });
  if (!li || li.status !== 'pret' || !li.video_url) throw fail('IMPORT_INVALIDE', 404);
  let src = li.video_url;
  if (/^https:\/\/api\.apify\.com\//.test(src) && env.APIFY_TOKEN) src += (src.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(env.APIFY_TOKEN);
  const headers = {};
  const range = request.headers.get('Range');
  if (range) headers.Range = range;
  const res = await fetch(src, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw fail('ERREUR_IMPORT', 502, 'Fichier indisponible (' + res.status + ')');
  const h = Object.assign({}, cors, { 'Content-Type': res.headers.get('Content-Type') || 'video/mp4', 'Cache-Control': 'no-store' });
  ['Content-Length', 'Content-Range', 'Accept-Ranges'].forEach((k) => { const v = res.headers.get(k); if (v) h[k] = v; });
  h['X-File-Name'] = encodeURIComponent(String(li.title || 'video').slice(0, 80));
  return new Response(res.body, { status: res.status, headers: h });
}
