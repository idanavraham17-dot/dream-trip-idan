/* Dream Trip PWA runtime
 * Replaces the claude.ai artifact runtime (window.claude.use) with:
 *  - db:        a Firestore-style document store on a Supabase table `docs(path, data)`,
 *               with an offline cache + outbox so edits made without signal sync later
 *  - assets:    photo uploads to the Supabase Storage bucket `media`
 *  - downloads: plain browser file downloads
 * Static app images ship inside the app (assets/<id>.<ext>) and are cached by the service worker.
 */
(function () {
  'use strict';
  const CFG = window.DT_CONFIG || {};
  const STATIC = window.DT_STATIC || {};
  const LSK = { cache: 'dt-docs-cache-v1', outbox: 'dt-outbox-v1' };
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  const configured = !!(CFG.supabaseUrl && CFG.supabaseKey && window.supabase);
  const sb = configured ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;

  /* ---------- asset urls ---------- */
  window.dtAssetUrl = id => STATIC[id] ? `assets/${id}.${STATIC[id]}` : (configured ? `${CFG.supabaseUrl}/storage/v1/object/public/media/${id}` : '');

  /* ---------- downloads ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.ics$/i.test(filename) ? 'text/calendar' : 'text/html;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }
  };

  /* ---------- document store ---------- */
  const cache = new Map(Object.entries(ls.get(LSK.cache, {})));
  let outbox = ls.get(LSK.outbox, []);
  const docL = new Map(), colL = new Map();
  const persist = () => { ls.set(LSK.cache, Object.fromEntries(cache)); };
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const deepMerge = (a, b) => { const o = { ...(isObj(a) ? a : {}) }; for (const [k, v] of Object.entries(b || {})) o[k] = isObj(v) && isObj(o[k]) ? deepMerge(o[k], v) : v; return o; };
  const snapDoc = path => ({ id: path.split('/').pop(), exists: cache.has(path), data: () => cache.get(path) });
  const colOf = path => { const p = path.split('/'); return p.length === 2 ? p[0] : null; };
  function snapCol(name) {
    const docs = []; for (const [p, v] of cache) if (colOf(p) === name) docs.push({ id: p.split('/')[1], data: () => v });
    return { docs, size: docs.length, empty: !docs.length };
  }
  function notify(path) {
    (docL.get(path) || []).forEach(f => { try { f(snapDoc(path)); } catch (e) { console.warn(e); } });
    const c = colOf(path); if (c) (colL.get(c) || []).forEach(f => { try { f(snapCol(c)); } catch (e) { console.warn(e); } });
  }
  function applyLocal(op) {
    if (op.op === 'set') cache.set(op.path, op.data);
    else if (op.op === 'merge') cache.set(op.path, deepMerge(cache.get(op.path), op.data));
    else if (op.op === 'delete') cache.delete(op.path);
    persist(); notify(op.path);
  }
  let flushing = false;
  async function sendOp(op) {
    if (op.op === 'set') { const { error } = await sb.from('docs').upsert({ path: op.path, data: op.data, updated_at: new Date().toISOString() }); if (error) throw error; }
    else if (op.op === 'merge') {
      const cur = await sb.from('docs').select('data').eq('path', op.path).maybeSingle(); if (cur.error) throw cur.error;
      const { error } = await sb.from('docs').upsert({ path: op.path, data: deepMerge(cur.data && cur.data.data, op.data), updated_at: new Date().toISOString() }); if (error) throw error;
    }
    else if (op.op === 'delete') { const { error } = await sb.from('docs').delete().eq('path', op.path); if (error) throw error; }
  }
  async function flush() {
    if (flushing || !sb || !outbox.length) { setStatus(); return; }
    flushing = true;
    try {
      while (outbox.length) {
        if (!navigator.onLine) break;
        try { await sendOp(outbox[0]); outbox.shift(); ls.set(LSK.outbox, outbox); }
        catch (e) { console.warn('sync retry later', e); break; }
      }
    } finally { flushing = false; setStatus(); }
  }
  function queue(op) { applyLocal(op); outbox.push(op); ls.set(LSK.outbox, outbox); flush(); return Promise.resolve(); }
  window.addEventListener('online', flush);
  setInterval(flush, 30000);

  function setStatus() {
    const el = document.getElementById('syncTxt'); if (!el) return;
    const pill = document.getElementById('sync');
    if (!navigator.onLine) { el.textContent = outbox.length ? `אופליין · ${outbox.length} ממתינים` : 'אופליין · שמור במכשיר'; pill && pill.classList.remove('live'); }
    else if (outbox.length) { el.textContent = 'מסנכרן…'; }
    else { el.textContent = 'מסונכרן בענן'; pill && pill.classList.add('live'); }
  }
  window.addEventListener('offline', setStatus);

  async function pullAll() {
    let from = 0; const size = 1000, fresh = new Map();
    for (;;) {
      const { data, error } = await sb.from('docs').select('path,data').range(from, from + size - 1);
      if (error) throw error;
      data.forEach(r => fresh.set(r.path, r.data));
      if (data.length < size) break; from += size;
    }
    const pending = new Set(outbox.map(o => o.path));
    const touched = new Set([...cache.keys(), ...fresh.keys()]);
    for (const p of touched) {
      if (pending.has(p)) continue; // local edit not yet uploaded wins
      if (fresh.has(p)) cache.set(p, fresh.get(p)); else cache.delete(p);
    }
    persist(); touched.forEach(notify);
  }
  function listen() {
    sb.channel('docs-live').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, ev => {
      const row = ev.new && ev.new.path ? ev.new : ev.old; if (!row || !row.path) return;
      if (outbox.some(o => o.path === row.path)) return;
      if (ev.eventType === 'DELETE') cache.delete(row.path); else cache.set(row.path, ev.new.data);
      persist(); notify(row.path);
    }).subscribe();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) pullAll().catch(() => {}); });
    window.addEventListener('online', () => pullAll().catch(() => {}));
  }
  const db = {
    doc(path) {
      return {
        set: data => queue({ op: 'set', path, data }),
        update: patch => queue({ op: 'merge', path, data: patch }),
        delete: () => queue({ op: 'delete', path }),
        onSnapshot(fn) { if (!docL.has(path)) docL.set(path, new Set()); docL.get(path).add(fn); setTimeout(() => fn(snapDoc(path)), 0); return () => docL.get(path).delete(fn); }
      };
    },
    collection(name) {
      return { onSnapshot(fn) { if (!colL.has(name)) colL.set(name, new Set()); colL.get(name).add(fn); setTimeout(() => fn(snapCol(name)), 0); return () => colL.get(name).delete(fn); } };
    }
  };

  /* ---------- photo uploads ---------- */
  const assets = {
    async upload(blob, { type }) {
      if (!navigator.onLine) throw { code: 'quota_or_state' };
      const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-f0-9]/gi, '').slice(0, 32);
      const { error } = await sb.storage.from('media').upload(id, blob, { contentType: type, cacheControl: '31536000', upsert: false });
      if (error) throw { code: error.statusCode === '413' ? 'too_large' : 'quota_or_state' };
      return { id };
    }
  };

  /* ---------- sign-in: email + password (no emails needed, works inside the installed app) ---------- */
  const allowed = (CFG.allowedEmails || []).map(e => e.toLowerCase());
  function loginUI() {
    return new Promise(resolve => {
      const ov = document.createElement('div'); ov.className = 'dt-login'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'dtLoginT');
      ov.innerHTML = `<form class="dt-card" novalidate>
        <img src="icons/icon-192.png" alt="" width="72" height="72">
        <h1 id="dtLoginT">טיול החלומות של עידן ולורן</h1>
        <p class="dt-sub">כניסה פעם אחת בכל מכשיר. אחרי זה האפליקציה זוכרת אתכם.</p>
        <label for="dtEmail">אימייל</label><input id="dtEmail" type="email" inputmode="email" autocomplete="username" dir="ltr" required>
        <label for="dtPass">סיסמה</label><input id="dtPass" type="password" autocomplete="current-password" dir="ltr" minlength="6" required>
        <button type="submit" class="dt-btn">כניסה</button>
        <button type="button" class="dt-link" id="dtMode">פעם ראשונה? יצירת סיסמה</button>
        <p class="dt-msg" role="status" aria-live="polite"></p></form>`;
      document.body.appendChild(ov);
      const f = ov.querySelector('form'), em = ov.querySelector('#dtEmail'), pw = ov.querySelector('#dtPass'), btn = ov.querySelector('.dt-btn'), mode = ov.querySelector('#dtMode'), msg = ov.querySelector('.dt-msg');
      let signup = false; em.focus();
      mode.addEventListener('click', () => {
        signup = !signup; msg.textContent = '';
        btn.textContent = signup ? 'יצירת סיסמה וכניסה' : 'כניסה';
        mode.textContent = signup ? 'כבר יש לי סיסמה' : 'פעם ראשונה? יצירת סיסמה';
        pw.autocomplete = signup ? 'new-password' : 'current-password';
      });
      f.addEventListener('submit', async e => {
        e.preventDefault(); msg.textContent = '';
        const email = em.value.trim().toLowerCase(), password = pw.value;
        if (!email || password.length < 6) { msg.textContent = 'צריך אימייל וסיסמה של 6 תווים לפחות.'; return; }
        if (allowed.length && !allowed.includes(email)) { msg.textContent = 'המייל הזה לא ברשימת המטיילים.'; return; }
        btn.disabled = true;
        try {
          const r = signup ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
          if (r.error) throw r.error;
          if (!r.data.session) { msg.textContent = 'החשבון נוצר, אבל Supabase מבקש אישור במייל. כבו את Confirm email בהגדרות ונסו שוב.'; return; }
          ov.remove(); resolve(r.data.session);
        } catch (err) {
          console.warn(err);
          const m = String(err && err.message || '');
          msg.textContent = /already registered/i.test(m) ? 'למייל הזה כבר יש סיסמה. חזרו ל״כניסה״.' : /invalid login/i.test(m) ? 'האימייל או הסיסמה לא נכונים. פעם ראשונה? לחצו על ״יצירת סיסמה״.' : 'הכניסה נכשלה. בדקו חיבור ונסו שוב.';
        } finally { btn.disabled = false; }
      });
    });
  }
  async function session() {
    const { data } = await sb.auth.getSession();
    if (data && data.session) return data.session;
    if (!navigator.onLine) return null;
    return loginUI();
  }
  window.dtSignOut = async () => { if (sb) await sb.auth.signOut(); localStorage.removeItem(LSK.cache); localStorage.removeItem(LSK.outbox); location.reload(); };

  /* ---------- the window.claude.use shim the app already calls ---------- */
  let dbReady = null;
  window.claude = {
    async use(cap) {
      if (cap === 'downloads') return downloads;
      if (!configured) return null;
      if (cap === 'assets') { const s = await (dbReady || (dbReady = session())); return s || cache.size ? assets : null; }
      if (cap === 'db') {
        const s = await (dbReady || (dbReady = session()));
        if (!s && !cache.size) return null;
        if (s) { pullAll().then(flush).catch(e => console.warn(e)); listen(); }
        setTimeout(setStatus, 50);
        return db;
      }
      return null;
    }
  };

  /* ---------- service worker ---------- */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e)));
  }
})();
