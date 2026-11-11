/* ClipMoment — page d'administration : crédits, clients, réglages de vente. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const { el, toast, errMsg } = CM;
  const REASONS = { bienvenue: 'Crédits offerts', analyse: 'Analyse', import: 'Import par lien', recharge: 'Recharge', remboursement: 'Remboursement', correction: 'Correction' };
  const ADMIN_ERR = { ACCES_REFUSE: 'Accès refusé : ce compte n\'est pas administrateur.', CLIENT_INTROUVABLE: 'Aucun client avec cette adresse e-mail.', MONTANT_NUL: 'Indique un nombre de crédits différent de zéro.' };
  const msg = (e) => { const m = String(e && e.message || e); for (const k in ADMIN_ERR) if (m.includes(k)) return ADMIN_ERR[k]; return errMsg(e); };
  const date = (d) => new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  document.querySelectorAll('[data-brand]').forEach((n) => { n.textContent = CM.brand; });

  async function init() {
    const gate = $('#gate');
    const s = await CM.auth.session();
    if (!s) { gate.innerHTML = ''; gate.append('Connecte-toi d\'abord dans le ', el('a', { href: 'app.html', text: 'studio' }), ', puis reviens ici.'); return; }
    let p;
    try { p = await CM.db.profile(); } catch (e) { gate.textContent = msg(e); gate.className = 'alert err'; return; }
    if (!p.is_admin) {
      gate.className = 'alert err';
      gate.textContent = 'Ce compte (' + p.email + ') n\'est pas administrateur. Dans Supabase → SQL Editor, lance : update public.profiles set is_admin = true where email = \'' + p.email + '\';';
      return;
    }
    gate.hidden = true; $('#admin').hidden = false;
    await Promise.all([loadStats(), loadUsers(''), loadEvents(), loadSettings()]);
  }

  async function loadStats() {
    try {
      const s = await CM.db.rpc('admin_stats');
      $('#s-clients').textContent = s.clients; $('#s-analyses').textContent = s.analyses;
      $('#s-minutes').textContent = s.minutes; $('#s-sold').textContent = s.credits_vendus;
    } catch (e) { toast(msg(e), 'err'); }
  }

  async function loadUsers(q) {
    const tb = $('#users'); tb.textContent = '';
    let rows = [];
    try { rows = await CM.db.rpc('admin_list_users', { p_search: q || '' }); } catch (e) { toast(msg(e), 'err'); return; }
    if (!rows.length) { tb.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'muted', text: 'Aucun client.' })])); return; }
    rows.forEach((u) => tb.appendChild(el('tr', {}, [
      el('td', { class: 'mail', text: u.email + (u.is_admin ? ' (admin)' : '') }),
      el('td', { class: 'num', text: String(u.credits) }),
      el('td', { class: 'num', text: String(u.projects) }),
      el('td', { text: new Date(u.created_at).toLocaleDateString('fr-FR') }),
      el('td', {}, [el('button', { class: 'btn small', type: 'button', text: 'Créditer', onclick: () => { $('#add-email').value = u.email; $('#add-amount').focus(); $('#add-form').scrollIntoView({ behavior: 'smooth' }); } })]),
    ])));
  }

  async function loadEvents() {
    const tb = $('#events'); tb.textContent = '';
    let rows = [];
    try { rows = await CM.db.rpc('admin_recent_events', { p_limit: 50 }); } catch (e) { toast(msg(e), 'err'); return; }
    rows.forEach((r) => tb.appendChild(el('tr', {}, [
      el('td', { text: date(r.created_at) }),
      el('td', { class: 'mail', text: r.email || '' }),
      el('td', { text: (REASONS[r.reason] || r.reason) + (r.note ? ' · ' + r.note : '') }),
      el('td', { class: 'num ' + (r.delta > 0 ? 'plus' : 'minus'), text: (r.delta > 0 ? '+' : '') + r.delta }),
    ])));
  }

  let settings = {};
  function packRow(p) {
    const c = el('input', { type: 'number', min: '1', step: '1', value: p ? p.credits : '', placeholder: 'Crédits', 'aria-label': 'Crédits du pack' });
    const pr = el('input', { type: 'text', value: p ? p.price : '', placeholder: '1 000 F', 'aria-label': 'Prix affiché' });
    const nm = el('input', { type: 'text', value: p && p.name || '', maxlength: '30', placeholder: 'Nom (ex. Créateur)', 'aria-label': 'Nom du pack' });
    const old = el('input', { type: 'text', value: p && p.old_price || '', maxlength: '20', placeholder: 'Ancien prix (promo)', 'aria-label': 'Ancien prix, seulement pour une vraie promotion' });
    const per = el('input', { type: 'text', value: p ? (p.period || '') : 'mois', maxlength: '12', placeholder: 'Période (mois, vide = sans)', 'aria-label': 'Période, par exemple mois' });
    const tl = el('input', { type: 'text', class: 'wide', value: p && p.tagline || '', maxlength: '60', placeholder: 'Phrase courte (ex. Pour publier chaque semaine)', 'aria-label': 'Phrase du pack' });
    const row = el('div', { class: 'packrow' }, [c, pr, nm, old, per, el('span'), tl, el('button', { class: 'btn small ghost', type: 'button', text: 'Retirer', onclick: () => row.remove() })]);
    $('#packs').appendChild(row);
  }
  async function loadSettings() {
    settings = await CM.loadSettings();
    $('#set-welcome').value = Number(settings.welcome_credits) || 0;
    $('#set-max').value = Number(settings.max_minutes) || 30;
    $('#set-linkfee').value = settings.link_fee != null ? Number(settings.link_fee) : 3;
    $('#packs').textContent = '';
    (Array.isArray(settings.packs) ? settings.packs : []).forEach(packRow);
    const pay = settings.payment || {};
    $('#set-instr').value = pay.instructions || ''; $('#set-om').value = pay.orange_money || ''; $('#set-wave').value = pay.wave || ''; $('#set-wa').value = pay.whatsapp || '';
    const q = $('#quick'); q.textContent = '';
    (Array.isArray(settings.packs) ? settings.packs : []).forEach((p) => q.appendChild(el('button', { class: 'btn small', type: 'button', text: '+' + p.credits + ' (' + p.price + (p.period ? '/' + p.period : '') + ')', onclick: () => { $('#add-amount').value = p.credits; $('#add-note').value = p.price; } })));
  }
  $('#pack-add').addEventListener('click', () => packRow(null));

  $('#set-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const packs = Array.from(document.querySelectorAll('#packs .packrow')).map((r) => {
      const [c, p, n, o, pe, t] = r.querySelectorAll('input');
      const pk = { credits: Math.round(Number(c.value)), price: p.value.trim() };
      if (n.value.trim()) pk.name = n.value.trim();
      if (t.value.trim()) pk.tagline = t.value.trim();
      if (o.value.trim()) pk.old_price = o.value.trim();
      if (pe.value.trim()) pk.period = pe.value.trim().replace(/^\/\s*/, '');
      return pk;
    }).filter((p) => p.credits > 0 && p.price);
    try {
      await CM.db.rpc('admin_set_setting', { p_key: 'welcome_credits', p_value: Math.max(0, Math.round(Number($('#set-welcome').value) || 0)) });
      await CM.db.rpc('admin_set_setting', { p_key: 'max_minutes', p_value: Math.min(120, Math.max(1, Math.round(Number($('#set-max').value) || 30))) });
      await CM.db.rpc('admin_set_setting', { p_key: 'packs', p_value: packs });
      await CM.db.rpc('admin_set_setting', { p_key: 'link_fee', p_value: Math.min(50, Math.max(0, Math.round(Number($('#set-linkfee').value) || 0))) });
      await CM.db.rpc('admin_set_setting', { p_key: 'payment', p_value: { instructions: $('#set-instr').value.trim(), orange_money: $('#set-om').value.trim(), wave: $('#set-wave').value.trim(), whatsapp: $('#set-wa').value.trim() } });
      toast('Réglages enregistrés.');
      loadSettings();
    } catch (err) { toast(msg(err), 'err'); }
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#add-email').value.trim(), amount = Math.round(Number($('#add-amount').value));
    if (!email || !amount) { toast('Indique l\'e-mail et le nombre de crédits.', 'err'); return; }
    try {
      const r = await CM.db.rpc('admin_add_credits', { p_email: email, p_amount: amount, p_note: $('#add-note').value.trim() });
      const ok = $('#add-ok'); ok.textContent = (amount > 0 ? '+' : '') + amount + ' crédits pour ' + r.email + '. Nouveau solde : ' + r.credits + '.'; ok.hidden = false;
      $('#add-amount').value = ''; $('#add-note').value = '';
      loadUsers($('#search').value.trim()); loadEvents(); loadStats();
    } catch (err) { toast(msg(err), 'err'); }
  });
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); loadUsers($('#search').value.trim()); });

  init();
})();
