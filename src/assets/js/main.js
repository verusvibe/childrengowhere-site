(() => {
  'use strict';
  const doc = document;
  const root = doc.documentElement;
  const desktop = window.matchMedia('(min-width: 1040px)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Keep the anchor scroll offset equal to the real (sticky) header height.
  const header = doc.getElementById('site-header');
  if (header && 'ResizeObserver' in window) {
    new ResizeObserver(() => root.style.setProperty('--header-h', `${header.offsetHeight}px`)).observe(header);
  }

  // Mobile navigation (disclosure pattern).
  const toggle = doc.querySelector('.menu-toggle');
  const nav = doc.getElementById('site-nav');
  if (toggle && nav) {
    const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
    const setOpen = (open, returnFocus) => {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
      if (!open && returnFocus) toggle.focus();
    };
    toggle.addEventListener('click', () => setOpen(!isOpen()));
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
    doc.addEventListener('click', (e) => { if (isOpen() && !e.target.closest('#site-header')) setOpen(false); });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) setOpen(false, true); });
    desktop.addEventListener('change', () => setOpen(false));
  }

  // Screenshot carousel: native scroll-snap plus prev/next buttons.
  doc.querySelectorAll('[data-carousel]').forEach((root_) => {
    const track = root_.querySelector('[data-track]');
    const prev = root_.querySelector('[data-prev]');
    const next = root_.querySelector('[data-next]');
    if (!track || !prev || !next) return;
    root_.querySelector('.gallery__btns')?.removeAttribute('hidden');
    const step = () => {
      const item = track.querySelector('.gallery__item');
      return item ? item.getBoundingClientRect().width + 16 : track.clientWidth * 0.8;
    };
    const update = () => {
      prev.disabled = track.scrollLeft <= 4;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    };
    const go = (dir) => track.scrollBy({ left: dir * step(), behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    prev.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    track.addEventListener('scroll', () => window.requestAnimationFrame(update), { passive: true });
    window.addEventListener('resize', update);
    update();
  });

  // Sticky download bar: appears once the hero CTA has scrolled away, hides near the final CTA/footer.
  const sticky = doc.getElementById('sticky-cta');
  const heroCta = doc.querySelector('[data-hero-cta]');
  if (sticky && heroCta && 'IntersectionObserver' in window) {
    let dismissed = false;
    try { dismissed = sessionStorage.getItem('cgw-sticky-dismissed') === '1'; } catch (_) { /* storage unavailable */ }
    let heroGone = false;
    const stops = new Set();
    const render = () => { sticky.hidden = dismissed || !heroGone || stops.size > 0; };

    new IntersectionObserver(([entry]) => {
      heroGone = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      render();
    }).observe(heroCta);

    const stopObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => (e.isIntersecting ? stops.add(e.target) : stops.delete(e.target)));
      render();
    });
    doc.querySelectorAll('[data-sticky-stop]').forEach((el) => stopObserver.observe(el));

    sticky.querySelector('.sticky-cta__close')?.addEventListener('click', () => {
      dismissed = true;
      try { sessionStorage.setItem('cgw-sticky-dismissed', '1'); } catch (_) { /* storage unavailable */ }
      render();
    });
  }

  // One-Pager print button (hidden until JS is available).
  doc.querySelectorAll('[data-print]').forEach((btn) => {
    btn.removeAttribute('hidden');
    btn.addEventListener('click', () => window.print());
  });
})();
