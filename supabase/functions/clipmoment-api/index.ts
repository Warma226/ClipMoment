// ClipMoment — API déployée comme Edge Function Supabase.
// Supabase fournit lui-même l'adresse et les clés du projet ; il ne reste qu'à ajouter
// le secret GROQ_API_KEY (Edge Functions → Secrets). ALLOWED_ORIGINS est facultatif.
// api.js est une copie exacte de worker/worker.js (le test le vérifie).
import api from './api.js';

function keyFromJson(name: string, pick: string): string | undefined {
  try { const o = JSON.parse(Deno.env.get(name) || '{}'); return o[pick] || Object.values(o)[0] as string; } catch { return undefined; }
}

const env = {
  SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY') || keyFromJson('SUPABASE_PUBLISHABLE_KEYS', 'default'),
  SUPABASE_SERVICE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || keyFromJson('SUPABASE_SECRET_KEYS', 'default'),
  GROQ_API_KEY: Deno.env.get('GROQ_API_KEY'),
  ALLOWED_ORIGINS: Deno.env.get('ALLOWED_ORIGINS') || '',
  GROQ_STT_MODEL: Deno.env.get('GROQ_STT_MODEL') || '',
  GROQ_LLM_MODEL: Deno.env.get('GROQ_LLM_MODEL') || '',
};

Deno.serve((req: Request) => api.fetch(req, env));
