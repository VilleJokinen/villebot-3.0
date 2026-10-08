// VilleBot panel. Plain ES2022, no deps. All dynamic text goes through textContent.
const $ = (id) => document.getElementById(id);
const LS_GUILD = 'vb_guild';
const LOOPS = ['off', 'track', 'queue'];

const S = {
  guilds: [],
  states: new Map(),
  gid: null,
  channel: null,
  results: [],
  searching: false,
  dragging: false,
  pendingRender: false,
  volDragging: false,
  ws: null,
  wsDelay: 1000,
  wsTimer: null,
};

// ---------------------------------------------------------------- utils
function fmt(sec) {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const isUrl = (v) => /^https?:\/\/\S+$/i.test(v.trim());
const state = () => S.states.get(S.gid) ?? null;
const guild = () => S.guilds.find((g) => g.id === S.gid) ?? null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function toast(msg, kind = 'error') {
  const t = el('div', `toast ${kind === 'error' ? '' : kind}`.trim(), String(msg));
  $('toasts').append(t);
  setTimeout(() => t.remove(), 6000);
  t.addEventListener('click', () => t.remove());
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    if (body !== undefined) opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, 'Network error. Is the bot reachable?');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401) {
    $('expired').hidden = false;
    throw new ApiError(401, 'Unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data;
}

/** Run an async action with the button disabled + spinner. Errors become toasts. */
async function act(btn, fn) {
  if (btn?.disabled) return;
  btn?.classList.add('busy');
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    if (e.status !== 401) toast(e.message);
  } finally {
    if (btn) { btn.classList.remove('busy'); btn.disabled = false; }
    render();
  }
}

function applyState(st) {
  if (!st || !st.guildId) return;
  S.states.set(st.guildId, st);
  if (st.guildId === S.gid) render();
}

const post = (action, body) => api('POST', `/api/guilds/${S.gid}/${action}`, body).then(applyState);

// ---------------------------------------------------------------- guilds
async function loadGuilds() {
  try {
    S.guilds = await api('GET', '/api/guilds');
  } catch (e) {
    if (e.status !== 401) toast(e.message);
    return;
  }
  let saved = null;
  try { saved = localStorage.getItem(LS_GUILD); } catch { /* ignore */ }
  if (!S.guilds.some((g) => g.id === S.gid)) {
    S.gid = S.guilds.some((g) => g.id === saved) ? saved : S.guilds[0]?.id ?? null;
  }
  renderPickers();
  render();
}

function renderPickers() {
  const gsel = $('guild');
  if (document.activeElement !== gsel) {
    gsel.replaceChildren(...S.guilds.map((g) => Object.assign(new Option(g.name, g.id), { selected: g.id === S.gid })));
  }
  $('guild-wrap').hidden = S.guilds.length <= 1;
  const csel = $('channel');
  const g = guild();
  const chans = g?.voiceChannels ?? [];
  if (document.activeElement !== csel) {
    const want = S.channel && chans.some((c) => c.id === S.channel) ? S.channel : state()?.channelId ?? chans[0]?.id ?? '';
    S.channel = want;
    csel.replaceChildren(...chans.map((c) => Object.assign(new Option(c.name, c.id), { selected: c.id === want })));
    if (!chans.length) csel.replaceChildren(new Option('No voice channels', ''));
  }
}

function selectGuild(gid) {
  S.gid = gid;
  S.channel = null;
  try { localStorage.setItem(LS_GUILD, gid); } catch { /* ignore */ }
  renderPickers();
  render();
}

// ---------------------------------------------------------------- render
let lastQueueSig = '';

function render() {
  const st = state();
  const connected = !!st?.channelId;
  // channel preselect follows the bot's channel when state changes
  if (st?.channelId && document.activeElement !== $('channel') && S.channel !== st.channelId) {
    S.channel = st.channelId;
    renderPickers();
  }
  $('join').disabled = !S.gid || !$('channel').value || $('join').classList.contains('busy');
  $('join').textContent = connected && st.channelId === $('channel').value ? 'Joined' : connected ? 'Move' : 'Join';
  $('leave').disabled = !connected || $('leave').classList.contains('busy');

  renderNowPlaying(st);
  renderQueue(st);
  updateSearchUi();
}

function setDisabled(id, v) {
  const b = $(id);
  if (!b.classList.contains('busy')) b.disabled = v;
}

function renderNowPlaying(st) {
  const cur = st?.current ?? null;
  $('np-empty').hidden = !!cur;
  $('np-body').hidden = !cur;
  const connected = !!st?.channelId;
  setDisabled('c-pause', !cur);
  setDisabled('c-skip', !cur);
  setDisabled('c-stop', !cur && !(st?.queue.length));
  setDisabled('c-loop', !connected);
  $('c-vol').disabled = !connected;
  $('c-loop').textContent = `Loop: ${st?.loop ?? 'off'}`;
  const pb = $('c-pause');
  pb.textContent = st?.paused ? '▶' : '⏸';
  pb.setAttribute('aria-label', st?.paused ? 'Resume' : 'Pause');
  if (st && !S.volDragging) {
    $('c-vol').value = st.volume;
    $('c-vol-out').textContent = st.volume;
  }
  if (cur) {
    const thumb = $('np-thumb');
    if (thumb.getAttribute('src') !== (cur.thumbnail ?? '')) {
      if (cur.thumbnail) thumb.src = cur.thumbnail; else thumb.removeAttribute('src');
    }
    const t = $('np-title');
    t.textContent = cur.title;
    t.href = cur.url;
    $('np-channel').textContent = cur.channel;
    $('np-req').textContent = `Requested by ${cur.requestedBy}`;
  }
  tick();
}

function position(st) {
  if (!st?.current) return 0;
  let p = st.positionMs + (st.paused ? 0 : Date.now() - st.sampledAt);
  if (st.current.duration != null) p = Math.min(p, st.current.duration * 1000);
  return Math.max(0, p);
}

function tick() {
  const st = state();
  const cur = st?.current;
  if (!cur) return;
  const p = position(st);
  const live = cur.duration == null;
  $('bar').classList.toggle('live', live);
  $('time').textContent = live ? `${fmt(p / 1000)} / live` : `${fmt(p / 1000)} / ${fmt(cur.duration)}`;
  $('bar-fill').style.width = live ? '100%' : `${Math.min(100, (p / (cur.duration * 1000)) * 100)}%`;
}
setInterval(tick, 500);

function renderQueue(st) {
  if (S.dragging) { S.pendingRender = true; return; }
  const q = st?.queue ?? [];
  const total = q.reduce((a, i) => a + (i.duration ?? 0), 0);
  const unknown = q.some((i) => i.duration == null);
  $('queue-meta').textContent = q.length ? `${q.length} track${q.length === 1 ? '' : 's'} · ${fmt(total)}${unknown ? '+' : ''}` : '';
  $('queue-empty').hidden = q.length > 0;
  const sig = JSON.stringify(q.map((i) => i.uid));
  if (sig === lastQueueSig && $('queue').children.length === q.length) return;
  lastQueueSig = sig;
  $('queue').replaceChildren(...q.map((item, idx) => queueRow(item, idx, q.length)));
}

function queueRow(item, idx, n) {
  const li = el('li', 'row');
  li.dataset.uid = item.uid;
  const handle = el('div', 'handle', '⠿');
  handle.setAttribute('aria-hidden', 'true');
  handle.title = 'Drag to reorder';
  handle.addEventListener('pointerdown', (e) => startDrag(e, li));
  const pos = el('div', 'pos', String(idx + 1));
  const img = thumbEl(item.thumbnail);
  const info = el('div', 'info');
  const title = el('a', 'title', item.title);
  title.href = item.url; title.target = '_blank'; title.rel = 'noopener noreferrer';
  const meta = el('div', 'meta', `${item.channel ? item.channel + ' · ' : ''}${fmt(item.duration)} · ${item.requestedBy}`);
  info.append(title, meta);
  const actions = el('div', 'actions');
  const up = iconBtn('▲', `Move ${item.title} up`, idx === 0);
  const down = iconBtn('▼', `Move ${item.title} down`, idx === n - 1);
  const rm = iconBtn('✕', `Remove ${item.title}`, false);
  rm.classList.add('danger');
  up.addEventListener('click', () => act(up, () => post('queue/move', { uid: item.uid, to: idx - 1 })));
  down.addEventListener('click', () => act(down, () => post('queue/move', { uid: item.uid, to: idx + 1 })));
  rm.addEventListener('click', () => act(rm, () => api('DELETE', `/api/guilds/${S.gid}/queue/${encodeURIComponent(item.uid)}`).then(applyState)));
  actions.append(up, down, rm);
  li.append(handle, pos, img, info, actions);
  return li;
}

function iconBtn(text, label, disabled) {
  const b = el('button', 'btn', text);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.disabled = disabled;
  return b;
}

function thumbEl(src) {
  const img = el('img', 'thumb');
  img.alt = ''; img.loading = 'lazy'; img.width = 64; img.height = 36;
  img.referrerPolicy = 'no-referrer';
  if (src) img.src = src;
  return img;
}

// ---------------------------------------------------------------- drag reorder
function startDrag(e, li) {
  if (e.button !== undefined && e.button > 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  const list = $('queue');
  const rows = [...list.children];
  const from = rows.indexOf(li);
  if (from < 0) return;
  handle.setPointerCapture(e.pointerId);
  S.dragging = true;
  li.classList.add('dragging');
  let target = from; // final index

  const clear = () => rows.forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  const move = (ev) => {
    clear();
    let idx = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { idx = i; break; }
      idx = i;
    }
    target = idx;
    if (idx !== from) rows[idx].classList.add(idx < from ? 'drop-before' : 'drop-after');
    // autoscroll near viewport edges
    if (ev.clientY < 60) window.scrollBy(0, -12);
    else if (ev.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
  };
  const end = (ev) => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    clear();
    li.classList.remove('dragging');
    S.dragging = false;
    const dropped = ev.type === 'pointerup' && target !== from;
    if (dropped) {
      post('queue/move', { uid: li.dataset.uid, to: target })
        .catch((err) => { if (err.status !== 401) toast(err.message); })
        .finally(() => { S.pendingRender = false; render(); });
    } else if (S.pendingRender) {
      S.pendingRender = false;
      render();
    }
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- search
function updateSearchUi() {
  const v = $('q').value;
  const url = isUrl(v);
  $('url-actions').hidden = !url;
  $('q-go').hidden = url;
  $('q-go').disabled = S.searching || !v.trim();
  for (const b of document.querySelectorAll('#url-actions .btn, #results .btn')) {
    if (!b.classList.contains('busy')) b.disabled = !S.gid;
  }
}

async function doSearch() {
  const q = $('q').value.trim();
  if (!q || S.searching) return;
  S.searching = true;
  $('q-go').classList.add('busy');
  setStatus('Searching…', true);
  $('results').replaceChildren();
  updateSearchUi();
  try {
    S.results = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    setStatus(S.results.length ? '' : 'No results.');
    $('results').replaceChildren(...S.results.map(resultRow));
  } catch (e) {
    setStatus('');
    if (e.status !== 401) toast(e.message);
  } finally {
    S.searching = false;
    $('q-go').classList.remove('busy');
    updateSearchUi();
  }
}

function setStatus(text, spin = false) {
  const s = $('search-status');
  s.replaceChildren();
  if (spin) s.append(el('span', 'spinner'));
  s.append(document.createTextNode(text));
}

function resultRow(r) {
  const li = el('li', 'row');
  const img = thumbEl(r.thumbnail);
  const info = el('div', 'info');
  const title = el('a', 'title', r.title);
  title.href = r.url; title.target = '_blank'; title.rel = 'noopener noreferrer';
  info.append(title, el('div', 'meta', `${r.channel} · ${fmt(r.duration)}`));
  const actions = el('div', 'actions');
  const now = el('button', 'btn primary', 'Play now'); now.type = 'button';
  const add = el('button', 'btn', 'Add to queue'); add.type = 'button';
  now.addEventListener('click', () => play(r.url, 'now', now));
  add.addEventListener('click', () => play(r.url, 'queue', add));
  actions.append(now, add);
  li.append(img, info, actions);
  return li;
}

/** POST play; on 409 auto-join the selected channel and retry once. */
async function play(input, mode, btn) {
  if (!S.gid) return;
  await act(btn, async () => {
    const attempt = () => api('POST', `/api/guilds/${S.gid}/play`, { input, mode });
    let res;
    try {
      res = await attempt();
    } catch (e) {
      if (e.status !== 409) throw e;
      const ch = $('channel').value;
      if (!ch) throw new ApiError(409, 'Join a voice channel first (pick one above and press Join).');
      applyState(await api('POST', `/api/guilds/${S.gid}/join`, { channelId: ch }));
      res = await attempt();
    }
    applyState(res.state);
    if (res.added > 1) toast(`Added ${res.added} tracks`, 'info');
  });
}

// ---------------------------------------------------------------- websocket
function setConn(stateName, text) {
  $('conn').dataset.state = stateName;
  $('conn-text').textContent = text;
}

function connectWs() {
  clearTimeout(S.wsTimer);
  if (S.ws && S.ws.readyState <= 1) return;
  setConn('connecting', 'Connecting…');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => { S.wsDelay = 1000; setConn('live', 'Live'); };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'snapshot' && Array.isArray(m.states)) {
      S.states = new Map(m.states.map((s) => [s.guildId, s]));
      render();
    } else if (m.type === 'state') {
      applyState(m.state);
    } else if (m.type === 'trackError') {
      toast(`Skipped ${m.title}: ${m.message}`);
    }
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    setConn('down', 'Reconnecting…');
    S.wsTimer = setTimeout(connectWs, S.wsDelay);
    S.wsDelay = Math.min(10000, S.wsDelay * 2);
    // a 401 upgrade looks like a plain close; check auth cheaply
    api('GET', '/api/state').catch(() => {});
  };
  ws.onerror = () => {};
}

// ---------------------------------------------------------------- events
let volTimer = null;
function sendVolume() {
  clearTimeout(volTimer);
  const v = Number($('c-vol').value);
  volTimer = setTimeout(() => {
    api('POST', `/api/guilds/${S.gid}/volume`, { volume: v }).then(applyState).catch((e) => { if (e.status !== 401) toast(e.message); });
  }, 150);
}

function bind() {
  $('guild').addEventListener('change', (e) => selectGuild(e.target.value));
  $('channel').addEventListener('change', (e) => { S.channel = e.target.value; render(); });
  for (const id of ['guild', 'channel']) {
    $(id).addEventListener('focus', loadGuilds);
    $(id).addEventListener('blur', () => { renderPickers(); });
  }
  $('join').addEventListener('click', () => act($('join'), () => post('join', { channelId: $('channel').value })));
  $('leave').addEventListener('click', () => act($('leave'), () => post('leave')));
  $('c-pause').addEventListener('click', () => act($('c-pause'), () => post(state()?.paused ? 'resume' : 'pause')));
  $('c-skip').addEventListener('click', () => act($('c-skip'), () => post('skip')));
  $('c-stop').addEventListener('click', () => act($('c-stop'), () => post('stop')));
  $('c-loop').addEventListener('click', () => {
    const cur = state()?.loop ?? 'off';
    const next = LOOPS[(LOOPS.indexOf(cur) + 1) % LOOPS.length];
    return act($('c-loop'), () => post('loop', { mode: next }));
  });
  const vol = $('c-vol');
  vol.addEventListener('pointerdown', () => { S.volDragging = true; });
  const volDone = () => { S.volDragging = false; };
  vol.addEventListener('pointerup', volDone);
  vol.addEventListener('pointercancel', volDone);
  vol.addEventListener('blur', volDone);
  vol.addEventListener('input', () => { S.volDragging = true; $('c-vol-out').textContent = vol.value; sendVolume(); });
  vol.addEventListener('change', () => { sendVolume(); setTimeout(volDone, 400); });

  $('q').addEventListener('input', updateSearchUi);
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (isUrl($('q').value)) return;
    doSearch();
  });
  $('u-now').addEventListener('click', () => play($('q').value.trim(), 'now', $('u-now')));
  $('u-queue').addEventListener('click', () => play($('q').value.trim(), 'queue', $('u-queue')));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!S.ws || S.ws.readyState > 1) { S.wsDelay = 1000; connectWs(); }
    api('GET', '/api/state').then((arr) => { S.states = new Map(arr.map((s) => [s.guildId, s])); render(); }).catch(() => {});
    tick();
  });
  window.addEventListener('online', () => { if (!S.ws || S.ws.readyState > 1) connectWs(); });
}

bind();
loadGuilds().then(() => { connectWs(); });
setInterval(() => { if (!document.hidden && !S.dragging) loadGuilds(); }, 60000);
