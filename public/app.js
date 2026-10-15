// Goblin Notes dashboard. No framework; all text goes through DOM text nodes (never innerHTML).

const $ = (sel) => document.querySelector(sel);
const TOKEN_KEY = 'goblin-notes-token';

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------- token storage (localStorage can throw or be unavailable) ----------
let memoryToken = null;
const store = {
  get() { try { return localStorage.getItem(TOKEN_KEY) ?? memoryToken; } catch { return memoryToken; } },
  set(v) { memoryToken = v; try { localStorage.setItem(TOKEN_KEY, v); } catch {} },
  clear() { memoryToken = null; try { localStorage.removeItem(TOKEN_KEY); } catch {} },
};

// ---------- API ----------
class AuthError extends Error {}
async function api(path, { method = 'GET', body, raw = false, token = store.get() } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token ?? ''}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('unauthorized');
  if (raw) {
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return res;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- formatting ----------
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtLongDate = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const PLATFORM = { meet: 'Google Meet', zoom: 'Zoom', unknown: 'Call' };

function dayLabel(iso) {
  if (!iso) return 'Undated';
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const days = Math.round((today - that) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function clock(sinceIso) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(sinceIso)) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : String(mm)) + `:${String(ss).padStart(2, '0')}`;
}

function shortLink(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'meet.google.com') return u.pathname.slice(1);
    const id = u.pathname.match(/(\d{9,11})/)?.[1];
    return id ? `meeting ${id.replace(/(\d{3})(\d{3,4})(\d{4})/, '$1 $2 $3')}` : u.hostname;
  } catch { return url; }
}

// ---------- state ----------
const state = {
  meetings: [],
  jobs: [],
  current: null,       // meeting detail being shown
  tab: 'notes',
  filter: '',
  stopArmed: new Set(), // job ids whose "Make it leave" was clicked once
};

// ---------- sign-in ----------
function showLogin(message) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  const err = $('#login-error');
  err.hidden = !message;
  err.textContent = message ?? '';
  $('#code').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#code').value.trim();
  if (!code) return;
  try {
    await api('/api/me', { token: code });
    store.set(code);
    $('#code').value = '';
    start();
  } catch (err) {
    showLogin(err instanceof AuthError ? 'That code didn’t work. Check it and try again.' : `Couldn’t reach the server: ${err.message}`);
  }
});

$('#sign-out').addEventListener('click', () => { store.clear(); stopPolling(); showLogin(); });

// ---------- send the bot ----------
const linkInput = $('#link');
const passInput = $('#passcode');

function needsPasscode(url) {
  try {
    const u = new URL(url);
    return /(^|\.)zoom\.us$/i.test(u.hostname) && !u.searchParams.get('pwd');
  } catch { return false; }
}
linkInput.addEventListener('input', () => {
  passInput.hidden = !needsPasscode(linkInput.value.trim());
  $('#send-error').hidden = true;
});

$('#send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = linkInput.value.trim();
  const err = $('#send-error');
  const ok = /^https:\/\/(meet\.google\.com|([\w-]+\.)?zoom\.us)\//i.test(url);
  if (!ok) {
    err.textContent = 'That doesn’t look like a meeting link. Paste the full Google Meet or Zoom link, starting with https://';
    err.hidden = false;
    linkInput.focus();
    return;
  }
  const btn = $('#send-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const job = await api('/api/join', { method: 'POST', body: { url, passcode: passInput.hidden ? undefined : passInput.value.trim() || undefined } });
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
    linkInput.value = '';
    passInput.value = '';
    passInput.hidden = true;
    renderLive();
    schedulePoll(1500);
  } catch (e2) {
    if (e2 instanceof AuthError) return showLogin('Your access code was rejected. Sign in again.');
    err.textContent = e2.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send notetaker';
  }
});

// ---------- live bots ----------
const ACTIVE = new Set(['starting', 'joining', 'recording', 'transcribing', 'summarizing']);
const STATUS_TEXT = {
  starting: 'Starting up',
  joining: 'Waiting to be let in',
  recording: 'In the call',
  transcribing: 'Writing the transcript',
  summarizing: 'Writing the notes',
  done: 'Notes ready',
  failed: 'Couldn’t finish',
  stopped: 'Stopped before joining',
};

function renderLive() {
  const live = $('#live');
  const jobs = state.jobs.filter((j) => ACTIVE.has(j.status) || (j.finishedAt && Date.now() - Date.parse(j.finishedAt) < 30 * 60_000));
  live.hidden = jobs.length === 0;
  live.replaceChildren(
    ...jobs.map((j) => {
      const canStop = j.status === 'joining' || j.status === 'recording' || j.status === 'starting';
      const armed = state.stopArmed.has(j.id);
      const sub = j.status === 'failed' ? j.error : `${PLATFORM[j.platform] ?? ''}, ${shortLink(j.url)}`;
      return h('div', { class: 'bot', dataset: { status: j.status } },
        h('span', { class: 'bot-state', 'aria-hidden': 'true' }),
        h('div', { class: 'bot-main' },
          h('div', { class: 'bot-title' },
            STATUS_TEXT[j.status] ?? j.status,
            j.status === 'recording' && j.recordingSince ? h('span', { class: 'bot-clock', 'data-since': j.recordingSince }, clock(j.recordingSince)) : null),
          h('div', { class: 'bot-sub', title: sub }, sub)),
        h('div', { class: 'bot-actions' },
          canStop ? h('button', {
            class: armed ? 'btn btn-small btn-danger' : 'btn btn-small', type: 'button',
            onclick: () => stopJob(j.id),
          }, armed ? 'Leave now' : (j.status === 'recording' ? 'Make it leave' : 'Cancel')) : null,
          j.status === 'done' && j.meetingId ? h('a', { class: 'btn btn-small', href: `#/m/${encodeURIComponent(j.meetingId)}` }, 'Open notes') : null));
    }),
  );
}

async function stopJob(id) {
  if (!state.stopArmed.has(id)) {
    state.stopArmed.add(id);
    renderLive();
    setTimeout(() => { state.stopArmed.delete(id); renderLive(); }, 4000);
    return;
  }
  state.stopArmed.delete(id);
  try { await api(`/api/jobs/${id}/stop`, { method: 'POST' }); } catch (e) { if (e instanceof AuthError) return showLogin(); }
  schedulePoll(800);
}

// Tick the in-call clocks every second without re-rendering.
setInterval(() => {
  document.querySelectorAll('.bot-clock[data-since]').forEach((el) => { el.textContent = clock(el.dataset.since); });
}, 1000);

// ---------- polling ----------
let pollTimer = null;
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
function schedulePoll(ms) { stopPolling(); pollTimer = setTimeout(poll, ms); }

async function poll() {
  try {
    const before = new Map(state.jobs.map((j) => [j.id, j.status]));
    state.jobs = await api('/api/jobs');
    renderLive();
    // A bot just finished or failed: refresh the library.
    const changed = state.jobs.some((j) => before.get(j.id) && before.get(j.id) !== j.status && !ACTIVE.has(j.status));
    if (changed) await loadMeetings();
  } catch (e) {
    if (e instanceof AuthError) return showLogin('Your access code was rejected. Sign in again.');
  }
  schedulePoll(state.jobs.some((j) => ACTIVE.has(j.status)) ? 3000 : 20000);
}

// ---------- meetings list ----------
async function loadMeetings() {
  state.meetings = await api('/api/meetings');
  renderList();
}

function matches(m, q) {
  if (!q) return true;
  return `${m.title} ${m.tldr ?? ''} ${m.participants.join(' ')}`.toLowerCase().includes(q);
}

function renderList() {
  const list = $('#meeting-list');
  const q = state.filter.toLowerCase();
  const items = state.meetings.filter((m) => matches(m, q));
  if (!state.meetings.length) {
    list.replaceChildren(h('p', { class: 'list-empty' }, 'Nothing here yet. Send the notetaker to a call and its notes will appear here when the call ends.'));
    return;
  }
  if (!items.length) {
    list.replaceChildren(h('p', { class: 'list-empty' }, `No meetings match “${state.filter}”.`));
    return;
  }
  const nodes = [];
  let lastDay = null;
  for (const m of items) {
    const day = dayLabel(m.startedAt);
    if (day !== lastDay) { nodes.push(h('h3', { class: 'day' }, day)); lastDay = day; }
    const current = state.current?.id === m.id;
    nodes.push(h('a', { class: 'meeting-link', href: `#/m/${encodeURIComponent(m.id)}`, 'aria-current': current ? 'page' : null },
      h('span', { class: 'meeting-title' }, m.title),
      h('span', { class: 'meeting-meta' },
        m.startedAt ? h('span', {}, fmtTime(m.startedAt)) : null,
        m.durationMin ? h('span', {}, `${m.durationMin} min`) : null,
        h('span', {}, PLATFORM[m.platform] ?? ''),
        m.status === 'failed' ? h('span', { class: 'tag tag-failed' }, 'Failed') : null,
        m.status === 'in-progress' ? h('span', { class: 'tag tag-progress' }, 'In progress') : null),
      m.tldr ? h('span', { class: 'meeting-tldr' }, stripInline(m.tldr)) : null));
  }
  list.replaceChildren(...nodes);
}

$('#filter').addEventListener('input', (e) => { state.filter = e.target.value.trim(); renderList(); });

// ---------- markdown (safe subset → DOM) ----------
const stripInline = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1');

function inline(text) {
  // **bold**, `code`, and [hh:mm:ss] timestamps that jump to the transcript.
  const out = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[(\d{2}:\d{2}:\d{2})\]/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(h('strong', {}, m[1]));
    else if (m[2] != null) out.push(h('code', {}, m[2]));
    else {
      const time = m[3]; // capture now; `m` is reused by the loop
      out.push(h('button', { class: 'ts', type: 'button', title: 'Show in transcript', onclick: () => jumpTo(time) }, time));
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(md) {
  const root = h('div', { class: 'notes' });
  let list = null;
  let section = '';
  const para = [];
  const flushPara = () => {
    if (!para.length) return;
    root.append(h('p', { class: section === 'tl;dr' ? 'tldr' : null }, inline(para.join(' '))));
    para.length = 0;
  };
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trimEnd();
    let m;
    if ((m = line.match(/^#{1,3}\s+(.*)/))) {
      flushPara(); list = null;
      section = m[1].trim().toLowerCase();
      root.append(h('h2', {}, m[1]));
    } else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)/))) {
      flushPara();
      if (!list) { list = h('ul'); root.append(list); }
      const done = m[1].toLowerCase() === 'x';
      list.append(h('li', { class: 'task' }, h('span', { class: done ? 'box done' : 'box', role: 'img', 'aria-label': done ? 'Done' : 'To do' }), h('span', {}, inline(m[2]))));
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      flushPara();
      if (!list) { list = h('ul'); root.append(list); }
      list.append(h('li', {}, inline(m[1])));
    } else if (!line.trim()) {
      flushPara(); list = null;
    } else {
      list = null;
      para.push(line.trim());
    }
  }
  flushPara();
  return root;
}

// ---------- transcript ----------
function parseTranscript(text) {
  return text.split('\n').map((line) => {
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+([^:]{1,40}):\s?(.*)$/);
    return m ? { time: m[1], who: m[2], text: m[3] } : line.trim() ? { time: '', who: '', text: line } : null;
  }).filter(Boolean);
}

function highlight(text, q) {
  if (!q) return [text];
  const out = [];
  const lower = text.toLowerCase();
  let i = 0, j;
  while ((j = lower.indexOf(q, i)) !== -1) {
    if (j > i) out.push(text.slice(i, j));
    out.push(h('mark', {}, text.slice(j, j + q.length)));
    i = j + q.length;
  }
  out.push(text.slice(i));
  return out;
}

function renderTranscript(text) {
  const turns = parseTranscript(text);
  const speakers = [...new Set(turns.map((t) => t.who).filter(Boolean))];
  const wrap = h('div', {});
  const count = h('span', { class: 'transcript-count', 'aria-live': 'polite' });
  const listEl = h('div', { class: 'turns' });
  const search = h('input', { type: 'search', placeholder: 'Find in transcript', 'aria-label': 'Find in transcript' });

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = q ? turns.filter((t) => t.text.toLowerCase().includes(q) || t.who.toLowerCase().includes(q)) : turns;
    count.textContent = q ? `${shown.length} of ${turns.length} lines` : `${turns.length} lines, ${speakers.length} speaker${speakers.length === 1 ? '' : 's'}`;
    listEl.replaceChildren(...shown.map((t) =>
      h('div', { class: 'turn', 'data-time': t.time },
        h('div', { class: 'turn-time' }, t.time),
        h('div', {},
          t.who ? h('div', { class: `turn-who spk-${speakers.indexOf(t.who) % 6}` }, t.who) : null,
          h('p', { class: 'turn-text' }, highlight(t.text, q))))));
  };
  search.addEventListener('input', draw);
  draw();
  wrap.append(h('div', { class: 'transcript-tools' }, search, count), listEl);
  return wrap;
}

function jumpTo(time) {
  state.tab = 'transcript';
  renderDetail();
  const target = [...document.querySelectorAll('.turn[data-time]')].find((el) => el.dataset.time >= time);
  if (target) {
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1600);
  }
}

// ---------- downloads (need the auth header, so fetch → blob) ----------
async function download(id, file) {
  try {
    const res = await api(`/api/meetings/${encodeURIComponent(id)}/${file}`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: `${id}-${file}` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) {
    if (e instanceof AuthError) return showLogin();
    alert(e.message);
  }
}

async function loadAudio(id, slot) {
  slot.replaceChildren(h('span', { class: 'hint' }, 'Loading audio…'));
  try {
    const res = await api(`/api/meetings/${encodeURIComponent(id)}/audio.webm`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    slot.replaceChildren(h('audio', { controls: true, src: url, preload: 'metadata' }));
  } catch (e) {
    slot.replaceChildren(h('span', { class: 'field-error' }, `Couldn’t load the audio: ${e.message}`));
  }
}

async function copyNotes(m, btn) {
  try {
    await navigator.clipboard.writeText(`# ${m.title}\n\n${m.summary ?? ''}`);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Copy notes'; }, 1800);
}

async function retry(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    await api(`/api/meetings/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    await Promise.all([loadMeetings(), route()]);
  } catch (e) {
    if (e instanceof AuthError) return showLogin();
    btn.disabled = false;
    btn.textContent = 'Try again';
    alert(e.message);
  }
}

// While an open meeting is still being written, re-check it every few seconds.
let detailTimer = null;
function watchCurrent() {
  clearTimeout(detailTimer);
  if (state.current?.status !== 'in-progress') return;
  detailTimer = setTimeout(async () => {
    const id = state.current?.id;
    if (!id) return;
    try {
      const fresh = await api(`/api/meetings/${encodeURIComponent(id)}`);
      if (state.current?.id !== id) return;
      if (fresh.status !== 'in-progress') { state.current = fresh; renderDetail(); await loadMeetings(); }
      watchCurrent();
    } catch { /* try again on the next tick */ watchCurrent(); }
  }, 5000);
}

const minutes = (n) => `${n} minute${n === 1 ? '' : 's'}`;

// ---------- detail ----------
function renderEmptyDetail() {
  $('#detail').replaceChildren(h('div', { class: 'empty' },
    h('h2', {}, state.meetings.length ? 'Pick a meeting' : 'No notes yet'),
    h('p', {}, state.meetings.length
      ? 'Choose a meeting on the left to read its notes and transcript.'
      : 'Paste a Google Meet or Zoom link above. The notetaker joins, listens, and the notes show up here a minute or two after the call ends.')));
}

function renderDetail() {
  const m = state.current;
  const el = $('#detail');
  if (!m) return renderEmptyDetail();

  const audioSlot = h('div', { class: 'audio-wrap' });
  const tab = (id, label) => h('button', {
    class: 'tab', type: 'button', role: 'tab', 'aria-selected': state.tab === id ? 'true' : 'false',
    onclick: () => { state.tab = id; renderDetail(); },
  }, label);

  let body;
  if (m.status === 'failed') {
    body = h('div', {},
      h('div', { class: 'problem', role: 'status' }, h('strong', {}, 'The notes couldn’t be written.'), m.error ?? 'Unknown error.'),
      m.hasAudio
        ? h('p', { class: 'retry' },
            h('button', { class: 'btn btn-primary', type: 'button', onclick: (e) => retry(m.id, e.currentTarget) }, 'Try again'),
            h('span', { class: 'hint' }, 'The recording was kept, so this re-runs the transcript and notes without rejoining the call.'))
        : h('p', { class: 'hint' }, 'No recording was saved, so there’s nothing to retry.'));
  } else if (m.status === 'in-progress') {
    body = h('div', { class: 'empty' }, h('h2', {}, 'Still working on this one'), h('p', {}, 'The notetaker is in the call or writing the notes. This page updates when they’re ready.'));
  } else if (state.tab === 'transcript') {
    body = m.transcript ? renderTranscript(m.transcript) : h('p', { class: 'hint' }, 'No transcript was saved for this meeting.');
  } else {
    body = renderMarkdown(m.summary ?? '');
  }

  const copyBtn = h('button', { class: 'btn btn-small', type: 'button', onclick: (e) => copyNotes(m, e.currentTarget) }, 'Copy notes');

  // replaceChildren() would print null as the text "null", so drop empty slots first.
  const parts = [
    h('a', { class: 'back btn btn-quiet', href: '#/' }, 'All meetings'),
    h('h1', {}, m.title),
    h('div', { class: 'detail-meta' },
      m.startedAt ? h('span', {}, `${fmtLongDate(m.startedAt)} at ${fmtTime(m.startedAt)}`) : null,
      m.durationMin ? h('span', {}, minutes(m.durationMin)) : null,
      h('span', {}, PLATFORM[m.platform] ?? '')),
    m.participants.length ? h('div', { class: 'detail-people' }, `Seen on screen: ${m.participants.join(', ')}`) : null,
    m.status === 'ready'
      ? h('div', { class: 'detail-bar' },
          h('div', { class: 'tabs', role: 'tablist' }, tab('notes', 'Notes'), tab('transcript', 'Transcript')),
          h('div', { class: 'downloads' },
            copyBtn,
            h('button', { class: 'btn btn-small', type: 'button', onclick: () => download(m.id, 'summary.md') }, 'Notes (.md)'),
            m.transcript ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => download(m.id, 'transcript.txt') }, 'Transcript (.txt)') : null,
            m.hasAudio ? h('button', { class: 'btn btn-small', type: 'button', onclick: () => loadAudio(m.id, audioSlot) }, 'Play recording') : null))
      : null,
    audioSlot,
    body,
  ];
  el.replaceChildren(...parts.filter((p) => p != null && p !== false));
  watchCurrent();
}

// ---------- routing: #/ and #/m/<id> ----------
async function route() {
  const id = decodeURIComponent(location.hash.match(/^#\/m\/(.+)$/)?.[1] ?? '');
  const shell = $('#app');
  const narrow = matchMedia('(max-width: 860px)').matches;

  if (!id) {
    shell.dataset.view = 'list';
    // On wide screens, open the newest meeting so the right side isn't empty.
    if (!narrow && state.meetings[0]) {
      history.replaceState(null, '', `#/m/${encodeURIComponent(state.meetings[0].id)}`);
      return route();
    }
    state.current = null;
    renderDetail();
    renderList();
    return;
  }

  shell.dataset.view = 'detail';
  if (state.current?.id !== id) state.tab = 'notes';
  try {
    state.current = await api(`/api/meetings/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof AuthError) return showLogin('Your access code was rejected. Sign in again.');
    state.current = null;
    $('#detail').replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Meeting not found'), h('p', {}, 'It may have been deleted from the server. '), h('a', { href: '#/' }, 'Back to all meetings')));
    renderList();
    return;
  }
  renderDetail();
  renderList();
  if (narrow) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------- boot ----------
async function start() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  try {
    await Promise.all([loadMeetings(), poll()]);
    await route();
  } catch (e) {
    if (e instanceof AuthError) showLogin();
  }
}

if (store.get()) {
  api('/api/me').then(start, (e) => showLogin(e instanceof AuthError ? null : `Couldn’t reach the server: ${e.message}`));
} else {
  showLogin();
}
