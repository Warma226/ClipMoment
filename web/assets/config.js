// ============================================================
// Réglages du site ClipMoment — à remplir une seule fois.
// Tant que SUPABASE_URL est vide, le site tourne en MODE DÉMO :
// tout fonctionne avec une fausse transcription et rien n'est enregistré en ligne.
// ============================================================
window.CM_CONFIG = {
  // Supabase → Project Settings → API (ou "Data API")
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',          // clé "anon" / "publishable" (publique, sans danger)

  // Adresse de ton Worker Cloudflare, ex. https://clipmoment-api.tonnom.workers.dev
  API_URL: '',

  // Nom affiché partout sur le site
  BRAND: 'ClipMoment',

  // Modèle de transcription Groq (whisper-large-v3-turbo = rapide, whisper-large-v3 = un peu plus précis)
  STT_MODEL: 'whisper-large-v3-turbo',
};
