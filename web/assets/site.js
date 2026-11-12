/* ClipMoment — pages publiques : en-tête et pied de page communs, menu mobile, animations au défilement.
   Chaque page déclare <body class="site" data-page="…"> et, si elle s'ouvre sur le ciel bleu, data-sky. */
(function () {
  'use strict';
  document.documentElement.classList.add('js');
  const body = document.body;
  const page = body.dataset.page || '';
  const sky = body.hasAttribute('data-sky');
  const brand = (window.CM && CM.brand) || (window.CM_CONFIG && CM_CONFIG.BRAND) || 'ClipMoment';
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LINKS = [['accueil', 'index.html', 'Accueil'], ['fonctions', 'fonctionnalites.html', 'Fonctionnalités'], ['exemples', 'exemples.html', 'Exemples'], ['tarifs', 'tarifs.html', 'Tarifs'], ['contact', 'contact.html', 'Contact']];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cur = (k) => (k === page ? ' aria-current="page"' : '');

  /* En-tête */
  const h = document.createElement('header');
  h.className = 'site-h' + (sky ? '' : ' solid');
  h.innerHTML = '<div class="wrap">' +
    '<a class="logo" href="index.html"><i aria-hidden="true"></i><span>' + esc(brand) + '</span></a>' +
    '<nav aria-label="Menu principal">' + LINKS.map((l) => '<a href="' + l[1] + '"' + cur(l[0]) + '>' + l[2] + '</a>').join('') + '</nav>' +
    '<div class="right"><a class="login" href="app.html">Connexion</a><a class="btn small cta" href="app.html">Commencer</a>' +
    '<button class="burger" type="button" aria-expanded="false" aria-controls="mnav" aria-label="Ouvrir le menu">' +
    '<svg class="m" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h14M3 10h14M3 14h14"/></svg>' +
    '<svg class="x" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div></div>' +
    '<div class="mnav" id="mnav">' + LINKS.map((l) => '<a href="' + l[1] + '"' + cur(l[0]) + '>' + l[2] + '</a>').join('') +
    '<div class="row"><a class="btn" href="app.html">Connexion</a><a class="btn primary" href="app.html">Essayer gratuitement</a></div>' +
    '<button class="btn block install-only" type="button" data-install style="margin-top:10px">📲 Installer l\'application</button></div>';
  body.insertBefore(h, body.firstChild);
  if (!sky) { const sp = document.createElement('div'); sp.className = 'h-space'; h.after(sp); }
  const burger = h.querySelector('.burger');
  const setOpen = (o) => { h.classList.toggle('open', o); burger.setAttribute('aria-expanded', String(o)); burger.setAttribute('aria-label', o ? 'Fermer le menu' : 'Ouvrir le menu'); };
  burger.addEventListener('click', () => setOpen(!h.classList.contains('open')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  h.querySelectorAll('.mnav a, .mnav [data-install]').forEach((a) => a.addEventListener('click', () => setOpen(false)));
  if (sky) {
    const onScroll = () => h.classList.toggle('solid', window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }

  /* Pied de page */
  const f = document.createElement('footer');
  f.className = 'site-f';
  f.innerHTML = '<div class="wrap"><div class="cols">' +
    '<div class="about"><a class="logo" href="index.html"><i aria-hidden="true"></i><span>' + esc(brand) + '</span></a>' +
    '<p>Tes vidéos longues transformées en clips verticaux sous-titrés, depuis ton téléphone. Paiement Orange Money ou Wave.</p>' +
    '<div class="row" style="gap:8px"><a class="btn primary small" href="app.html">Essayer gratuitement</a><button class="btn small install-only" type="button" data-install>📲 Installer l\'application</button></div></div>' +
    '<div><h4>Produit</h4><ul><li><a href="fonctionnalites.html">Fonctionnalités</a></li><li><a href="exemples.html">Exemples</a></li><li><a href="tarifs.html">Tarifs</a></li><li><a href="app.html">Ouvrir le studio</a></li></ul></div>' +
    '<div><h4>Aide</h4><ul><li><a href="index.html#comment">Comment ça marche</a></li><li><a href="index.html#faq">Questions fréquentes</a></li><li><a href="contact.html">Contact</a></li></ul></div>' +
    '<div><h4>Nous écrire</h4><ul id="f-contact"><li><a href="contact.html">Formulaire de contact</a></li></ul></div>' +
    '</div><div class="bottom"><span>© ' + new Date().getFullYear() + ' ' + esc(brand) + '</span><span>Clips pour TikTok, Reels, Shorts et Facebook</span></div></div>';
  body.appendChild(f);
  if (window.CM && CM.loadSettings) {
    CM.loadSettings().then((s) => {
      const wa = s && s.payment && s.payment.whatsapp; const d = String(wa || '').replace(/[^\d]/g, '');
      if (d.length >= 8) {
        const li = document.createElement('li');
        li.innerHTML = '<a href="https://wa.me/' + d + '" target="_blank" rel="noopener">WhatsApp : ' + esc(wa) + '</a>';
        document.getElementById('f-contact').prepend(li);
      }
    }).catch(() => {});
  }

  /* Apparition au défilement, compteurs */
  function count(el) {
    const to = Number(el.dataset.count) || 0, suf = el.dataset.suffix || '', t0 = performance.now(), dur = 1200;
    if (reduce) { el.textContent = to + suf; return; }
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), v = Math.round(to * (1 - Math.pow(1 - k, 3))); el.textContent = v + suf; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  const targets = document.querySelectorAll('.rv, [data-count], .montage');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      const t = e.target;
      if (t.classList.contains('rv')) t.classList.add('in');
      if (t.dataset.count) count(t);
      if (t.classList.contains('montage')) startMontage(t);
      io.unobserve(t);
    }), { threshold: 0.18, rootMargin: '0px 0px -40px 0px' });
    targets.forEach((t) => io.observe(t));
  } else targets.forEach((t) => { t.classList.add('in'); if (t.dataset.count) t.textContent = t.dataset.count + (t.dataset.suffix || ''); if (t.classList.contains('montage')) startMontage(t); });

  /* Démonstration du montage : 5 phases en boucle */
  function startMontage(m) {
    if (m._on) return; m._on = true;
    const steps = m.querySelectorAll('.mt-steps li'), dur = m.querySelector('[data-dur]');
    const DUR = ['12:34', '12:34', '10:52', '1:08', '1:08'];
    let p = 0;
    const show = () => {
      m.classList.remove('p1', 'p2', 'p3', 'p4'); if (p) m.classList.add('p' + p);
      steps.forEach((li, i) => li.classList.toggle('on', i === p));
      if (dur) { dur.textContent = DUR[p]; dur.style.color = p >= 3 ? 'var(--accent)' : ''; }
    };
    if (reduce) { p = 4; show(); return; }
    show();
    setInterval(() => { p = (p + 1) % 5; show(); }, 2300);
  }

  /* Vidéos dans les téléphones : chargées et lues seulement quand elles sont à l'écran ; bouton son (une seule vidéo sonore à la fois) */
  const vids = Array.from(document.querySelectorAll('video[data-src], .screen video'));
  const play = (v) => { if (reduce && v.muted) return; const p = v.play(); if (p && p.catch) p.catch(() => {}); };
  if (vids.length && 'IntersectionObserver' in window) {
    const vo = new IntersectionObserver((es) => es.forEach((e) => {
      const v = e.target;
      if (e.isIntersecting) { if (v.dataset.src && !v.getAttribute('src')) { v.src = v.dataset.src; v.preload = 'auto'; } play(v); }
      else v.pause();
    }), { threshold: 0.25 });
    vids.forEach((v) => vo.observe(v));
  }
  document.querySelectorAll('.snd').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const v = b.parentElement.querySelector('video'); if (!v) return;
    const on = v.muted;
    vids.forEach((x) => { if (x !== v) x.muted = true; });
    document.querySelectorAll('.snd').forEach((x) => { x.setAttribute('aria-pressed', 'false'); x.setAttribute('aria-label', 'Activer le son'); });
    v.muted = !on;
    if (on) { if (v.dataset.src && !v.getAttribute('src')) v.src = v.dataset.src; play(v); b.setAttribute('aria-pressed', 'true'); b.setAttribute('aria-label', 'Couper le son'); }
  }));

  /* Sous-titres mot par mot sur un téléphone : <div class="cap" data-karaoke="phrase|phrase"> */
  document.querySelectorAll('[data-karaoke]').forEach((cap) => {
    const lines = cap.dataset.karaoke.split('|').map((l) => l.trim().split(/\s+/));
    let li = 0, wi = 0;
    const render = () => {
      const w = lines[li];
      cap.innerHTML = w.map((x, i) => (i === wi ? '<b>' + esc(x) + '</b>' : esc(x))).join(' ');
    };
    render();
    if (reduce) return;
    setInterval(() => { wi++; if (wi >= lines[li].length) { wi = 0; li = (li + 1) % lines.length; } render(); }, 420);
  });

  /* Mot qui change dans un titre : <span data-rotate="mot|mot|mot"> */
  document.querySelectorAll('[data-rotate]').forEach((el) => {
    const words = el.dataset.rotate.split('|'); let i = 0;
    if (reduce || words.length < 2) return;
    el.style.transition = 'opacity .3s, transform .3s'; el.style.display = 'inline-block';
    setInterval(() => {
      el.style.opacity = '0'; el.style.transform = 'translateY(10px)';
      setTimeout(() => { i = (i + 1) % words.length; el.textContent = words[i]; el.style.opacity = '1'; el.style.transform = 'none'; }, 300);
    }, 2400);
  });
})();
