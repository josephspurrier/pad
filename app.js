// Pad: a modern take on https://github.com/timbl/pad for Inrupt PodSpaces.
//
// Data model (same as Tim's original): pad.ttl holds a circular linked list
//   <#thisPad> pad:next <#c1> . <#c1> sioc:content "..." ; pad:next <#c2> . ... <#cN> pad:next <#thisPad> .
// Every edit is a small SPARQL Update PATCH. Changes arrive live over Inrupt's
// websocket notifications. Only the WebID in <#thisPad> dc:author may edit.
(async () => {
  'use strict';

  const auth = window.solidClientAuthentication;
  const NS = {
    pad: 'http://www.w3.org/ns/pim/pad#',
    sioc: 'http://rdfs.org/sioc/ns#',
    dc: 'http://purl.org/dc/elements/1.1/',
  };
  const NEXT = NS.pad + 'next';
  const CONTENT = NS.sioc + 'content';
  const AUTHOR = NS.dc + 'author';
  const ISSUER = 'https://login.inrupt.com';

  // Inrupt serves Pod-hosted HTML with `CSP: sandbox allow-scripts` (opaque origin,
  // no storage, no popups) and treats `?code=` redirects as unknown resources, so
  // login cannot work from a Pod page. The Pod copy is a read-only viewer whose
  // "Edit" button goes to the same app on GitHub Pages (EDITOR_URL). The pad data
  // always lives in the Pod; only the code is served from github.io.
  const DEFAULT_PAD = 'https://storage.inrupt.com/4349e8a1-e942-493f-acef-bb310f18b068/pad/pad.ttl';
  const EDITOR_URL = 'https://josephspurrier.github.io/pad/';
  const sandboxed = (() => { try { return !window.localStorage; } catch { return true; } })();

  const params = new URLSearchParams(location.search);
  // ?pad= survives the login round trip via sessionStorage (redirect URI must be exact)
  let padParam = params.get('pad');
  if (!sandboxed) {
    if (padParam) sessionStorage.setItem('pad', padParam);
    else if (params.get('code')) padParam = sessionStorage.getItem('pad');
  }
  const inPod = location.origin === new URL(DEFAULT_PAD).origin;
  const DOC = padParam || (inPod ? new URL('pad.ttl', location.href).href : DEFAULT_PAD);
  const SUBJ = DOC + '#thisPad';
  const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');
  const appUrl = REDIRECT + (padParam ? `?pad=${encodeURIComponent(padParam)}` : '');
  // Static Client ID Document when served from GitHub Pages; dynamic registration elsewhere (localhost)
  const CLIENT_ID = REDIRECT === EDITOR_URL ? EDITOR_URL + 'client.jsonld' : undefined;

  const $ = (id) => document.getElementById(id);
  const padEl = $('pad');
  const msg = (t) => { $('msg').textContent = t || ''; };

  let me = null;
  let canEdit = false;
  let state = { order: [], next: new Map(), content: new Map(), author: null };
  const dirty = new Map(); // chunk IRI -> debounce timer
  let queue = Promise.resolve(); // serializes PATCHes
  let version = 0; // bumps on every local edit

  // ---------- auth ----------
  const authBtn = $('auth');
  authBtn.hidden = false;
  if (sandboxed) {
    authBtn.textContent = 'Edit';
    authBtn.title = 'Pages hosted in a Pod cannot log in; opens the editor';
    // sandbox blocks popups, but a page may still navigate itself
    authBtn.onclick = () => location.assign(`${EDITOR_URL}?pad=${encodeURIComponent(DOC)}`);
  } else {
    try {
      await auth.handleIncomingRedirect({ url: location.href, restorePreviousSession: true });
    } catch (e) {
      console.warn('login restore failed', e);
    }
    const info = auth.getDefaultSession().info;
    if (info.isLoggedIn) me = info.webId;
    if (location.href !== appUrl) history.replaceState(null, '', appUrl);
    authBtn.textContent = me ? 'Log out' : 'Log in';
    authBtn.onclick = async () => {
      try {
        if (me) { await auth.logout(); location.replace(appUrl); return; }
        await auth.login({ oidcIssuer: ISSUER, redirectUrl: REDIRECT, clientName: 'Pad', ...(CLIENT_ID && { clientId: CLIENT_ID }) });
      } catch (e) {
        msg('Login failed: ' + e.message);
      }
    };
  }
  const rdfFetch = (...a) => (me ? auth.fetch(...a) : fetch(...a));

  // ---------- RDF helpers ----------
  const iri = (u) => `<${u}>`;
  const lit = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
  const triples = (ts) => ts.map(([s, p, o]) => `  ${iri(s)} ${iri(p)} ${o} .`).join('\n');

  async function load() {
    const r = await rdfFetch(DOC, { headers: { Accept: 'text/turtle' }, cache: 'no-store' });
    if (!r.ok) throw new Error(`Could not read pad.ttl (HTTP ${r.status})`);
    const quads = new N3.Parser({ baseIRI: DOC }).parse(await r.text());
    const next = new Map();
    const content = new Map();
    let author = null;
    for (const q of quads) {
      const s = q.subject.value, p = q.predicate.value, o = q.object.value;
      if (p === NEXT) {
        if (next.has(s)) console.warn('chunk has two pad:next links', s);
        next.set(s, o);
      } else if (p === CONTENT) content.set(s, o);
      else if (p === AUTHOR && s === SUBJ) author = o;
    }
    const order = [];
    const seen = new Set([SUBJ]);
    let c = next.get(SUBJ);
    while (c && !seen.has(c)) { order.push(c); seen.add(c); c = next.get(c); }
    if (c !== SUBJ) console.warn('pad list is not closed at', c);
    return { order, next, content, author };
  }

  function patch(del, ins, where) {
    const body = del.length
      ? `DELETE {\n${triples(del)}\n} INSERT {\n${triples(ins)}\n} WHERE {\n${where}\n}`
      : `INSERT DATA {\n${triples(ins)}\n}`;
    queue = queue.then(async () => {
      const r = await auth.fetch(DOC, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/sparql-update' },
        body,
      });
      if (!r.ok) throw new Error(`save failed (HTTP ${r.status})`);
      scheduleRefresh(1500); // reconcile in case a WHERE did not match
    }).catch((e) => { msg(e.message + ', reloading'); version++; scheduleRefresh(0); });
    return queue;
  }

  // ---------- rendering ----------
  const elFor = (id) => padEl.querySelector(`[data-id="${CSS.escape(id)}"]`);

  function makeChunk(id) {
    const el = document.createElement('div');
    el.className = 'chunk';
    el.dataset.id = id;
    if (canEdit) {
      el.contentEditable = 'plaintext-only';
      if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
      el.addEventListener('input', () => onInput(el));
      el.addEventListener('keydown', (e) => onKey(e, el));
      el.addEventListener('blur', () => { if (dirty.has(id)) saveContent(id); });
    }
    return el;
  }

  function render() {
    const existing = new Map([...padEl.children].map((el) => [el.dataset.id, el]));
    let prev = null;
    for (const id of state.order) {
      const el = existing.get(id) || makeChunk(id);
      existing.delete(id);
      const text = state.content.get(id) ?? '';
      if (!dirty.has(id) && el.textContent !== text) {
        const focused = document.activeElement === el;
        const off = focused ? caretOffset(el) : 0;
        el.textContent = text;
        if (focused) setCaret(el, off);
      }
      const want = prev ? prev.nextSibling : padEl.firstChild;
      if (want !== el) padEl.insertBefore(el, want);
      prev = el;
    }
    for (const el of existing.values()) el.remove();
  }

  function caretOffset(el) {
    const sel = getSelection();
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) return el.textContent.length;
    const r = sel.getRangeAt(0);
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length;
  }

  function setCaret(el, off) {
    el.focus();
    el.normalize();
    const r = document.createRange();
    const n = el.firstChild;
    if (n && n.nodeType === Node.TEXT_NODE) r.setStart(n, Math.min(off, n.length));
    else r.setStart(el, 0);
    r.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // ---------- editing ----------
  function onInput(el) {
    const id = el.dataset.id;
    clearTimeout(dirty.get(id));
    el.classList.add('dirty');
    dirty.set(id, setTimeout(() => saveContent(id), 500));
    version++;
  }

  function takeText(id) { // cancel pending save, return current text of the line
    clearTimeout(dirty.get(id));
    dirty.delete(id);
    const el = elFor(id);
    if (el) el.classList.remove('dirty');
    return el ? el.textContent : (state.content.get(id) ?? '');
  }

  function saveContent(id) {
    const text = takeText(id);
    if (text === (state.content.get(id) ?? '')) return queue;
    state.content.set(id, text);
    version++;
    return patch(
      [[id, CONTENT, '?o']],
      [[id, CONTENT, lit(text)]],
      `  OPTIONAL { ${iri(id)} ${iri(CONTENT)} ?o . }`,
    );
  }

  const newId = () => `${DOC}#c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function split(id, off) {
    const text = takeText(id);
    const before = text.slice(0, off);
    const after = text.slice(off);
    const nid = newId();
    const oldNext = state.next.get(id);
    state.content.set(id, before);
    state.content.set(nid, after);
    state.next.set(id, nid);
    state.next.set(nid, oldNext);
    state.order.splice(state.order.indexOf(id) + 1, 0, nid);
    version++;
    elFor(id).textContent = before;
    render();
    setCaret(elFor(nid), 0);
    patch(
      [[id, NEXT, iri(oldNext)], [id, CONTENT, '?o']],
      [[id, NEXT, iri(nid)], [id, CONTENT, lit(before)],
        [nid, NEXT, iri(oldNext)], [nid, CONTENT, lit(after)], [nid, AUTHOR, iri(me)]],
      `  ${iri(id)} ${iri(NEXT)} ${iri(oldNext)} .\n  OPTIONAL { ${iri(id)} ${iri(CONTENT)} ?o . }`,
    );
  }

  function merge(pid, id) { // join line `id` onto the end of line `pid` (its predecessor)
    const ptext = takeText(pid);
    const text = takeText(id);
    const merged = ptext + text;
    const nxt = state.next.get(id);
    state.content.set(pid, merged);
    state.next.set(pid, nxt);
    state.content.delete(id);
    state.next.delete(id);
    state.order.splice(state.order.indexOf(id), 1);
    version++;
    render();
    setCaret(elFor(pid), ptext.length);
    patch(
      [[pid, NEXT, iri(id)], [pid, CONTENT, '?p'],
        [id, NEXT, iri(nxt)], [id, CONTENT, '?c'], [id, AUTHOR, '?a']],
      [[pid, NEXT, iri(nxt)], [pid, CONTENT, lit(merged)]],
      `  ${iri(pid)} ${iri(NEXT)} ${iri(id)} .\n  ${iri(id)} ${iri(NEXT)} ${iri(nxt)} .\n` +
      `  OPTIONAL { ${iri(pid)} ${iri(CONTENT)} ?p . }\n` +
      `  OPTIONAL { ${iri(id)} ${iri(CONTENT)} ?c . }\n` +
      `  OPTIONAL { ${iri(id)} ${iri(AUTHOR)} ?a . }`,
    );
  }

  function onKey(e, el) {
    const id = el.dataset.id;
    const idx = state.order.indexOf(id);
    const sel = getSelection();
    const collapsed = sel.rangeCount && sel.getRangeAt(0).collapsed;
    const off = caretOffset(el);
    const text = el.textContent;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      split(id, off);
    } else if (e.key === 'Backspace' && collapsed && off === 0 && idx > 0) {
      e.preventDefault();
      merge(state.order[idx - 1], id);
    } else if (e.key === 'Delete' && collapsed && off === text.length && idx < state.order.length - 1) {
      e.preventDefault();
      merge(id, state.order[idx + 1]);
    } else if (e.key === 'ArrowUp' && idx > 0 && !text.slice(0, off).includes('\n')) {
      e.preventDefault();
      setCaret(elFor(state.order[idx - 1]), off);
    } else if (e.key === 'ArrowDown' && idx < state.order.length - 1 && !text.slice(off).includes('\n')) {
      e.preventDefault();
      setCaret(elFor(state.order[idx + 1]), off);
    }
  }

  // ---------- sync ----------
  let refreshTimer;
  function scheduleRefresh(ms) { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, ms); }

  async function refresh() {
    await queue;
    const v = version;
    try {
      const s = await load();
      if (v !== version) { scheduleRefresh(800); return; } // local edit raced the fetch
      state = s;
      render();
      msg('');
    } catch (e) {
      msg(e.message);
    }
  }

  async function subscribe() {
    const live = $('live');
    try {
      let gateway = 'https://notification.inrupt.com/';
      const wk = await fetch(new URL('/.well-known/solid', DOC), { headers: { Accept: 'text/turtle' } });
      const m = wk.ok && (await wk.text()).match(/notificationGateway>?\s+<([^>]+)>/);
      if (m) gateway = m[1];
      const g = await (await fetch(gateway, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocols: ['ws'], features: [] }),
      })).json();
      // Anonymous subscription works because pad.ttl is publicly readable.
      const s = await (await fetch(g.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: DOC, protocol: 'ws', features: [] }),
      })).json();
      const ws = new WebSocket(s.endpoint, s.subprotocol || 'solid-0.2');
      ws.onopen = () => { live.textContent = 'live'; live.classList.add('on'); };
      ws.onmessage = () => scheduleRefresh(250);
      ws.onclose = () => {
        live.textContent = 'reconnecting';
        live.classList.remove('on');
        setTimeout(subscribe, 5000);
      };
    } catch (e) {
      console.warn('live updates unavailable', e);
      live.textContent = 'polling';
      live.classList.remove('on');
      setTimeout(subscribe, 30000);
    }
  }

  // ---------- start ----------
  try {
    state = await load();
  } catch (e) {
    msg(e.message);
  }
  canEdit = Boolean(me && state.author && me === state.author);
  $('who').textContent = !me ? 'viewing as public'
    : canEdit ? `editing as ${me}` : `logged in as ${me} (read-only)`;
  $('hint').hidden = !canEdit;
  render();

  if (canEdit && state.order.length === 0) { // empty pad: create the first line
    const nid = newId();
    const first = state.next.get(SUBJ);
    state.order = [nid];
    state.next.set(SUBJ, nid);
    state.next.set(nid, SUBJ);
    state.content.set(nid, '');
    render();
    setCaret(elFor(nid), 0);
    patch(
      first ? [[SUBJ, NEXT, iri(first)]] : [],
      [[SUBJ, NEXT, iri(nid)], [nid, NEXT, iri(SUBJ)], [nid, CONTENT, lit('')], [nid, AUTHOR, iri(me)]],
      first ? `  ${iri(SUBJ)} ${iri(NEXT)} ${iri(first)} .` : '',
    );
  }

  subscribe();
  setInterval(() => scheduleRefresh(0), 60000); // safety net if a notification is missed
})();
