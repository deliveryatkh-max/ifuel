// Home menu: one tile per app. Each person sees only the apps ticked for them in the Users sheet
// (one tick box column per app, added by the Apps Script). Adding an app = one line in APPS + one column.
(function () {
  'use strict';

  // Colourful flat icons in web/icons/ (Fluent Emoji Flat, MIT licence).
  // url '' = not built yet: the tile shows "Coming soon".
  const APPS = [
    { key: 'fuel', kh: 'ចាក់សាំង', en: 'Fuel Refill', url: 'fuel/' },
    { key: 'transport', kh: 'ដឹកជញ្ជូន', en: 'Transport', url: '' },
    { key: 'overtime', kh: 'ថែមម៉ោង', en: 'Overtime', url: '' },
    { key: 'location', kh: 'ទីតាំងថ្មី', en: 'New Location', url: '' },
    { key: 'dashboard', kh: 'Dashboard', en: 'Fuel Dashboard', url: 'dashboard/' },
  ];

  const CFG = window.APP_CONFIG || {};
  const TOKEN_KEY = 'fr_id_token';      // shared with every app on this site: sign in once
  const CACHE_KEY = 'home_c_';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } };

  function decodeJwt(t) {
    try { return JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); }
    catch (e) { return null; }
  }
  const claims = () => decodeJwt(get(TOKEN_KEY) || '');
  const tokenValid = () => { const c = claims(); return !!(c && c.exp * 1000 > Date.now() + 60000); };
  const email = () => { const c = claims(); return c && c.email ? String(c.email).toLowerCase() : ''; };

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  async function api(action) {
    let res, data;
    try {
      res = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: get(TOKEN_KEY), payload: {} }) });
      data = await res.json();
    } catch (e) {
      throw Object.assign(new Error('មិនអាចភ្ជាប់អ៊ីនធឺណិត / No connection. Please try again.'), { code: 'NET' });
    }
    if (!data.ok) {
      const code = (String(data.error).match(/^(AUTH|NOACCESS):/) || [])[1] || '';
      throw Object.assign(new Error(String(data.error).replace(/^(AUTH|NOACCESS):\s*/, '')), { code });
    }
    return data.data;
  }

  // ---------- Screens ----------
  function renderMenu(d) {
    $('#outBtn').hidden = false;
    const name = (d.user && d.user.name) || email();
    $('#who').textContent = name;
    const mine = APPS.filter(a => d.apps.indexOf(a.key) >= 0);
    $('#view').innerHTML = mine.length ? `
      <p class="hello">សួស្តី <b>${esc(name)}</b> · ជ្រើសរើសកម្មវិធី / Choose an app</p>
      <div class="grid">${mine.map(a => {
        const inner = `<span class="ico"><img src="icons/${esc(a.key)}.svg" alt="" width="66" height="66"></span>
          <span class="t">${esc(a.kh)}${a.en !== a.kh ? `<small>${esc(a.en)}</small>` : ''}</span>
          ${a.url ? '' : '<span class="badge">មកដល់ឆាប់ៗ · Soon</span>'}`;
        return a.url ? `<a class="tile" href="${esc(a.url)}">${inner}</a>`
          : `<button type="button" class="tile soon" data-soon="${esc(a.kh)}">${inner}</button>`;
      }).join('')}</div>` : `
      <div class="card"><div class="big">🗂️</div><h2>មិនទាន់មានកម្មវិធី<small>No apps yet</small></h2>
        <p>សូមស្នើអ្នកគ្រប់គ្រងឲ្យធីកកម្មវិធីសម្រាប់អ្នក។<br>Ask the admin to tick your apps in the Users sheet.</p>
        <button class="btn" id="retry">ព្យាយាមម្តងទៀត / Try again</button></div>`;
    document.querySelectorAll('[data-soon]').forEach(b => b.onclick = () => toast(b.dataset.soon + ' · មកដល់ឆាប់ៗ / Coming soon'));
    if ($('#retry')) $('#retry').onclick = load;
  }

  function renderError(e, canRequest) {
    $('#view').innerHTML = `<div class="card"><div class="big">${canRequest ? '🔒' : '⚠️'}</div>
      <div class="alert bad">${esc(e.message)}</div>
      <p><button class="btn" id="retry">ព្យាយាមម្តងទៀត / Try again</button><button class="btn" id="out2">ចាកចេញ / Sign out</button></p>
      ${canRequest ? '<p id="reqBox"><button class="btn ok" id="req">📨 ស្នើសុំទៅអ្នកគ្រប់គ្រង / Request to Admin</button></p>' : ''}</div>`;
    $('#retry').onclick = load;
    $('#out2').onclick = signOut;
    if ($('#req')) $('#req').onclick = requestAccess;
  }

  async function requestAccess() {
    const btn = $('#req');
    btn.disabled = true; btn.textContent = 'កំពុងផ្ញើ… / Sending…';
    try {
      const r = await api('requestAccess');
      $('#reqBox').innerHTML = r.status === 'active'
        ? '<div class="alert ok">គណនីរបស់អ្នកបានអនុញ្ញាតហើយ។ ចុច Try again។<br>Your account is already allowed. Tap Try again.</div>'
        : '<div class="alert ok">✅ សំណើបានផ្ញើទៅអ្នកគ្រប់គ្រង។ សូមរង់ចាំការអនុញ្ញាត រួចចុច Try again។<br>Request sent to the admin. Once they allow you, tap Try again.</div>';
    } catch (e) {
      btn.disabled = false; btn.textContent = '📨 ស្នើសុំទៅអ្នកគ្រប់គ្រង / Request to Admin';
      toast(e.message);
    }
  }

  function loadGsi() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load Google Sign-In.'));
      document.head.appendChild(s);
    });
  }

  function renderLogin() {
    $('#outBtn').hidden = true;
    $('#who').textContent = '';
    $('#view').innerHTML = `<div class="card"><div class="big">👋</div>
      <h2>សូមស្វាគមន៍<small>Welcome</small></h2>
      <p>ចូលដោយគណនី Google របស់អ្នក<br>Sign in with your Google account</p>
      <div id="gsiButton"><div class="spinner" style="margin:4px auto"></div></div></div>`;
    if (!CFG.GOOGLE_CLIENT_ID) { $('#gsiButton').innerHTML = '<div class="alert bad">GOOGLE_CLIENT_ID is missing in config.js</div>'; return; }
    loadGsi().then(() => {
      google.accounts.id.initialize({
        client_id: CFG.GOOGLE_CLIENT_ID, auto_select: true,
        callback: resp => { set(TOKEN_KEY, resp.credential); load(); },
      });
      $('#gsiButton').innerHTML = '';
      google.accounts.id.renderButton($('#gsiButton'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with' });
      google.accounts.id.prompt();
    }).catch(e => { $('#gsiButton').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; });
  }

  function signOut() {
    set(CACHE_KEY + email(), null);
    set(TOKEN_KEY, null);
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    renderLogin();
  }

  // Opens at once from the saved menu, then checks with the server in the background.
  async function load() {
    if (!CFG.API_URL) { renderMenu({ user: { name: 'Demo' }, apps: APPS.map(a => a.key) }); return; }
    if (!tokenValid()) { renderLogin(); return; }
    const key = CACHE_KEY + email();
    let cached = null;
    try { cached = JSON.parse(get(key) || 'null'); } catch (e) { /* ignore */ }
    if (cached) renderMenu(cached); else $('#view').innerHTML = '<div class="spinner"></div>';
    $('#bar').classList.add('busy');
    try {
      const d = await api('home');
      set(key, JSON.stringify(d));
      if (JSON.stringify(d) !== JSON.stringify(cached)) renderMenu(d);
    } catch (e) {
      if (e.code === 'AUTH') { set(TOKEN_KEY, null); renderLogin(); }
      // Apps Script not updated yet: show today's apps (each app still checks access when opened).
      else if (/Unknown action/i.test(e.message)) renderMenu({ user: { name: email() }, apps: ['fuel', 'dashboard'] });
      else if (e.code === 'NOACCESS') { set(key, null); renderError(e, true); }
      else if (!cached) renderError(e, false);
      else toast(e.message);
    } finally {
      $('#bar').classList.remove('busy');
    }
  }

  // Light / dark, shared with the Fuel Refill app.
  const prefersDark = () => window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  function paintTheme() {
    const t = document.documentElement.getAttribute('data-theme') || (prefersDark() ? 'dark' : 'light');
    $('#themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
  }
  $('#themeBtn').onclick = () => {
    const now = document.documentElement.getAttribute('data-theme') || (prefersDark() ? 'dark' : 'light');
    const next = now === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    set('fr_theme', next);
    paintTheme();
  };
  $('#outBtn').onclick = signOut;
  paintTheme();
  // Coming back to the menu (phone back button) shows any change made by the admin.
  window.addEventListener('pageshow', e => { if (e.persisted) load(); });
  load();
})();
