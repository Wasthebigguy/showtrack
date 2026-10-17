/*
 * ShowTrack — a personal TV show tracker.
 * Show data comes from the free TVmaze API (https://www.tvmaze.com/api).
 * Your library and watch history are saved in this browser (localStorage).
 */
'use strict';

const API = 'https://api.tvmaze.com';
const STORE_KEY = 'showtrack.v1';
const STALE_MS = 12 * 60 * 60 * 1000; // re-check each show for new episodes every 12 hours
const DAY = 24 * 60 * 60 * 1000;

const STATUSES = {
  watching: 'Watching',
  plan: 'Plan to watch',
  completed: 'Completed',
  stopped: 'Stopped',
};

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const $refresh = document.getElementById('refresh-btn');
const $importFile = document.getElementById('import-file');

let state = loadState();

// In-memory UI state (not saved)
const ui = {
  filter: 'all',
  sort: 'recent',
  searchQuery: '',
  searchResults: null,
  searchToken: 0,
  searchTimer: null,
  preview: {},      // full show data for shows you're looking at but haven't added
  openSeasons: {},  // showId -> Set of open season numbers
  epDetails: {},    // episodeId -> episode data from TVmaze
  openEp: null,
  summaryOpen: false,
  refreshing: false,
};

/* ================= Storage ================= */

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return { shows: d.shows || {}, watched: d.watched || {}, settings: d.settings || {} };
    }
  } catch (e) {
    console.warn('Could not read saved data', e);
  }
  return { shows: {}, watched: {}, settings: {} };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('Could not save — browser storage may be full');
  }
}

/* ================= Helpers ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const code = (ep) => `S${pad(ep.s)} E${pad(ep.n)}`;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stripHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').trim();
}

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

const airTime = (ep) => (ep && ep.air ? Date.parse(ep.air) : NaN);
const isAired = (ep) => { const t = airTime(ep); return !isNaN(t) && t <= Date.now(); };
const isWatched = (ep) => !!state.watched[ep.id];

const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const fmtDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtShort = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function daysFromToday(t) { return Math.round((startOfDay(t) - startOfDay(Date.now())) / DAY); }

function dayLabel(t) {
  const d = daysFromToday(t);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  return fmtDay.format(t);
}

function whenText(t) {
  if (isNaN(t)) return 'Date TBA';
  const d = daysFromToday(t);
  if (d === 0) return `Today, ${fmtTime.format(t)}`;
  if (d === 1) return `Tomorrow, ${fmtTime.format(t)}`;
  if (d > 1 && d < 7) return `${fmtShort.format(t)} · in ${d} days`;
  return fmtShort.format(t) + (d >= 7 && d < 60 ? ` · in ${d} days` : '');
}

function formatDuration(min) {
  if (!min) return '0h';
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = Math.round(min % 60);
  return [d && `${d}d`, h && `${h}h`, !d && m && `${m}m`].filter(Boolean).join(' ') || '0h';
}

function poster(src, name, cls) {
  return src
    ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy">`
    : `<div class="${cls} ph">${esc(initials(name))}</div>`;
}

function years(show) {
  if (!show.premiered) return '';
  const start = show.premiered.slice(0, 4);
  if (show.ended) {
    const end = show.ended.slice(0, 4);
    return end === start ? start : `${start}–${end}`;
  }
  return /running/i.test(show.showStatus) ? `${start}–` : start;
}

/* ================= TVmaze API ================= */

async function api(path, tries = 3) {
  const res = await fetch(API + path);
  if (res.status === 429 && tries > 1) { // rate limited: wait and retry
    await sleep(2500);
    return api(path, tries - 1);
  }
  if (!res.ok) throw new Error(`TVmaze returned ${res.status}`);
  return res.json();
}

const fetchFull = (id) => api(`/shows/${id}?embed[]=episodes`);

function slimShow(s) {
  const img = s.image || {};
  return {
    id: s.id,
    name: s.name,
    image: img.medium || img.original || null,
    imageLg: img.original || img.medium || null,
    network: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || '',
    genres: s.genres || [],
    premiered: s.premiered || null,
    ended: s.ended || null,
    showStatus: s.status || '',
    rating: (s.rating && s.rating.average) || null,
    runtime: s.averageRuntime || s.runtime || 0,
    summary: stripHtml(s.summary),
  };
}

function slimEp(e) {
  return {
    id: e.id,
    s: e.season,
    n: e.number,
    name: e.name || 'TBA',
    air: e.airstamp || (e.airdate ? `${e.airdate}T12:00:00` : null),
    rt: e.runtime || 0,
  };
}

function buildShow(data, prev) {
  const eps = ((data._embedded && data._embedded.episodes) || [])
    .filter((e) => e.number != null && e.season != null)
    .map(slimEp)
    .sort((a, b) => a.s - b.s || a.n - b.n);
  return {
    ...slimShow(data),
    episodes: eps,
    status: prev ? prev.status : 'watching',
    addedAt: prev ? prev.addedAt : Date.now(),
    lastWatchedAt: prev ? prev.lastWatchedAt : 0,
    updatedAt: Date.now(),
  };
}

/* ================= Library logic ================= */

function info(show) {
  let aired = 0, watched = 0, left = 0, minutes = 0, next = null, upcoming = null;
  for (const ep of show.episodes) {
    const a = isAired(ep), w = isWatched(ep);
    if (a) aired++;
    if (w) { watched++; minutes += ep.rt || show.runtime || 0; }
    if (a && !w) { left++; if (!next) next = ep; }
    if (!a && !upcoming && !isNaN(airTime(ep))) upcoming = ep;
  }
  return { total: show.episodes.length, aired, watched, left, minutes, next, upcoming };
}

async function addShow(id, status = 'watching') {
  id = Number(id);
  if (state.shows[id]) return state.shows[id];
  const data = ui.preview[id] || (await fetchFull(id));
  const show = buildShow(data, null);
  show.status = status;
  state.shows[id] = show;
  save();
  toast(`Added ${show.name} to ${STATUSES[status]}`);
  return show;
}

async function refreshShow(id) {
  const prev = state.shows[id];
  if (!prev) return;
  const data = await fetchFull(id);
  if (!state.shows[id]) return; // removed while loading
  state.shows[id] = buildShow(data, state.shows[id]);
  save();
}

async function refreshAll(force) {
  if (ui.refreshing) return;
  const ids = Object.values(state.shows)
    .filter((s) => force || Date.now() - (s.updatedAt || 0) > STALE_MS)
    .filter((s) => force || !(s.status === 'completed' && /ended/i.test(s.showStatus)))
    .map((s) => s.id);
  if (!ids.length) {
    if (force) toast(Object.keys(state.shows).length ? 'Everything is up to date' : 'Add some shows first');
    return;
  }
  ui.refreshing = true;
  $refresh.classList.add('spin');
  let done = 0, failed = 0;
  for (const id of ids) {
    try { await refreshShow(id); done++; } catch (e) { failed++; }
    await sleep(350); // stay well under TVmaze's rate limit
  }
  ui.refreshing = false;
  $refresh.classList.remove('spin');
  if (route().name !== 'search') render();
  if (force) toast(failed ? `Updated ${done}, ${failed} failed — check your connection` : `Updated ${plural(done, 'show')}`);
}

/** Marks episodes watched/unwatched. Returns true if the show just got completed. */
function setWatched(showId, epIds, on) {
  const show = state.shows[showId];
  if (!show) return false;
  const now = Date.now();
  for (const id of epIds) {
    if (on) state.watched[id] = state.watched[id] || now;
    else delete state.watched[id];
  }
  let completed = false;
  if (on) {
    show.lastWatchedAt = now;
    if (show.status === 'plan' || show.status === 'stopped') show.status = 'watching';
    const i = info(show);
    if (/ended/i.test(show.showStatus) && i.total > 0 && i.watched >= i.total && show.status !== 'completed') {
      show.status = 'completed';
      completed = true;
      toast(`🎉 You finished ${show.name}!`);
    }
  } else if (show.status === 'completed') {
    show.status = 'watching';
  }
  save();
  return completed;
}

async function getShowForEdit(showId) {
  return state.shows[showId] || (await addShow(showId, 'watching'));
}

async function watchNext(showId, epId) {
  const show = state.shows[showId];
  const ep = show && show.episodes.find((e) => e.id === epId);
  if (!ep) return;
  const completed = setWatched(showId, [epId], true);
  render();
  if (!completed) {
    toast(`Watched ${code(ep)} of ${show.name}`, () => { setWatched(showId, [epId], false); render(); });
  }
}

async function toggleEp(showId, epId) {
  const show = await getShowForEdit(showId);
  const idx = show.episodes.findIndex((e) => e.id === epId);
  const ep = show.episodes[idx];
  if (!ep || !isAired(ep)) return;
  if (isWatched(ep)) {
    setWatched(showId, [epId], false);
  } else {
    let ids = [epId];
    const earlier = show.episodes.slice(0, idx).filter((e) => isAired(e) && !isWatched(e));
    if (earlier.length && confirm(`Also mark the ${plural(earlier.length, 'earlier episode')} as watched?`)) {
      ids = ids.concat(earlier.map((e) => e.id));
    }
    setWatched(showId, ids, true);
  }
  render();
}

async function toggleSeason(showId, season) {
  const show = await getShowForEdit(showId);
  const eps = show.episodes.filter((e) => e.s === season && isAired(e));
  if (!eps.length) { toast('No episodes have aired in this season yet'); return render(); }
  const allWatched = eps.every(isWatched);
  const completed = setWatched(showId, eps.map((e) => e.id), !allWatched);
  if (!allWatched && !completed) toast(`Season ${season} marked as watched`);
  render();
}

function removeShow(id) {
  const show = state.shows[id];
  if (!show) return;
  if (!confirm(`Remove ${show.name} and its watch history?`)) return;
  for (const ep of show.episodes) delete state.watched[ep.id];
  delete state.shows[id];
  save();
  toast(`Removed ${show.name}`);
  if (route().name === 'show') location.hash = '#/shows'; else render();
}

async function toggleEpInfo(epId) {
  if (ui.openEp === epId) { ui.openEp = null; return render(); }
  ui.openEp = epId;
  if (!ui.epDetails[epId]) {
    render();
    try { ui.epDetails[epId] = await api(`/episodes/${epId}`); }
    catch (e) { ui.epDetails[epId] = { error: true }; }
  }
  if (ui.openEp === epId) render();
}

/* ================= Backup ================= */

function exportData() {
  const payload = { app: 'showtrack', version: 1, exportedAt: new Date().toISOString(), ...state };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `showtrack-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Backup downloaded');
}

async function importData(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!d || typeof d.shows !== 'object') throw new Error('bad file');
    const n = Object.keys(d.shows).length;
    if (!confirm(`Replace your current library with this backup (${plural(n, 'show')})?`)) return;
    state = { shows: d.shows, watched: d.watched || {}, settings: d.settings || {} };
    save();
    render();
    toast('Backup restored');
    refreshAll(false);
  } catch (e) {
    toast("That file isn't a ShowTrack backup");
  }
}

/* ================= Toast ================= */

let toastTimer;
function toast(msg, undo) {
  $toast.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
  if (undo) $toast.querySelector('button').onclick = () => { undo(); $toast.classList.remove('show'); };
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), undo ? 5000 : 2600);
}

/* ================= Routing ================= */

function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'watchlist', arg };
}

function render() {
  const r = route();
  const tab = r.name === 'show' ? null : r.name;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === tab));
  switch (r.name) {
    case 'upcoming': return renderUpcoming();
    case 'shows': return renderShows();
    case 'search': return renderSearch();
    case 'show': return renderShow(Number(r.arg));
    default: return renderWatchlist();
  }
}

function emptyState(title, text, href, label) {
  return `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p>${href ? `<a class="btn primary" href="${href}">${esc(label)}</a>` : ''}</div>`;
}

function section(title, count, body) {
  return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2>${count != null ? `<span class="count">${count}</span>` : ''}</div>${body}</section>`;
}

/* ================= Views: Watchlist ================= */

function renderWatchlist() {
  const shows = Object.values(state.shows);
  if (!shows.length) {
    $app.innerHTML = emptyState('Your watchlist is empty', 'Search for the shows you watch and add them here.', '#/search', 'Find shows');
    return;
  }
  const upNext = [], notStarted = [], waiting = [];
  for (const s of shows) {
    if (s.status !== 'watching' && s.status !== 'plan') continue;
    const i = info(s);
    if (i.next) (i.watched ? upNext : notStarted).push([s, i]);
    else if (s.status === 'watching') waiting.push([s, i]);
  }
  upNext.sort((a, b) => b[0].lastWatchedAt - a[0].lastWatchedAt);
  notStarted.sort((a, b) => b[0].addedAt - a[0].addedAt);
  waiting.sort((a, b) => (airTime(a[1].upcoming) || Infinity) - (airTime(b[1].upcoming) || Infinity));

  let html = '';
  if (upNext.length) html += section('Up next', upNext.length, `<div class="cards">${upNext.map(nextCard).join('')}</div>`);
  else if (!notStarted.length) html += section('Up next', null, `<div class="note">You're all caught up. 🍿</div>`);
  if (notStarted.length) html += section("Haven't started", notStarted.length, `<div class="cards">${notStarted.map(nextCard).join('')}</div>`);
  if (waiting.length) html += section('Waiting for new episodes', waiting.length, `<div class="cards">${waiting.map(waitingCard).join('')}</div>`);
  $app.innerHTML = html;
}

function nextCard([s, i]) {
  const ep = i.next;
  return `<div class="card" data-go="#/show/${s.id}">
    ${poster(s.image, s.name, 'thumb')}
    <div class="card-body">
      <div class="card-title">${esc(s.name)}</div>
      <div class="ep-code">${code(ep)}</div>
      <div class="ep-name muted">${esc(ep.name)}</div>
      <div class="bar"><span style="width:${pct(i.watched, i.aired)}%"></span></div>
      <div class="muted small">${plural(i.left, 'episode')} left</div>
    </div>
    <button class="check big" type="button" data-action="watch-next" data-show="${s.id}" data-ep="${ep.id}" aria-label="Mark ${code(ep)} watched">✓</button>
  </div>`;
}

function waitingCard([s, i]) {
  const up = i.upcoming;
  let text;
  if (up) text = `<div class="ep-code">${code(up)}</div><div class="muted small">${esc(whenText(airTime(up)))}</div>`;
  else if (/ended/i.test(s.showStatus)) text = `<div class="muted small">Show has ended</div>`;
  else text = `<div class="muted small">New episodes · date TBA</div>`;
  const extra = !up && /ended/i.test(s.showStatus)
    ? `<button class="btn sm" type="button" data-action="complete" data-show="${s.id}">Mark completed</button>` : '';
  return `<div class="card" data-go="#/show/${s.id}">
    ${poster(s.image, s.name, 'thumb')}
    <div class="card-body"><div class="card-title">${esc(s.name)}</div>${text}</div>
    ${extra}
  </div>`;
}

/* ================= Views: Upcoming ================= */

function renderUpcoming() {
  if (!Object.keys(state.shows).length) {
    $app.innerHTML = emptyState('Nothing scheduled yet', 'Add shows and their upcoming episodes will show up here.', '#/search', 'Find shows');
    return;
  }
  const shows = Object.values(state.shows).filter((s) => s.status !== 'stopped');
  const today = startOfDay(Date.now());
  const weekAgo = today - 7 * DAY;
  const future = [], recent = [];
  for (const s of shows) {
    for (const ep of s.episodes) {
      const t = airTime(ep);
      if (isNaN(t)) continue;
      if (t >= today) future.push({ s, ep, t });
      else if (t >= weekAgo) recent.push({ s, ep, t });
    }
  }
  future.sort((a, b) => a.t - b.t);
  recent.sort((a, b) => b.t - a.t);
  const tba = shows.filter((s) => !info(s).upcoming && /running|to be determined|in development/i.test(s.showStatus));

  let html = '<section class="section"><div class="section-head"><h2>Upcoming episodes</h2></div>';
  if (!future.length) {
    html += `<div class="note">No air dates announced for your shows right now.</div>`;
  } else {
    let lastDay = null;
    for (const it of future.slice(0, 250)) {
      const d = startOfDay(it.t);
      if (d !== lastDay) {
        if (lastDay !== null) html += '</div>';
        const n = daysFromToday(it.t);
        const sub = n <= 1 ? fmtShort.format(it.t) : `in ${n} days`;
        html += `<h3 class="day">${esc(dayLabel(it.t))} <span class="muted small">${esc(sub)}</span></h3><div class="list">`;
        lastDay = d;
      }
      html += upRow(it, false);
    }
    html += '</div>';
  }
  html += '</section>';

  if (recent.length) html += section('Aired this past week', recent.length, `<div class="list">${recent.map((it) => upRow(it, true)).join('')}</div>`);
  if (tba.length) {
    html += section('Coming back · date TBA', tba.length, `<div class="list">${tba.map((s) => `
      <div class="row" data-go="#/show/${s.id}">${poster(s.image, s.name, 'mini')}
        <div class="row-body"><div class="row-title">${esc(s.name)}</div><div class="muted small">${esc(s.network || s.showStatus)}</div></div>
      </div>`).join('')}</div>`);
  }
  $app.innerHTML = html;
}

function upRow({ s, ep, t }, showDate) {
  const aired = isAired(ep);
  const right = aired
    ? `<button class="check ${isWatched(ep) ? 'on' : ''}" type="button" data-action="toggle-ep" data-show="${s.id}" data-ep="${ep.id}" aria-label="Toggle watched">✓</button>`
    : `<span class="time">${esc(fmtTime.format(t))}</span>`;
  return `<div class="row" data-go="#/show/${s.id}">
    ${poster(s.image, s.name, 'mini')}
    <div class="row-body">
      <div class="row-title">${esc(s.name)}</div>
      <div class="row-sub muted small">${code(ep)} · ${esc(ep.name)}${showDate ? ` · ${esc(dayLabel(t))}` : ''}</div>
    </div>
    ${right}
  </div>`;
}

/* ================= Views: My Shows ================= */

function renderShows() {
  const all = Object.values(state.shows);
  if (!all.length) {
    $app.innerHTML = emptyState('No shows yet', 'Search for a show to start building your library.', '#/search', 'Find shows')
      + toolsHtml();
    return;
  }

  let eps = 0, minutes = 0, week = 0;
  const weekAgo = Date.now() - 7 * DAY;
  for (const s of all) {
    for (const ep of s.episodes) {
      const t = state.watched[ep.id];
      if (!t) continue;
      eps++;
      minutes += ep.rt || s.runtime || 0;
      if (t >= weekAgo) week++;
    }
  }

  const counts = { all: all.length };
  for (const k of Object.keys(STATUSES)) counts[k] = all.filter((s) => s.status === k).length;
  if (ui.filter !== 'all' && !counts[ui.filter]) ui.filter = 'all';

  let list = ui.filter === 'all' ? all : all.filter((s) => s.status === ui.filter);
  const sorters = {
    recent: (a, b) => (b.lastWatchedAt || b.addedAt) - (a.lastWatchedAt || a.addedAt),
    added: (a, b) => b.addedAt - a.addedAt,
    name: (a, b) => a.name.localeCompare(b.name),
  };
  list = list.slice().sort(sorters[ui.sort] || sorters.recent);

  const chips = [['all', 'All'], ...Object.entries(STATUSES)]
    .filter(([k]) => k === 'all' || counts[k])
    .map(([k, label]) => `<button class="chip ${ui.filter === k ? 'on' : ''}" type="button" data-action="filter" data-filter="${k}">${esc(label)} · ${counts[k]}</button>`)
    .join('');

  $app.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${all.length}</b><span>Shows</span></div>
      <div class="stat"><b>${eps.toLocaleString()}</b><span>Episodes watched</span></div>
      <div class="stat"><b>${formatDuration(minutes)}</b><span>Time watched</span></div>
      <div class="stat"><b>${week}</b><span>Watched this week</span></div>
    </div>
    <div class="toolbar">
      <div class="chips">${chips}</div>
      <select data-change="sort" aria-label="Sort shows">
        <option value="recent" ${ui.sort === 'recent' ? 'selected' : ''}>Recently watched</option>
        <option value="added" ${ui.sort === 'added' ? 'selected' : ''}>Recently added</option>
        <option value="name" ${ui.sort === 'name' ? 'selected' : ''}>A–Z</option>
      </select>
    </div>
    <div class="grid">${list.map((s) => {
      const i = info(s);
      return `<a class="tile" href="#/show/${s.id}">
        ${poster(s.image, s.name, 'poster')}
        <div class="bar"><span style="width:${pct(i.watched, i.aired)}%"></span></div>
        <div class="tile-title">${esc(s.name)}</div>
        <div class="muted small">${i.watched}/${i.aired} watched</div>
      </a>`;
    }).join('')}</div>
    ${toolsHtml()}`;
}

function toolsHtml() {
  return `<div class="tools">
      <button class="btn sm" type="button" data-action="refresh">Check for new episodes</button>
      <button class="btn sm" type="button" data-action="export">Download backup</button>
      <button class="btn sm" type="button" data-action="import">Restore backup</button>
    </div>
    <p class="credit">Your library is saved in this browser. Use backups to move it to another device.
      Show data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a> (CC BY-SA).</p>`;
}

/* ================= Views: Search ================= */

function renderSearch() {
  $app.innerHTML = `
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
      <input id="q" type="search" placeholder="Search for a show…" value="${esc(ui.searchQuery)}" autocomplete="off" enterkeyhint="search">
    </div>
    <div id="results" class="results"></div>`;
  const q = document.getElementById('q');
  q.addEventListener('input', () => {
    clearTimeout(ui.searchTimer);
    ui.searchTimer = setTimeout(() => doSearch(q.value), 350);
  });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(ui.searchTimer); doSearch(q.value); q.blur(); } });
  if (!ui.searchQuery) q.focus();
  renderResults();
}

async function doSearch(query) {
  ui.searchQuery = query;
  const token = ++ui.searchToken;
  if (!query.trim()) { ui.searchResults = null; return renderResults(); }
  const $r = document.getElementById('results');
  if ($r && !ui.searchResults) $r.innerHTML = '<div class="loading">Searching…</div>';
  try {
    const res = await api(`/search/shows?q=${encodeURIComponent(query.trim())}`);
    if (token !== ui.searchToken) return;
    ui.searchResults = res.map((r) => r.show);
  } catch (e) {
    if (token !== ui.searchToken) return;
    ui.searchResults = 'error';
  }
  renderResults();
}

function renderResults() {
  const $r = document.getElementById('results');
  if (!$r) return;
  const res = ui.searchResults;
  if (res === null) {
    $r.innerHTML = `<div class="note">Type a show name — e.g. “The Bear”, “Severance”, “Kuruluş Osman”.</div>`;
    return;
  }
  if (res === 'error') { $r.innerHTML = `<div class="note">Couldn't reach TVmaze. Check your connection and try again.</div>`; return; }
  if (!res.length) { $r.innerHTML = `<div class="note">No shows found for “${esc(ui.searchQuery)}”.</div>`; return; }
  $r.innerHTML = res.map((s) => {
    const sh = slimShow(s);
    const inLib = !!state.shows[sh.id];
    const meta = [years(sh), sh.network, sh.showStatus].filter(Boolean).join(' · ');
    return `<div class="result" data-go="#/show/${sh.id}">
      ${poster(sh.image, sh.name, 'thumb')}
      <div class="result-body">
        <div class="result-title">${esc(sh.name)}</div>
        <div class="muted small">${esc(meta)}</div>
        ${sh.genres.length ? `<div class="muted small">${esc(sh.genres.slice(0, 3).join(', '))}</div>` : ''}
      </div>
      ${inLib ? `<span class="tag">✓ Added</span>`
        : `<button class="btn primary sm" type="button" data-action="add" data-show="${sh.id}">+ Add</button>`}
    </div>`;
  }).join('');
}

/* ================= Views: Show page ================= */

function renderShow(id) {
  let show = state.shows[id];
  const inLib = !!show;
  if (!show) {
    const data = ui.preview[id];
    if (!data) {
      $app.innerHTML = '<div class="loading">Loading show…</div>';
      fetchFull(id)
        .then((d) => { ui.preview[id] = d; const r = route(); if (r.name === 'show' && Number(r.arg) === id) render(); })
        .catch(() => { $app.innerHTML = emptyState("Couldn't load this show", 'Check your connection and try again.', '#/search', 'Back to search'); });
      return;
    }
    show = buildShow(data, null);
  }

  const i = info(show);
  const seasons = new Map();
  for (const ep of show.episodes) {
    if (!seasons.has(ep.s)) seasons.set(ep.s, []);
    seasons.get(ep.s).push(ep);
  }
  if (!ui.openSeasons[id]) {
    const focus = i.next || i.upcoming || show.episodes[show.episodes.length - 1];
    ui.openSeasons[id] = new Set(focus ? [focus.s] : []);
  }
  const open = ui.openSeasons[id];

  const meta = [years(show), show.network, show.showStatus, show.runtime && `${show.runtime} min`].filter(Boolean).join(' · ');
  const genres = show.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('');
  const rating = show.rating ? `<span class="tag">★ ${show.rating}</span>` : '';

  const actions = inLib
    ? `<select data-change="status" data-show="${id}" aria-label="Status">${Object.entries(STATUSES).map(([k, v]) =>
        `<option value="${k}" ${k === show.status ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
       <button class="btn ghost danger" type="button" data-action="remove" data-show="${id}">Remove</button>`
    : `<button class="btn primary" type="button" data-action="add" data-show="${id}" data-status="watching">+ Add to Watching</button>
       <button class="btn" type="button" data-action="add" data-show="${id}" data-status="plan">Plan to watch</button>`;

  let nextAir;
  if (i.upcoming) {
    nextAir = `<div><div class="label">Next episode</div><div><b class="accent">${code(i.upcoming)}</b> · ${esc(i.upcoming.name)}</div>
      <div class="muted small">${esc(whenText(airTime(i.upcoming)))}</div></div>`;
  } else if (/ended/i.test(show.showStatus)) {
    nextAir = `<div><div class="label">Status</div><div>This show has ended</div></div>`;
  } else {
    nextAir = `<div><div class="label">Next episode</div><div>Not announced yet</div></div>`;
  }

  const seasonHtml = [...seasons.entries()].map(([sn, eps]) => {
    const airedEps = eps.filter(isAired);
    const w = eps.filter(isWatched).length;
    const all = airedEps.length > 0 && airedEps.every(isWatched);
    return `<details class="season" data-season="${sn}" ${open.has(sn) ? 'open' : ''}>
      <summary>
        <span class="chev">›</span>
        <span class="grow">Season ${sn} <span class="season-count">· ${w}/${eps.length}</span></span>
        ${airedEps.length ? `<button class="btn sm" type="button" data-action="season" data-show="${id}" data-season="${sn}">${all ? 'Unmark all' : 'Mark all'}</button>` : ''}
      </summary>
      <ul class="eps">${eps.map((ep) => epRow(show, ep)).join('')}</ul>
    </details>`;
  }).join('');

  $app.innerHTML = `
    <button class="back" type="button" data-action="back">‹ Back</button>
    <section class="hero">
      ${show.imageLg ? `<div class="hero-bg" style="background-image:url(${esc(show.imageLg)})"></div>` : ''}
      <div class="hero-inner">
        ${poster(show.image, show.name, 'poster big')}
        <div class="hero-text">
          <h1>${esc(show.name)}</h1>
          <div class="meta">${esc(meta)}</div>
          ${genres || rating ? `<div class="chips">${rating}${genres}</div>` : ''}
          <div class="actions">${actions}</div>
        </div>
      </div>
    </section>
    <div class="panel">
      <div class="progress-line"><span>${i.watched} of ${i.aired} aired episodes watched</span><span class="muted">${pct(i.watched, i.aired)}%</span></div>
      <div class="bar"><span style="width:${pct(i.watched, i.aired)}%"></span></div>
    </div>
    <div class="panel next-air">${nextAir}</div>
    ${show.summary ? `<p class="summary ${ui.summaryOpen ? '' : 'clamp'}" data-action="expand">${esc(show.summary)}</p>` : ''}
    ${seasonHtml || '<div class="note">No episodes listed yet.</div>'}`;

  $app.querySelectorAll('details.season').forEach((d) => {
    d.addEventListener('toggle', () => {
      const sn = Number(d.dataset.season);
      if (d.open) open.add(sn); else open.delete(sn);
    });
  });
}

function epRow(show, ep) {
  const aired = isAired(ep), w = isWatched(ep), t = airTime(ep);
  const date = aired ? fmtDate.format(t) : (isNaN(t) ? 'Air date TBA' : `Airs ${whenText(t)}`);
  let details = '';
  if (ui.openEp === ep.id) {
    const d = ui.epDetails[ep.id];
    if (!d) details = '<div class="ep-details muted">Loading…</div>';
    else if (d.error) details = `<div class="ep-details muted">Couldn't load episode details.</div>`;
    else {
      const img = d.image && (d.image.medium || d.image.original);
      const sum = stripHtml(d.summary) || 'No description yet.';
      details = `<div class="ep-details">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}<div>${esc(sum)}${d.runtime ? `<div class="muted small" style="margin-top:6px">${d.runtime} min</div>` : ''}</div></div>`;
    }
  }
  return `<li class="ep ${w ? 'done' : ''} ${aired ? '' : 'future'}">
    <button class="check ${w ? 'on' : ''}" type="button" data-action="toggle-ep" data-show="${show.id}" data-ep="${ep.id}" ${aired ? '' : 'disabled'} aria-label="Toggle watched">✓</button>
    <div class="ep-main" data-action="ep-info" data-ep="${ep.id}">
      <div class="ep-title"><span class="ep-num">E${pad(ep.n)}</span>${esc(ep.name)}</div>
      <div class="muted small">${esc(date)}</div>
      ${details}
    </div>
  </li>`;
}

/* ================= Events ================= */

async function handleAction(el) {
  const action = el.dataset.action;
  const showId = Number(el.dataset.show);
  const epId = Number(el.dataset.ep);
  switch (action) {
    case 'watch-next': return watchNext(showId, epId);
    case 'toggle-ep': return toggleEp(showId, epId);
    case 'season': return toggleSeason(showId, Number(el.dataset.season));
    case 'ep-info': return toggleEpInfo(epId);
    case 'add':
      el.disabled = true;
      await addShow(showId, el.dataset.status || 'watching');
      return route().name === 'search' ? renderResults() : render();
    case 'remove': return removeShow(showId);
    case 'complete':
      if (state.shows[showId]) { state.shows[showId].status = 'completed'; save(); toast('Marked as completed'); }
      return render();
    case 'filter': ui.filter = el.dataset.filter; return render();
    case 'expand': ui.summaryOpen = !ui.summaryOpen; return render();
    case 'refresh': return refreshAll(true);
    case 'export': return exportData();
    case 'import': return $importFile.click();
    case 'back':
      if (history.length > 1) history.back(); else location.hash = '#/shows';
      return;
  }
}

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (el && !el.disabled) {
    e.preventDefault();
    e.stopPropagation();
    try { await handleAction(el); }
    catch (err) {
      console.error(err);
      toast("Something went wrong — couldn't reach TVmaze");
      if (route().name === 'search') renderResults(); else render();
    }
    return;
  }
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('button, a, select')) location.hash = go.dataset.go;
});

$app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  if (el.dataset.change === 'status') {
    const show = state.shows[el.dataset.show];
    if (show) { show.status = el.value; save(); toast(`Moved to ${STATUSES[el.value]}`); render(); }
  } else if (el.dataset.change === 'sort') {
    ui.sort = el.value;
    render();
  }
});

$importFile.addEventListener('change', () => {
  const file = $importFile.files[0];
  if (file) importData(file);
  $importFile.value = '';
});

$refresh.addEventListener('click', () => refreshAll(true));

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  ui.openEp = null;
  ui.summaryOpen = false;
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (route().name !== 'search') render(); // episodes that aired while you were away become checkable
  refreshAll(false);
});

/* ================= Start ================= */

render();
refreshAll(false);

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
