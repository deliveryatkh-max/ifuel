// Language switch shared by every app on this site: Khmer by default, English on request.
// Saved in localStorage 'app_lang' ('km' | 'en'). LANG.t(km, en) picks the right text.
(function () {
  'use strict';
  const KEY = 'app_lang';
  let lang = 'km';
  try { if (localStorage.getItem(KEY) === 'en') lang = 'en'; } catch (e) { /* private mode */ }
  document.documentElement.lang = lang;
  const subs = [];
  const base = (document.currentScript && document.currentScript.src || '').replace(/[^/]*$/, '');

  const LANG = {
    get: () => lang,
    t: (km, en) => (lang === 'en' ? en : km),
    set(v) {
      lang = v === 'en' ? 'en' : 'km';
      try { localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ }
      document.documentElement.lang = lang;
      document.querySelectorAll('.lang-btn').forEach(paint);
      subs.forEach(f => f(lang));
    },
    onChange: f => subs.push(f),
    // Turns an empty <button class="lang-btn"> into the 🇰🇭 / 🇬🇧 switch.
    button(el) {
      if (!el) return;
      el.innerHTML = `<img src="${base}icons/flag-kh.svg" data-l="km" alt="ខ្មែរ"><img src="${base}icons/flag-gb.svg" data-l="en" alt="English">`;
      el.onclick = () => LANG.set(lang === 'en' ? 'km' : 'en');
      paint(el);
    },
  };
  function paint(el) {
    el.querySelectorAll('img').forEach(i => i.classList.toggle('on', i.dataset.l === lang));
    el.title = lang === 'en' ? 'ភាសាខ្មែរ' : 'English';
    el.setAttribute('aria-label', el.title);
  }
  window.LANG = LANG;
})();
