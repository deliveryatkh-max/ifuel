// "Request to Admin" form, shared by the home menu and the Fuel app: a person who is signed in but not
// allowed yet gives their full name, employee ID and department (drop-down from the Departments sheet).
// Usage: AccessRequest.open({ call: (action, payload) => Promise, onDone: status => {} })
(function () {
  'use strict';
  const t = (km, en) => (window.LANG ? LANG.t(km, en) : km);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
.arq-bg { position: fixed; inset: 0; z-index: 60; background: rgba(1,30,65,.45); display: flex; align-items: flex-end; justify-content: center; opacity: 0; transition: opacity .18s; }
.arq-bg.open { opacity: 1; }
.arq { --c-card: #fff; --c-text: #011e41; --c-muted: #546274; --c-line: #d6dee8; --c-brand: #084f6a; --c-soft: #d4e1f5; --c-bad: #b3261e; --c-bad-soft: #fbe9e7; --c-ok: #1e7b46; --c-ok-soft: #e3f4ea;
  width: 100%; max-width: 480px; max-height: 92vh; overflow: auto; background: var(--c-card); color: var(--c-text); border-radius: 20px 20px 0 0;
  padding: 18px 18px calc(18px + env(safe-area-inset-bottom)); transform: translateY(24px); transition: transform .18s; font: inherit; text-align: left; }
.arq-bg.open .arq { transform: none; }
@media (min-width: 560px) { .arq-bg { align-items: center; } .arq { border-radius: 20px; } }
:root[data-theme="dark"] .arq { --c-card: #0d1e32; --c-text: #e6eef7; --c-muted: #9cb0c6; --c-line: #213852; --c-brand: #61cbf4; --c-soft: #112d48; --c-bad: #f28b82; --c-bad-soft: #3a1c1a; --c-ok: #5cc98a; --c-ok-soft: #173327; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .arq { --c-card: #0d1e32; --c-text: #e6eef7; --c-muted: #9cb0c6; --c-line: #213852; --c-brand: #61cbf4; --c-soft: #112d48; --c-bad: #f28b82; --c-bad-soft: #3a1c1a; --c-ok: #5cc98a; --c-ok-soft: #173327; } }
.arq h2 { margin: 0 0 4px; font-size: 19px; }
.arq .arq-sub { margin: 0 0 14px; color: var(--c-muted); font-size: 14px; }
.arq label { display: block; margin: 0 0 12px; }
.arq label > span { display: block; font-size: 14px; font-weight: 600; margin-bottom: 5px; }
.arq label > span i { color: var(--c-bad); font-style: normal; }
.arq input, .arq select { width: 100%; box-sizing: border-box; min-height: 46px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--c-line);
  background: var(--c-card); color: var(--c-text); font: inherit; font-size: 16px; }
.arq input:focus, .arq select:focus { outline: 2px solid var(--c-brand); outline-offset: 0; border-color: transparent; }
.arq input[readonly] { background: var(--c-soft); color: var(--c-muted); }
.arq .arq-btns { display: flex; gap: 10px; margin-top: 6px; }
.arq .arq-btns button { flex: 1; min-height: 48px; border-radius: 12px; font: inherit; font-weight: 700; cursor: pointer; border: 1px solid var(--c-line); background: var(--c-card); color: var(--c-text); }
.arq .arq-btns .go { background: var(--c-brand); border-color: var(--c-brand); color: #fff; }
:root[data-theme="dark"] .arq .arq-btns .go { color: #011e41; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .arq .arq-btns .go { color: #011e41; } }
.arq .arq-btns button:disabled { opacity: .6; }
.arq .arq-msg { border-radius: 12px; padding: 10px 12px; margin: 0 0 12px; font-size: 14px; }
.arq .arq-msg.bad { background: var(--c-bad-soft); color: var(--c-bad); }
.arq .arq-msg.ok { background: var(--c-ok-soft); color: var(--c-ok); }
.arq .arq-spin { width: 30px; height: 30px; margin: 30px auto; border: 3px solid var(--c-line); border-top-color: var(--c-brand); border-radius: 50%; animation: arqspin .8s linear infinite; }
@keyframes arqspin { to { transform: rotate(360deg); } }`;

  function open(opts) {
    if (!document.getElementById('arq-css')) {
      const st = document.createElement('style');
      st.id = 'arq-css'; st.textContent = CSS;
      document.head.appendChild(st);
    }
    const bg = document.createElement('div');
    bg.className = 'arq-bg';
    bg.innerHTML = `<div class="arq" role="dialog" aria-modal="true"><div class="arq-spin"></div></div>`;
    const box = bg.querySelector('.arq');
    const onKey = e => { if (e.key === 'Escape') close(); };
    function close() {
      document.removeEventListener('keydown', onKey);
      bg.classList.remove('open');
      setTimeout(() => bg.remove(), 200);
    }
    bg.addEventListener('click', e => { if (e.target === bg) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
    requestAnimationFrame(() => bg.classList.add('open'));

    // The form's details come from the server; an older server without "requestForm" still gets a form, with a typed department.
    opts.call('requestForm').catch(e => (/Unknown action/i.test(e.message) ? {} : Promise.reject(e))).then(d => {
      if (d.status === 'active') { done('active'); return; }
      form(d);
    }).catch(e => {
      box.innerHTML = `<div class="arq-msg bad">${esc(e.message)}</div><div class="arq-btns"><button type="button" data-x>${t('បិទ', 'Close')}</button></div>`;
      box.querySelector('[data-x]').onclick = close;
    });

    function form(d) {
      const list = d.departments || [];
      box.innerHTML = `
        <h2>📨 ${t('ស្នើសុំទៅអ្នកគ្រប់គ្រង', 'Request to Admin')}</h2>
        <p class="arq-sub">${t('សូមបំពេញព័ត៌មានរបស់អ្នក ដើម្បីឲ្យអ្នកគ្រប់គ្រងអនុញ្ញាត។', 'Fill in your details so the admin can allow you.')}</p>
        <div class="arq-err"></div>
        <form novalidate>
          ${d.email ? `<label><span>${t('អ៊ីមែល', 'Email')}</span><input value="${esc(d.email)}" readonly></label>` : ''}
          <label><span>${t('ឈ្មោះពេញ', 'Full name')} <i>*</i></span>
            <input name="fullName" autocomplete="name" maxlength="100" value="${esc(d.fullName || '')}" required></label>
          <label><span>${t('លេខសម្គាល់បុគ្គលិក', 'Employee ID number')} <i>*</i></span>
            <input name="employeeId" maxlength="40" value="${esc(d.employeeId || '')}" autocapitalize="characters" required></label>
          <label><span>${t('ផ្នែក', 'Department')} <i>*</i></span>
            ${list.length
              ? `<select name="department" required><option value="">${t('— ជ្រើសរើស —', '— Choose —')}</option>${list.map(x => `<option${x === d.department ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>`
              : `<input name="department" maxlength="100" value="${esc(d.department || '')}" required>`}</label>
          <div class="arq-btns">
            <button type="button" data-x>${t('បោះបង់', 'Cancel')}</button>
            <button type="submit" class="go">${t('ផ្ញើសំណើ', 'Send request')}</button>
          </div>
        </form>`;
      const f = box.querySelector('form');
      box.querySelector('[data-x]').onclick = close;
      const first = [...f.querySelectorAll('input:not([readonly]),select')].find(x => !x.value);
      if (first) setTimeout(() => first.focus(), 250);
      f.onsubmit = async e => {
        e.preventDefault();
        const p = { fullName: f.fullName.value.trim(), employeeId: f.employeeId.value.trim(), department: f.department.value.trim() };
        const miss = !p.fullName ? f.fullName : !p.employeeId ? f.employeeId : !p.department ? f.department : null;
        if (miss) {
          box.querySelector('.arq-err').innerHTML = `<div class="arq-msg bad">${t('សូមបំពេញគ្រប់ចន្លោះដែលមានសញ្ញា *', 'Please fill in every field marked *')}</div>`;
          miss.focus();
          return;
        }
        const btn = f.querySelector('.go');
        btn.disabled = true; btn.textContent = t('កំពុងផ្ញើ…', 'Sending…');
        try {
          const r = await opts.call('requestAccess', p);
          done(r.status);
        } catch (err) {
          btn.disabled = false; btn.textContent = t('ផ្ញើសំណើ', 'Send request');
          box.querySelector('.arq-err').innerHTML = `<div class="arq-msg bad">${esc(err.message)}</div>`;
        }
      };
    }

    function done(status) {
      box.innerHTML = status === 'active'
        ? `<div class="arq-msg ok">${t('គណនីរបស់អ្នកបានអនុញ្ញាតហើយ។ ចុច ព្យាយាមម្តងទៀត។', 'Your account is already allowed. Tap Try again.')}</div>`
        : `<h2>✅ ${t('បានផ្ញើសំណើ', 'Request sent')}</h2>
           <p class="arq-sub">${t('អ្នកគ្រប់គ្រងនឹងពិនិត្យ និងអនុញ្ញាត។ បន្ទាប់មក ចុច ព្យាយាមម្តងទៀត។', 'The admin will check and allow you. Then tap Try again.')}</p>`;
      box.insertAdjacentHTML('beforeend', `<div class="arq-btns"><button type="button" class="go" data-x>${t('យល់ព្រម', 'OK')}</button></div>`);
      box.querySelector('[data-x]').onclick = close;
      if (opts.onDone) opts.onDone(status);
    }
  }

  /** The server's "not allowed" messages in the reader's language (the server writes them in English). */
  function notAllowed(msg) {
    const m = String(msg || '');
    let x = /^(\S+@\S+) is not allowed to use this app/.exec(m);
    if (x) return t(`គណនី ${x[1]} មិនទាន់មានសិទ្ធិប្រើកម្មវិធីនេះទេ។ សូមចុច “ស្នើសុំទៅអ្នកគ្រប់គ្រង” ខាងក្រោម។`,
      `${x[1]} is not allowed to use this app yet. Tap “Request to Admin” below.`);
    x = /^(\S+@\S+) has no access to (.+?)\. Ask the admin/.exec(m);
    if (x) return t(`គណនី ${x[1]} មិនទាន់មានសិទ្ធិប្រើ ${x[2]} ទេ។ សូមស្នើអ្នកគ្រប់គ្រងឲ្យធីកវាក្នុង Users sheet។`, m);
    return m;
  }

  window.AccessRequest = { open, notAllowed };
})();
