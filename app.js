/*
 * ShowTrack — a personal TV show & movie tracker.
 *  - Shows: TVmaze API (https://www.tvmaze.com/api), no key needed
 *  - Movies: TMDB API (https://www.themoviedb.org), free API key entered in Settings
 *  - Sync: a private GitHub Gist in your own account (personal access token with the "gist" scope)
 * Everything is also saved in this browser (localStorage), so the app works offline.
 */
'use strict';

const TVMAZE = 'https://api.tvmaze.com';
const TMDB = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/';
const GITHUB = 'https://api.github.com';
const STORE_KEY = 'showtrack.v1';
const SYNC_KEY = 'showtrack.sync';
const GIST_FILE = 'showtrack-data.json';
const DAY = 24 * 60 * 60 * 1000;
const STALE_MS = 12 * 60 * 60 * 1000;   // re-check each show for new episodes every 12h
const MOVIE_STALE_MS = 3 * DAY;         // re-check release dates of movies on your list
const SYNC_EVERY_MS = 2 * 60 * 1000;    // pull changes from other devices every 2 min while open
const PUSH_DELAY_MS = 2500;             // wait this long after a change before uploading

const STATUSES = { watching: 'Watching', plan: 'Plan to watch', completed: 'Completed', stopped: 'Stopped' };
const MOVIE_STATUSES = { want: 'Want to watch', watched: 'Watched' };

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const $refresh = document.getElementById('refresh-btn');
const $settingsBtn = document.getElementById('settings-btn');
const $importFile = document.getElementById('import-file');

let state = loadState();
let sync = loadSync();

// In-memory UI state (not saved)
const ui = {
  filter: 'all', sort: 'recent',
  movieFilter: 'want', movieSort: 'recent',
  searchType: 'shows', searchQuery: '', searchResults: null, resultsType: null, searchToken: 0, searchTimer: null,
  preview: {}, moviePreview: {},
  openSeasons: {}, epDetails: {}, openEp: null, summaryOpen: false,
  refreshing: false, syncing: false, syncAgain: false, pushTimer: null,
};

/* ================= Storage ================= */

function normalizeState(d) {
  d = d || {};
  const s = { shows: d.shows || {}, watched: d.watched || {}, movies: d.movies || {}, settings: d.settings || {} };
  for (const sh of Object.values(s.shows)) {
    if (!Array.isArray(sh.episodes)) sh.episodes = [];
    if (!sh.mod) sh.mod = sh.addedAt || 0;
    if (!sh.status) sh.status = 'watching';
    if (sh.updatedAt == null) sh.updatedAt = 0;
  }
  for (const m of Object.values(s.movies)) if (!m.mod) m.mod = m.addedAt || 0;
  return s;
}

function loadState() {
  try { return normalizeState(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); }
  catch (e) { console.warn('Could not read saved data', e); return normalizeState(null); }
}

/** Save locally only (used for data refreshed from TVmaze/TMDB or merged from sync). */
function saveLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Could not save — browser storage may be full'); }
}

/** Save a change you made, and upload it to your other devices. */
function save() {
  saveLocal();
  schedulePush();
}

function loadSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null') || {}; } catch (e) { return {}; }
}
function saveSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) { /* ignore */ }
}

const libShows = () => Object.values(state.shows).filter((s) => !s.removed);
const libMovies = () => Object.values(state.movies).filter((m) => !m.removed);
const getShow = (id) => { const s = state.shows[id]; return s && !s.removed ? s : null; };
const getMovie = (id) => { const m = state.movies[id]; return m && !m.removed ? m : null; };

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

/** JSON with sorted keys, so two copies of the same data compare equal. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

const airTime = (ep) => (ep && ep.air ? Date.parse(ep.air) : NaN);
const isAired = (ep) => { const t = airTime(ep); return !isNaN(t) && t <= Date.now(); };
// watched[id] > 0 → watched at that time; < 0 → un-watched at that time (kept so sync knows)
const isWatched = (ep) => (state.watched[ep.id] || 0) > 0;
const releaseTime = (m) => (m && m.release ? Date.parse(`${m.release}T00:00:00`) : NaN);

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
  if (d > 1 && d < 60) return `${fmtShort.format(t)} · in ${d} days`;
  return fmtDate.format(t);
}

function agoText(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate.format(t);
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

/* ================= TVmaze (shows) ================= */

async function tvmaze(path, tries = 3) {
  const res = await fetch(TVMAZE + path);
  if (res.status === 429 && tries > 1) { await sleep(2500); return tvmaze(path, tries - 1); }
  if (!res.ok) throw new Error(`TVmaze returned ${res.status}`);
  return res.json();
}

const fetchFull = (id) => tvmaze(`/shows/${id}?embed[]=episodes`);

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
  return { id: e.id, s: e.season, n: e.number, name: e.name || 'TBA', air: e.airstamp || (e.airdate ? `${e.airdate}T12:00:00` : null), rt: e.runtime || 0 };
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
    mod: prev ? prev.mod : Date.now(),
    updatedAt: Date.now(),
  };
}

/* ================= TMDB (movies) ================= */

async function tmdb(path, params = {}, keyOverride) {
  const key = (keyOverride || state.settings.tmdbKey || '').trim();
  if (!key) { const e = new Error('Add your free TMDB key in Settings to use movies'); e.code = 'NO_KEY'; throw e; }
  const url = new URL(TMDB + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = {};
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // v4 "Read Access Token"
  else url.searchParams.set('api_key', key);                         // v3 "API Key"
  const res = await fetch(url, { headers });
  if (res.status === 401) { const e = new Error("TMDB didn't accept that key"); e.code = 'BAD_KEY'; throw e; }
  if (res.status === 429) { await sleep(2000); return tmdb(path, params, keyOverride); }
  if (!res.ok) throw new Error(`TMDB returned ${res.status}`);
  return res.json();
}

function slimMovie(d) {
  return {
    id: d.id,
    title: d.title || d.original_title || 'Untitled',
    year: (d.release_date || '').slice(0, 4),
    release: d.release_date || null,
    poster: d.poster_path ? `${TMDB_IMG}w342${d.poster_path}` : null,
    backdrop: d.backdrop_path ? `${TMDB_IMG}w780${d.backdrop_path}` : null,
    overview: d.overview || '',
    runtime: d.runtime || 0,
    genres: (d.genres || []).map((g) => g.name),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
  };
}

/* ================= Show library logic ================= */

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
  if (getShow(id)) return getShow(id);
  const data = ui.preview[id] || (await fetchFull(id));
  const show = buildShow(data, null);
  show.status = status;
  state.shows[id] = show;
  save();
  toast(`Added ${show.name} to ${STATUSES[status]}`);
  return show;
}

async function refreshShow(id) {
  if (!getShow(id)) return;
  const data = await fetchFull(id);
  const prev = getShow(id);
  if (!prev) return; // removed while loading
  state.shows[id] = buildShow(data, prev);
  saveLocal();
}

async function refreshMovie(id) {
  if (!getMovie(id)) return;
  const data = await tmdb(`/movie/${id}`);
  const prev = getMovie(id);
  if (!prev) return;
  state.movies[id] = { ...prev, ...slimMovie(data), updatedAt: Date.now() };
  saveLocal();
}

async function refreshAll(force) {
  if (ui.refreshing) return;
  const now = Date.now();
  const showIds = libShows()
    .filter((s) => force || (now - (s.updatedAt || 0) > STALE_MS
      && (!s.episodes.length || !(s.status === 'completed' && /ended/i.test(s.showStatus)))))
    .map((s) => s.id);
  const movieIds = state.settings.tmdbKey
    ? libMovies().filter((m) => !m.updatedAt || (m.status === 'want' && (force || now - m.updatedAt > MOVIE_STALE_MS))).map((m) => m.id)
    : [];
  if (!showIds.length && !movieIds.length) {
    if (force) toast(libShows().length || libMovies().length ? 'Everything is up to date' : 'Add some shows first');
    return;
  }
  ui.refreshing = true;
  $refresh.classList.add('spin');
  let done = 0, failed = 0;
  for (const id of showIds) {
    try { await refreshShow(id); done++; } catch (e) { failed++; }
    await sleep(350); // stay well under TVmaze's rate limit
  }
  for (const id of movieIds) {
    try { await refreshMovie(id); done++; } catch (e) { failed++; }
    await sleep(150);
  }
  ui.refreshing = false;
  $refresh.classList.remove('spin');
  if (route().name !== 'search') render();
  if (force) toast(failed ? `Updated ${done}, ${failed} failed — check your connection` : `Updated ${plural(done, 'title')}`);
}

/** Marks episodes watched/unwatched. Returns true if the show just got completed. */
function setWatched(showId, epIds, on) {
  const show = getShow(showId);
  if (!show) return false;
  const now = Date.now();
  for (const id of epIds) {
    const cur = state.watched[id] || 0;
    if (on) state.watched[id] = cur > 0 ? cur : now;
    else state.watched[id] = -now;
  }
  let completed = false;
  if (on) {
    show.lastWatchedAt = now;
    if (show.status === 'plan' || show.status === 'stopped') { show.status = 'watching'; show.mod = now; }
    const i = info(show);
    if (/ended/i.test(show.showStatus) && i.total > 0 && i.watched >= i.total && show.status !== 'completed') {
      show.status = 'completed';
      show.mod = now;
      completed = true;
      toast(`🎉 You finished ${show.name}!`);
    }
  } else if (show.status === 'completed') {
    show.status = 'watching';
    show.mod = now;
  }
  save();
  return completed;
}

function setShowStatus(id, status) {
  const show = getShow(id);
  if (!show) return;
  show.status = status;
  show.mod = Date.now();
  save();
}

async function getShowForEdit(showId) {
  return getShow(showId) || (await addShow(showId, 'watching'));
}

function watchNext(showId, epId) {
  const show = getShow(showId);
  const ep = show && show.episodes.find((e) => e.id === epId);
  if (!ep) return;
  const completed = setWatched(showId, [epId], true);
  render();
  if (!completed) toast(`Watched ${code(ep)} of ${show.name}`, () => { setWatched(showId, [epId], false); render(); });
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
  const show = getShow(id);
  if (!show) return;
  if (!confirm(`Remove ${show.name} and its watch history?`)) return;
  const now = Date.now();
  for (const ep of show.episodes) if (state.watched[ep.id] > 0) state.watched[ep.id] = -now;
  state.shows[id] = { id: show.id, name: show.name, removed: true, mod: now, episodes: [], updatedAt: 0 };
  save();
  toast(`Removed ${show.name}`);
  if (route().name === 'show') location.hash = '#/shows'; else render();
}

async function toggleEpInfo(epId) {
  if (ui.openEp === epId) { ui.openEp = null; return render(); }
  ui.openEp = epId;
  if (!ui.epDetails[epId]) {
    render();
    try { ui.epDetails[epId] = await tvmaze(`/episodes/${epId}`); }
    catch (e) { ui.epDetails[epId] = { error: true }; }
  }
  if (ui.openEp === epId) render();
}

/* ================= Movie library logic ================= */

async function addMovie(id, status) {
  id = Number(id);
  if (getMovie(id)) return setMovieStatus(id, status);
  let data = ui.moviePreview[id];
  if (!data) data = ui.moviePreview[id] = await tmdb(`/movie/${id}`);
  const now = Date.now();
  state.movies[id] = { ...slimMovie(data), status, watchedAt: status === 'watched' ? now : 0, myRating: 0, addedAt: now, mod: now, updatedAt: now };
  save();
  toast(status === 'watched' ? `Marked ${state.movies[id].title} as watched` : `Added ${state.movies[id].title} to your list`);
}

function setMovieStatus(id, status) {
  const m = getMovie(id);
  if (!m || m.status === status) return;
  m.status = status;
  m.watchedAt = status === 'watched' ? Date.now() : 0;
  if (status !== 'watched') m.myRating = 0;
  m.mod = Date.now();
  save();
  toast(status === 'watched' ? `Watched ${m.title} 🍿` : `Moved ${m.title} back to Want to watch`);
}

function removeMovie(id) {
  const m = getMovie(id);
  if (!m) return;
  if (!confirm(`Remove ${m.title} from your movies?`)) return;
  state.movies[id] = { id: m.id, title: m.title, removed: true, mod: Date.now() };
  save();
  toast(`Removed ${m.title}`);
  if (route().name === 'movie') location.hash = '#/movies'; else render();
}

function rateMovie(id, n) {
  const m = getMovie(id);
  if (!m) return;
  m.myRating = m.myRating === n ? 0 : n;
  m.mod = Date.now();
  save();
}

async function saveTmdbKey(key) {
  key = (key || '').trim();
  if (!key) return toast('Paste your TMDB key first');
  try {
    await tmdb('/configuration', {}, key);
  } catch (e) {
    return toast(e.code === 'BAD_KEY' ? "TMDB didn't accept that key — check you copied all of it" : "Couldn't reach TMDB — check your connection");
  }
  state.settings.tmdbKey = key;
  state.settings.tmdbKeyAt = Date.now();
  save();
  toast('Movies are ready 🎬');
  render();
}

/* ================= Sync (GitHub Gist) =================
 * Your data is stored in one secret gist in your GitHub account. Every device:
 *   1. downloads the gist, 2. merges it with what it has locally, 3. uploads the result.
 * Merging never loses changes: each item remembers when you last changed it, and the newest change wins.
 */

async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${opts.token || sync.token}` };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(GITHUB + path, { method: opts.method || 'GET', body: opts.body, headers, cache: 'no-store' });
  if (!res.ok) {
    let msg = `GitHub returned ${res.status}`;
    if (res.status === 401) msg = 'GitHub token is invalid or expired — reconnect in Settings';
    else if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') msg = 'GitHub rate limit hit — will retry later';
    else if (res.status === 403 || (res.status === 404 && path.startsWith('/gists') && opts.method)) msg = 'This token needs the "gist" permission';
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

/** The part of your data that syncs (episode lists are re-downloaded from TVmaze on each device). */
function syncPayload() {
  const shows = {};
  for (const [id, s] of Object.entries(state.shows)) {
    shows[id] = s.removed
      ? { id: s.id, name: s.name, removed: true, mod: s.mod }
      : {
        id: s.id, name: s.name, image: s.image, network: s.network, showStatus: s.showStatus,
        runtime: s.runtime, premiered: s.premiered, status: s.status, mod: s.mod,
        addedAt: s.addedAt, lastWatchedAt: s.lastWatchedAt,
      };
  }
  return { app: 'showtrack', version: 2, shows, watched: state.watched, movies: state.movies, settings: state.settings };
}

const newer = (a, b) => ((b.mod || 0) > (a.mod || 0) ? b : a);

function mergeState(local, remote) {
  const r = { shows: remote.shows || {}, watched: remote.watched || {}, movies: remote.movies || {}, settings: remote.settings || {} };
  const out = { shows: {}, watched: { ...local.watched }, movies: {}, settings: { ...local.settings } };

  for (const [k, v] of Object.entries(r.watched)) {
    if (typeof v !== 'number') continue;
    const l = out.watched[k];
    if (l === undefined || Math.abs(v) > Math.abs(l)) out.watched[k] = v;
  }

  for (const id of new Set([...Object.keys(local.shows), ...Object.keys(r.shows)])) {
    const a = local.shows[id], b = r.shows[id];
    if (!b) { out.shows[id] = a; continue; }
    if (!a) { out.shows[id] = { ...b, episodes: [], updatedAt: 0 }; continue; }
    const u = newer(a, b);
    // Keep our episode list unless we only had a "removed" stub and the show was re-added elsewhere.
    const base = a.removed && !b.removed ? { ...b, episodes: [], updatedAt: 0 } : a;
    out.shows[id] = {
      ...base,
      status: u.status || base.status,
      removed: !!u.removed,
      mod: Math.max(a.mod || 0, b.mod || 0),
      addedAt: u.addedAt || base.addedAt,
      lastWatchedAt: Math.max(a.lastWatchedAt || 0, b.lastWatchedAt || 0),
    };
    if (!out.shows[id].removed && !out.shows[id].status) out.shows[id].status = 'watching';
  }

  for (const id of new Set([...Object.keys(local.movies), ...Object.keys(r.movies)])) {
    const a = local.movies[id], b = r.movies[id];
    if (!b) { out.movies[id] = a; continue; }
    if (!a) { out.movies[id] = b; continue; }
    const u = newer(a, b);
    const base = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
    out.movies[id] = { ...base, status: u.status, watchedAt: u.watchedAt, myRating: u.myRating, removed: !!u.removed, mod: u.mod, addedAt: u.addedAt || base.addedAt };
  }

  if ((r.settings.tmdbKeyAt || 0) > (local.settings.tmdbKeyAt || 0)) {
    out.settings.tmdbKey = r.settings.tmdbKey;
    out.settings.tmdbKeyAt = r.settings.tmdbKeyAt;
  }
  return normalizeState(out);
}

async function findOrCreateGist() {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const found = list.find((g) => g.files && g.files[GIST_FILE]);
    if (found) { sync.gistId = found.id; saveSync(); return false; }
    if (list.length < 100) break;
  }
  const created = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: 'ShowTrack sync data — used by your ShowTrack app, please don’t edit',
      public: false,
      files: { [GIST_FILE]: { content: JSON.stringify(syncPayload()) } },
    }),
  });
  sync.gistId = created.id;
  saveSync();
  return true;
}

async function readGist() {
  const g = await gh(`/gists/${sync.gistId}`);
  const f = g.files && g.files[GIST_FILE];
  if (!f) return null;
  let text = f.content;
  if (f.truncated && f.raw_url) text = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function writeGist(payload) {
  await gh(`/gists/${sync.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(payload) } } }) });
}

function schedulePush() {
  if (!sync.token) return;
  clearTimeout(ui.pushTimer);
  ui.pushTimer = setTimeout(() => syncNow(false), PUSH_DELAY_MS);
  setSyncUI();
}

async function syncNow(manual) {
  if (!sync.token) { if (manual) toast('Set up sync in Settings first'); return; }
  if (ui.syncing) { ui.syncAgain = true; return; }
  if (!navigator.onLine) { if (manual) toast("You're offline — will sync when you're back online"); return; }
  clearTimeout(ui.pushTimer);
  ui.pushTimer = null;
  ui.syncing = true;
  setSyncUI();
  let changed = false;
  try {
    let created = false;
    if (!sync.gistId) created = await findOrCreateGist();
    if (!created) {
      let remote;
      try {
        remote = await readGist();
      } catch (e) {
        if (e.status !== 404) throw e;
        sync.gistId = null; // gist was deleted — find another or make a new one
        created = await findOrCreateGist();
        remote = created ? null : await readGist();
      }
      if (!created) {
        const before = stable(syncPayload());
        if (remote) { state = mergeState(state, remote); saveLocal(); }
        const out = syncPayload();
        const outS = stable(out);
        changed = outS !== before;
        if (!remote || outS !== stable(remote)) await writeGist(out);
      }
    }
    sync.lastSync = Date.now();
    sync.error = null;
    if (manual) toast(changed ? 'Synced — got changes from your other devices' : 'Synced');
  } catch (e) {
    console.warn('Sync failed', e);
    sync.error = e.message || 'Sync failed';
    if (manual) toast(sync.error);
  } finally {
    saveSync();
    ui.syncing = false;
    setSyncUI();
  }
  if ((changed || route().name === 'settings') && route().name !== 'search') render();
  if (changed) refreshAll(false); // download episode lists for shows added on another device
  if (ui.syncAgain) { ui.syncAgain = false; syncNow(false); }
}

async function connectSync(token) {
  token = (token || '').trim();
  if (!token) return toast('Paste your GitHub token first');
  let user;
  try { user = await gh('/user', { token }); }
  catch (e) { return toast(e.status === 401 ? "GitHub didn't accept that token — check you copied all of it" : e.message); }
  sync = { token, user: user.login, gistId: null, lastSync: 0, error: null };
  saveSync();
  render();
  await syncNow(false);
  toast(sync.error ? sync.error : `Sync is on — signed in as @${user.login}`);
  render();
}

function disconnectSync() {
  if (!confirm('Turn off sync on this device? Your data stays here and in your gist.')) return;
  sync = {};
  saveSync();
  setSyncUI();
  toast('Sync turned off on this device');
  render();
}

function setSyncUI() {
  $settingsBtn.classList.remove('ok', 'busy', 'err');
  if (!sync.token) return;
  if (ui.syncing || ui.pushTimer) $settingsBtn.classList.add('busy');
  else if (sync.error) $settingsBtn.classList.add('err');
  else $settingsBtn.classList.add('ok');
}

/* ================= Backup ================= */

function exportData() {
  const payload = { app: 'showtrack', version: 2, exportedAt: new Date().toISOString(), ...state };
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
    const n = Object.keys(d.shows).length + Object.keys(d.movies || {}).length;
    if (!confirm(`Replace your current library with this backup (${plural(n, 'title')})?`)) return;
    const restored = normalizeState(d);
    const now = Date.now();
    for (const s of Object.values(restored.shows)) { s.mod = now; s.updatedAt = 0; }
    for (const m of Object.values(restored.movies)) m.mod = now;
    // anything not in the backup gets removed (also on your other devices)
    for (const [id, s] of Object.entries(state.shows)) if (!restored.shows[id]) restored.shows[id] = { id: s.id, name: s.name, removed: true, mod: now, episodes: [], updatedAt: 0 };
    for (const [id, m] of Object.entries(state.movies)) if (!restored.movies[id]) restored.movies[id] = { id: m.id, title: m.title, removed: true, mod: now };
    state = restored;
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
  toastTimer = setTimeout(() => $toast.classList.remove('show'), undo ? 5000 : 2800);
}

/* ================= Routing ================= */

function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'watchlist', arg };
}

function render() {
  const r = route();
  const tab = { show: 'shows', movie: 'movies' }[r.name] || r.name;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === tab));
  $settingsBtn.classList.toggle('active', r.name === 'settings');
  switch (r.name) {
    case 'upcoming': return renderUpcoming();
    case 'shows': return renderShows();
    case 'movies': return renderMovies();
    case 'search': return renderSearch(r.arg);
    case 'show': return renderShow(Number(r.arg));
    case 'movie': return renderMovie(Number(r.arg));
    case 'settings': return renderSettings();
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
  const shows = libShows();
  if (!shows.length) {
    $app.innerHTML = emptyState('Your watchlist is empty', 'Search for the shows you watch and add them here.', '#/search/shows', 'Find shows');
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
  else if (!s.episodes.length && !s.updatedAt) text = `<div class="muted small">Loading episodes…</div>`;
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
  if (!libShows().length && !libMovies().length) {
    $app.innerHTML = emptyState('Nothing scheduled yet', 'Add shows and movies and their release dates will show up here.', '#/search', 'Find something to watch');
    return;
  }
  const shows = libShows().filter((s) => s.status !== 'stopped');
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
  const tba = shows.filter((s) => s.episodes.length && !info(s).upcoming && /running|to be determined|in development/i.test(s.showStatus));
  const movies = libMovies().filter((m) => m.status === 'want' && releaseTime(m) >= today).sort((a, b) => releaseTime(a) - releaseTime(b));

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

  if (movies.length) {
    html += section('Movies coming out', movies.length, `<div class="list">${movies.map((m) => `
      <div class="row" data-go="#/movie/${m.id}">${poster(m.poster, m.title, 'mini')}
        <div class="row-body"><div class="row-title">${esc(m.title)}</div><div class="muted small">${esc(m.genres.slice(0, 2).join(', ') || 'Movie')}</div></div>
        <span class="time small">${esc(whenText(releaseTime(m)).replace(/, \d.*$/, ''))}</span>
      </div>`).join('')}</div>`);
  }
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
  const all = libShows();
  if (!all.length) {
    $app.innerHTML = emptyState('No shows yet', 'Search for a show to start building your library.', '#/search/shows', 'Find shows') + creditHtml();
    return;
  }

  let eps = 0, minutes = 0, week = 0;
  const weekAgo = Date.now() - 7 * DAY;
  for (const s of all) {
    for (const ep of s.episodes) {
      const t = state.watched[ep.id] || 0;
      if (t <= 0) continue;
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
    ${creditHtml()}`;
}

function creditHtml() {
  return `<p class="credit">Backup, sync and your movie key are in <a href="#/settings">Settings</a>.
    Show data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a>.</p>`;
}

/* ================= Views: Movies ================= */

function tmdbSetupHtml() {
  return `<div class="panel">
    <h2 style="font-size:17px;margin-bottom:8px">🎬 Turn on movies (one-time, free)</h2>
    <p class="muted" style="margin:0 0 10px">Movies come from TMDB, the free movie database. It needs a free key — takes about two minutes:</p>
    <ol class="steps">
      <li>Create a free account at <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener">themoviedb.org</a>.</li>
      <li>Open <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">Settings → API</a> and request a key (choose <b>Developer</b>, personal use).</li>
      <li>Copy the <b>API Key</b> (or the long <i>Read Access Token</i>) and paste it here.</li>
    </ol>
    <div class="field">
      <input id="tmdb-key" type="password" placeholder="Paste your TMDB key" autocomplete="off" spellcheck="false">
      <button class="btn primary" type="button" data-action="save-tmdb">Save key</button>
    </div>
    ${sync.token ? '<p class="fine">With sync on, you only need to do this on one device.</p>' : ''}
  </div>`;
}

function renderMovies() {
  const all = libMovies();
  const head = `<div class="page-head"><h1>Movies</h1>${state.settings.tmdbKey ? '<a class="btn primary sm" href="#/search/movies">+ Add movie</a>' : ''}</div>`;
  if (!state.settings.tmdbKey && !all.length) { $app.innerHTML = head + tmdbSetupHtml(); return; }
  if (!all.length) {
    $app.innerHTML = head + emptyState('No movies yet', 'Search for movies you want to watch or have already seen.', '#/search/movies', 'Find movies');
    return;
  }
  const want = all.filter((m) => m.status === 'want');
  const watched = all.filter((m) => m.status === 'watched');
  const minutes = watched.reduce((sum, m) => sum + (m.runtime || 0), 0);
  const thisYear = watched.filter((m) => new Date(m.watchedAt).getFullYear() === new Date().getFullYear()).length;

  const list = (ui.movieFilter === 'watched' ? watched : want).slice();
  const sorters = {
    recent: (a, b) => (ui.movieFilter === 'watched' ? b.watchedAt - a.watchedAt : b.addedAt - a.addedAt),
    name: (a, b) => a.title.localeCompare(b.title),
    release: (a, b) => (releaseTime(b) || 0) - (releaseTime(a) || 0),
  };
  list.sort(sorters[ui.movieSort] || sorters.recent);
  const today = startOfDay(Date.now());

  $app.innerHTML = `${head}
    <div class="stats">
      <div class="stat"><b>${want.length}</b><span>Want to watch</span></div>
      <div class="stat"><b>${watched.length}</b><span>Movies watched</span></div>
      <div class="stat"><b>${formatDuration(minutes)}</b><span>Time watched</span></div>
      <div class="stat"><b>${thisYear}</b><span>Watched this year</span></div>
    </div>
    <div class="toolbar">
      <div class="chips">
        <button class="chip ${ui.movieFilter === 'want' ? 'on' : ''}" type="button" data-action="movie-filter" data-filter="want">Want to watch · ${want.length}</button>
        <button class="chip ${ui.movieFilter === 'watched' ? 'on' : ''}" type="button" data-action="movie-filter" data-filter="watched">Watched · ${watched.length}</button>
      </div>
      <select data-change="movie-sort" aria-label="Sort movies">
        <option value="recent" ${ui.movieSort === 'recent' ? 'selected' : ''}>${ui.movieFilter === 'watched' ? 'Recently watched' : 'Recently added'}</option>
        <option value="release" ${ui.movieSort === 'release' ? 'selected' : ''}>Release date</option>
        <option value="name" ${ui.movieSort === 'name' ? 'selected' : ''}>A–Z</option>
      </select>
    </div>
    ${list.length ? `<div class="grid">${list.map((m) => {
      const rt = releaseTime(m);
      const upcoming = !isNaN(rt) && rt >= today;
      return `<a class="tile" href="#/movie/${m.id}">
        <div class="poster-wrap">${poster(m.poster, m.title, 'poster')}
          ${m.status === 'watched' ? '<span class="corner">✓</span>' : ''}
          ${upcoming ? `<span class="when">${esc(fmtShort.format(rt))}</span>` : ''}
        </div>
        <div class="tile-title">${esc(m.title)}</div>
        <div class="muted small">${esc(m.year || 'TBA')}${m.myRating ? ` · ${'★'.repeat(m.myRating)}` : ''}</div>
      </a>`;
    }).join('')}</div>`
      : `<div class="note">${ui.movieFilter === 'watched' ? 'Movies you mark as watched show up here.' : 'Your list is empty — add movies you want to watch.'}</div>`}
    ${!state.settings.tmdbKey ? `<div style="margin-top:20px">${tmdbSetupHtml()}</div>` : ''}
    <p class="credit">Movie data from <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a>. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>`;
}

function renderMovie(id) {
  let m = getMovie(id);
  const inLib = !!m;
  if (!m) {
    const data = ui.moviePreview[id];
    if (!data) {
      if (!state.settings.tmdbKey) { $app.innerHTML = tmdbSetupHtml(); return; }
      $app.innerHTML = '<div class="loading">Loading movie…</div>';
      tmdb(`/movie/${id}`)
        .then((d) => { ui.moviePreview[id] = d; const r = route(); if (r.name === 'movie' && Number(r.arg) === id) render(); })
        .catch((e) => { $app.innerHTML = emptyState("Couldn't load this movie", e.message, '#/movies', 'Back to movies'); });
      return;
    }
    m = slimMovie(data);
  }
  const rt = releaseTime(m);
  const released = isNaN(rt) || rt <= Date.now();
  const meta = [m.year, m.runtime && formatDuration(m.runtime)].filter(Boolean).join(' · ');
  const chips = [m.rating ? `<span class="tag">★ ${m.rating}</span>` : '', ...m.genres.map((g) => `<span class="tag">${esc(g)}</span>`)].join('');

  let actions;
  if (!inLib) {
    actions = `<button class="btn primary" type="button" data-action="movie-add" data-movie="${id}" data-status="want">+ Want to watch</button>
      ${released ? `<button class="btn" type="button" data-action="movie-add" data-movie="${id}" data-status="watched">✓ Watched</button>` : ''}`;
  } else if (m.status === 'want') {
    actions = `${released ? `<button class="btn primary" type="button" data-action="movie-status" data-movie="${id}" data-status="watched">✓ Mark watched</button>` : '<span class="tag">On your list</span>'}
      <button class="btn ghost danger" type="button" data-action="movie-remove" data-movie="${id}">Remove</button>`;
  } else {
    actions = `<button class="btn" type="button" data-action="movie-status" data-movie="${id}" data-status="want">Unwatch</button>
      <button class="btn ghost danger" type="button" data-action="movie-remove" data-movie="${id}">Remove</button>`;
  }

  let panel = '';
  if (inLib && m.status === 'watched') {
    panel = `<div class="panel"><div class="watched-line">✓ Watched${m.watchedAt ? ` on ${esc(fmtDate.format(m.watchedAt))}` : ''}</div>
      <div class="muted small" style="margin:10px 0 4px">Your rating</div>
      <div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="${n <= (m.myRating || 0) ? 'on' : ''}" data-action="rate" data-movie="${id}" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div></div>`;
  } else if (!isNaN(rt)) {
    panel = `<div class="panel next-air"><div><div class="label">${released ? 'Released' : 'Comes out'}</div><div>${esc(released ? fmtDate.format(rt) : whenText(rt).replace(/, \d.*$/, ''))}</div></div></div>`;
  }

  $app.innerHTML = `
    <button class="back" type="button" data-action="back">‹ Back</button>
    <section class="hero">
      ${m.backdrop || m.poster ? `<div class="hero-bg" style="background-image:url(${esc(m.backdrop || m.poster)})"></div>` : ''}
      <div class="hero-inner">
        ${poster(m.poster, m.title, 'poster big')}
        <div class="hero-text">
          <h1>${esc(m.title)}</h1>
          <div class="meta">${esc(meta)}</div>
          ${chips ? `<div class="chips">${chips}</div>` : ''}
          <div class="actions">${actions}</div>
        </div>
      </div>
    </section>
    ${panel}
    ${m.overview ? `<p class="summary">${esc(m.overview)}</p>` : ''}`;
}

/* ================= Views: Search ================= */

function renderSearch(arg) {
  if (arg === 'shows' || arg === 'movies') ui.searchType = arg;
  const type = ui.searchType;
  $app.innerHTML = `
    <div class="seg" role="tablist">
      <button type="button" class="${type === 'shows' ? 'on' : ''}" data-action="search-type" data-type="shows">Shows</button>
      <button type="button" class="${type === 'movies' ? 'on' : ''}" data-action="search-type" data-type="movies">Movies</button>
    </div>
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
      <input id="q" type="search" placeholder="${type === 'movies' ? 'Search for a movie…' : 'Search for a show…'}" value="${esc(ui.searchQuery)}" autocomplete="off" enterkeyhint="search">
    </div>
    <div id="results" class="results"></div>`;
  if (type === 'movies' && !state.settings.tmdbKey) {
    document.getElementById('results').innerHTML = tmdbSetupHtml();
    return;
  }
  const q = document.getElementById('q');
  q.addEventListener('input', () => {
    clearTimeout(ui.searchTimer);
    ui.searchTimer = setTimeout(() => doSearch(q.value), 350);
  });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(ui.searchTimer); doSearch(q.value); q.blur(); } });
  if (!ui.searchQuery) q.focus();
  if (ui.searchQuery && ui.resultsType !== type) doSearch(ui.searchQuery);
  else renderResults();
}

async function doSearch(query) {
  ui.searchQuery = query;
  const type = ui.searchType;
  const token = ++ui.searchToken;
  if (!query.trim()) { ui.searchResults = null; ui.resultsType = type; return renderResults(); }
  const $r = document.getElementById('results');
  if ($r && (!ui.searchResults || ui.resultsType !== type)) $r.innerHTML = '<div class="loading">Searching…</div>';
  let results;
  try {
    if (type === 'movies') {
      const res = await tmdb('/search/movie', { query: query.trim(), include_adult: 'false' });
      results = res.results || [];
    } else {
      const res = await tvmaze(`/search/shows?q=${encodeURIComponent(query.trim())}`);
      results = res.map((r) => r.show);
    }
  } catch (e) {
    results = 'error';
  }
  if (token !== ui.searchToken) return;
  ui.searchResults = results;
  ui.resultsType = type;
  renderResults();
}

function renderResults() {
  const $r = document.getElementById('results');
  if (!$r) return;
  const res = ui.searchResults;
  const type = ui.resultsType || ui.searchType;
  if (res === null || type !== ui.searchType) {
    $r.innerHTML = `<div class="note">${ui.searchType === 'movies' ? 'Type a movie name — e.g. “Dune”, “Interstellar”.' : 'Type a show name — e.g. “The Bear”, “Severance”, “Kuruluş Osman”.'}</div>`;
    return;
  }
  if (res === 'error') { $r.innerHTML = `<div class="note">Couldn't reach ${type === 'movies' ? 'TMDB' : 'TVmaze'}. Check your connection and try again.</div>`; return; }
  if (!res.length) { $r.innerHTML = `<div class="note">Nothing found for “${esc(ui.searchQuery)}”.</div>`; return; }

  if (type === 'movies') {
    $r.innerHTML = res.map((d) => {
      const m = slimMovie(d);
      const lib = getMovie(m.id);
      const tag = lib ? `<span class="tag">${lib.status === 'watched' ? '✓ Watched' : '✓ On list'}</span>`
        : `<button class="btn primary sm" type="button" data-action="movie-add" data-movie="${m.id}" data-status="want">+ Add</button>`;
      return `<div class="result" data-go="#/movie/${m.id}">
        ${poster(m.poster, m.title, 'thumb')}
        <div class="result-body">
          <div class="result-title">${esc(m.title)}</div>
          <div class="muted small">${esc([m.year || 'TBA', m.rating && `★ ${m.rating}`].filter(Boolean).join(' · '))}</div>
          ${m.overview ? `<div class="muted small" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(m.overview)}</div>` : ''}
        </div>
        ${tag}
      </div>`;
    }).join('');
    return;
  }

  $r.innerHTML = res.map((s) => {
    const sh = slimShow(s);
    const inLib = !!getShow(sh.id);
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
  let show = getShow(id);
  const inLib = !!show;
  if (show && !show.episodes.length && !show.updatedAt) {
    // added on another device — episodes are still downloading
    refreshShow(id).then(() => { const r = route(); if (r.name === 'show' && Number(r.arg) === id) render(); }).catch(() => {});
  }
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
  if (!ui.openSeasons[id] && show.episodes.length) {
    const focus = i.next || i.upcoming || show.episodes[show.episodes.length - 1];
    ui.openSeasons[id] = new Set([focus.s]);
  }
  const open = ui.openSeasons[id] || new Set();

  const meta = [years(show), show.network, show.showStatus, show.runtime && `${show.runtime} min`].filter(Boolean).join(' · ');
  const genres = (show.genres || []).map((g) => `<span class="tag">${esc(g)}</span>`).join('');
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
    ${seasonHtml || `<div class="note">${inLib && !show.updatedAt ? 'Loading episodes…' : 'No episodes listed yet.'}</div>`}`;

  $app.querySelectorAll('details.season').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (!ui.openSeasons[id]) ui.openSeasons[id] = open;
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

/* ================= Views: Settings ================= */

function renderSettings() {
  let syncHtml;
  if (sync.token) {
    const pill = ui.syncing ? '<span class="status-pill off">Syncing…</span>'
      : sync.error ? '<span class="status-pill err">Problem</span>' : '<span class="status-pill">On</span>';
    syncHtml = `<h2>Sync across devices ${pill}</h2>
      <p>Signed in to GitHub as <b>@${esc(sync.user || '?')}</b>. Changes upload a few seconds after you make them, and this device checks for changes from your other devices every couple of minutes.</p>
      ${sync.error ? `<p class="accent">⚠ ${esc(sync.error)}</p>` : ''}
      <p class="muted small">${sync.lastSync ? `Last synced ${esc(agoText(sync.lastSync))}` : 'Not synced yet'}${sync.gistId ? ` · <a href="https://gist.github.com/${esc(sync.user || '')}/${esc(sync.gistId)}" target="_blank" rel="noopener">view data gist</a>` : ''}</p>
      <div class="btn-row">
        <button class="btn primary sm" type="button" data-action="sync-now">Sync now</button>
        <button class="btn ghost sm danger" type="button" data-action="sync-off">Turn off on this device</button>
      </div>`;
  } else {
    syncHtml = `<h2>Sync across devices <span class="status-pill off">Off</span></h2>
      <p>Keep your phone, laptop and any other device in sync automatically. Your data is saved in a secret gist in your own GitHub account.</p>
      <ol class="steps">
        <li><a href="https://github.com/settings/tokens/new?scopes=gist&description=ShowTrack%20sync" target="_blank" rel="noopener">Create a GitHub token</a> — the link pre-fills it. Only the <b>gist</b> box should be ticked.</li>
        <li>Set <b>Expiration</b> to <i>No expiration</i> (or a long time), then press <b>Generate token</b>.</li>
        <li>Copy the token (starts with <code>ghp_</code>) and paste it below. Do the same on each device — you can reuse the same token.</li>
      </ol>
      <div class="field">
        <input id="gh-token" type="password" placeholder="ghp_…" autocomplete="off" spellcheck="false">
        <button class="btn primary" type="button" data-action="sync-connect">Turn on sync</button>
      </div>
      <p class="fine">The token stays on this device and is only used to talk to GitHub. A secret gist isn't listed anywhere, but anyone who has its exact link could open it — it only contains your watch list.</p>`;
  }

  const tmdbHtml = state.settings.tmdbKey
    ? `<h2>Movies <span class="status-pill">On</span></h2>
       <p>Your TMDB key is saved${sync.token ? ' and synced to your other devices' : ''}.</p>
       <div class="field"><input id="tmdb-key" type="password" placeholder="Paste a new TMDB key to replace it" autocomplete="off" spellcheck="false">
       <button class="btn sm" type="button" data-action="save-tmdb">Replace key</button></div>`
    : tmdbSetupHtml().replace(/^<div class="panel">/, '').replace(/<\/div>\s*$/, '');

  $app.innerHTML = `<div class="settings">
    <h1>Settings</h1>
    <div class="panel">${syncHtml}</div>
    <div class="panel">${tmdbHtml}</div>
    <div class="panel">
      <h2>Backup</h2>
      <p>Download a copy of your shows, movies and watch history, or restore one.</p>
      <div class="btn-row">
        <button class="btn sm" type="button" data-action="export">Download backup</button>
        <button class="btn sm" type="button" data-action="import">Restore backup</button>
        <button class="btn sm" type="button" data-action="refresh">Check for new episodes</button>
      </div>
    </div>
    <p class="credit">Show data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a> (CC BY-SA).
      Movie data from <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a>. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
  </div>`;
}

/* ================= Events ================= */

async function handleAction(el) {
  const a = el.dataset.action;
  const showId = Number(el.dataset.show);
  const epId = Number(el.dataset.ep);
  const movieId = Number(el.dataset.movie);
  switch (a) {
    case 'watch-next': return watchNext(showId, epId);
    case 'toggle-ep': return toggleEp(showId, epId);
    case 'season': return toggleSeason(showId, Number(el.dataset.season));
    case 'ep-info': return toggleEpInfo(epId);
    case 'add':
      el.disabled = true;
      await addShow(showId, el.dataset.status || 'watching');
      return route().name === 'search' ? renderResults() : render();
    case 'remove': return removeShow(showId);
    case 'complete': setShowStatus(showId, 'completed'); toast('Marked as completed'); return render();
    case 'filter': ui.filter = el.dataset.filter; return render();
    case 'expand': ui.summaryOpen = !ui.summaryOpen; return render();

    case 'movie-add':
      el.disabled = true;
      await addMovie(movieId, el.dataset.status || 'want');
      return route().name === 'search' ? renderResults() : render();
    case 'movie-status': setMovieStatus(movieId, el.dataset.status); return render();
    case 'movie-remove': return removeMovie(movieId);
    case 'rate': rateMovie(movieId, Number(el.dataset.n)); return render();
    case 'movie-filter': ui.movieFilter = el.dataset.filter; ui.movieSort = 'recent'; return render();
    case 'save-tmdb': return saveTmdbKey((document.getElementById('tmdb-key') || {}).value);

    case 'search-type':
      ui.searchType = el.dataset.type;
      location.hash = `#/search/${el.dataset.type}`;
      return;

    case 'sync-connect': el.disabled = true; await connectSync((document.getElementById('gh-token') || {}).value); el.disabled = false; return;
    case 'sync-now': return syncNow(true);
    case 'sync-off': return disconnectSync();

    case 'refresh': return refreshAll(true);
    case 'export': return exportData();
    case 'import': return $importFile.click();
    case 'back':
      if (history.length > 1) history.back(); else location.hash = '#/watchlist';
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
      toast(err.code === 'NO_KEY' || err.code === 'BAD_KEY' ? err.message : "Something went wrong — check your connection");
      if (route().name === 'search') renderResults(); else render();
    }
    return;
  }
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('button, a, select, input')) location.hash = go.dataset.go;
});

$app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const kind = el.dataset.change;
  if (kind === 'status') {
    setShowStatus(Number(el.dataset.show), el.value);
    toast(`Moved to ${STATUSES[el.value]}`);
    render();
  } else if (kind === 'sort') { ui.sort = el.value; render(); }
  else if (kind === 'movie-sort') { ui.movieSort = el.value; render(); }
});

$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'gh-token') $app.querySelector('[data-action="sync-connect"]').click();
  if (e.target.id === 'tmdb-key') $app.querySelector('[data-action="save-tmdb"]').click();
});

$importFile.addEventListener('change', () => {
  const file = $importFile.files[0];
  if (file) importData(file);
  $importFile.value = '';
});

$refresh.addEventListener('click', () => { refreshAll(true); syncNow(false); });

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  ui.openEp = null;
  ui.summaryOpen = false;
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (ui.pushTimer) syncNow(false); // upload pending changes before the app goes to the background
    return;
  }
  if (route().name !== 'search') render(); // episodes that aired while you were away become checkable
  syncNow(false);
  refreshAll(false);
});

window.addEventListener('online', () => syncNow(false));
setInterval(() => { if (!document.hidden) syncNow(false); }, SYNC_EVERY_MS);

/* ================= Start ================= */

render();
setSyncUI();
syncNow(false).then(() => refreshAll(false));

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
