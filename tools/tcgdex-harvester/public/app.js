// TCGdex Harvester dashboard: renders the live feed from /events and drives /api/*.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtInt = (n) => Math.round(n ?? 0).toLocaleString();
const fmtBytes = (b) => {
  b = b ?? 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) (b /= 1024), i++;
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtDur = (sec) => {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const hue = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

const ICON = {
  set: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="9" rx="1.5"/><rect x="14" y="4" width="7" height="9" rx="1.5"/><path d="M3 17h18M3 21h18"/></svg>',
  card: '<svg viewBox="0 0 24 24"><path d="M8 4h8l4 4v12H4V4z"/><path d="M8 12h8M8 16h5"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="5" y="2.5" width="14" height="19" rx="2"/><circle cx="12" cy="9.5" r="3"/><path d="M8 17h8"/></svg>',
  asset: '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M5 5l9 7-9 7zM19 5v14"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};
const STATUS_LABEL = { pending: 'Waiting', active: 'Active', done: 'Done', failed: 'Failed', skipped: 'Skipped' };

// ------------------------------------------------------------------ state

const state = {
  stats: null,
  sets: new Map(),
  series: [],
  tab: 'sets',
  queue: { status: 'all', kind: 'all', q: '', limit: 100, version: -1, loading: false },
  gallery: [],
  galleryIds: new Set(),
  logs: 0,
  settingsDirty: 0,
};

// ------------------------------------------------------------------ live feed

let es;
function connect() {
  es = new EventSource('/events');
  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    $('#conn').classList.add('live');
    $('#conn span').textContent = 'Live';
    $('#source').textContent = `Source: ${d.api}`;
    $('#outDir').textContent = `Saving to ${d.out}`;
    state.series = d.catalog.series ?? [];
    state.sets = new Map(d.sets.map((s) => [s.id, s]));
    $('#log').innerHTML = '';
    d.logs.forEach(addLog);
    d.images.forEach(addImage);
    applyStats(d.stats, true);
    renderSets();
    refreshQueue(true);
  });
  es.addEventListener('tick', (e) => {
    const d = JSON.parse(e.data);
    for (const p of d.sets) {
      const s = state.sets.get(p.id);
      if (s) Object.assign(s, p, { queued: true });
    }
    applyStats(d.stats);
    updateSetCards();
    d.logs.forEach(addLog);
    d.images.forEach(addImage);
    state.queue.pendingVersion = d.queueVersion;
    if (d.queueVersion !== state.queue.version && state.tab === 'queue') refreshQueue();
  });
  es.onerror = () => {
    $('#conn').classList.remove('live');
    $('#conn span').textContent = 'Reconnecting…';
  };
}

// ------------------------------------------------------------------ stats

const RING = 2 * Math.PI * 86;
function applyStats(s, force) {
  const prev = state.stats;
  state.stats = s;
  const c = s.counts;
  const finished = c.done + c.skipped;
  const projected = Math.max(s.projectedTotal ?? c.total, c.total);
  const pct = projected ? (finished / projected) * 100 : 0;
  $('#ringBar').style.strokeDashoffset = String(RING * (1 - pct / 100));
  $('#pct').textContent = `${pct >= 99.95 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
  $('#pctSub').textContent = projected ? `${fmtInt(finished)} of ${fmtInt(projected)} items` : 'nothing queued yet';

  $('#tDone').textContent = fmtInt(finished);
  $('#tDoneSub').textContent = `of ${fmtInt(projected)} · ${fmtInt(c.active)} active`;
  $('#tSpeed').textContent = s.rates.itemsPerSec.toFixed(s.rates.itemsPerSec < 10 ? 1 : 0);
  $('#tSpeedSub').textContent = `items / s · ${s.workers} worker${s.workers === 1 ? '' : 's'}`;
  $('#tBytes').textContent = fmtBytes(s.totals.bytes);
  $('#tBytesSub').textContent = `${fmtBytes(s.rates.bytesPerSec)}/s · ${fmtInt(s.totals.cached)} already on disk`;
  $('#tEta').textContent = s.status === 'running' ? fmtDur(s.etaSec) : s.status === 'finished' ? 'Done' : '—';
  $('#tElapsed').textContent = `${fmtDur(s.elapsedMs / 1000)} running`;
  $('#tFailed').textContent = fmtInt(c.failed);
  $('#tileFailed').classList.toggle('alert', c.failed > 0);
  $('#tSkipped').textContent = `${fmtInt(c.skipped)} skipped`;
  $('#tReq').textContent = fmtInt(s.totals.requests);
  $('#tReqSub').textContent = `${s.rates.reqPerSec.toFixed(1)} / s now`;
  $('#queueCount').textContent = c.total ? fmtInt(c.total) : '';

  // status pill + buttons
  const pill = $('#statusPill');
  pill.dataset.status = s.status;
  const throttled = s.hosts.some((h) => h.throttled || h.cooldownMs > 0);
  $('#statusText').textContent =
    { idle: 'Idle', discovering: 'Discovering', running: throttled ? 'Running · slowed' : 'Running', paused: 'Paused', finished: 'Finished' }[s.status] ?? s.status;
  $('#btnPause').hidden = s.status !== 'running';
  $('#btnResume').hidden = !(s.status === 'paused' || (s.status === 'finished' && c.pending > 0));
  $('#btnStart').hidden = s.status === 'running' || s.status === 'paused';
  $('#btnStart').disabled = s.status === 'discovering' || !state.sets.size;
  $('#btnDiscover').disabled = s.status === 'discovering' || s.status === 'running';
  $('#btnDiscover2').disabled = $('#btnDiscover').disabled;
  $('#btnClear').disabled = !(c.pending || c.failed);
  const banner = $('#banner');
  banner.hidden = !(s.status === 'paused' && s.pauseReason);
  banner.textContent = s.pauseReason ? `⏸  ${s.pauseReason}` : '';
  document.title = s.status === 'running' ? `${Math.floor(pct)}% · TCGdex Harvester` : 'TCGdex Harvester';

  // settings (don't overwrite what the user is dragging)
  if (force || Date.now() - state.settingsDirty > 1500) syncSettings(s.settings);

  renderKinds(s.byKind);
  renderHosts(s.hosts, s.settings.rate);
  drawChart(s.chart);
  if (prev && prev.status !== s.status && s.status === 'finished') toast('All done. Index files written.', 'info');
}

function renderKinds(byKind) {
  const names = { set: 'Sets', card: 'Card data', image: 'Images', asset: 'Logos' };
  $('#kinds').innerHTML = ['set', 'card', 'image', 'asset']
    .filter((k) => byKind[k])
    .map((k) => {
      const v = byKind[k];
      return `<div class="kind">${names[k]} <b>${fmtInt(v.done)}</b>/${fmtInt(v.total)}<div class="mini"><i style="width:${v.total ? (v.done / v.total) * 100 : 0}%"></i></div></div>`;
    })
    .join('');
}

function renderHosts(hosts, target) {
  $('#hosts').innerHTML = hosts.length
    ? hosts
        .map((h) => {
          const wait = h.cooldownMs > 0;
          const badge = wait ? `<span class="badge wait">waiting ${Math.ceil(h.cooldownMs / 1000)}s</span>` : h.throttled ? '<span class="badge slow">slowed down</span>' : '<span class="badge">ok</span>';
          const pct = Math.min(100, (h.rate / Math.max(target, 0.01)) * 100);
          return `<div class="host"><div class="h"><b>${esc(h.host)}</b>${badge}</div><div class="gauge"><i class="${h.throttled ? 'slow' : ''}" style="width:${pct}%"></i></div><small>${h.rate}/s of ${h.target}/s · ${fmtInt(h.sent)} requests</small></div>`;
        })
        .join('')
    : '<p class="hint">Each host gets its own budget once requests start.</p>';
}

// ------------------------------------------------------------------ chart

function drawChart(points) {
  const cv = $('#chart');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.parentElement.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== w * dpr) (cv.width = w * dpr), (cv.height = h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h * i) / 4);
    ctx.lineTo(w, (h * i) / 4);
    ctx.stroke();
  }
  if (!points?.length) return;
  const N = 120;
  const pad = Array.from({ length: Math.max(0, N - points.length) }, () => ({ items: 0, bytes: 0 }));
  // 3-second moving average: per-second counts are spiky by nature
  const raw = [...pad, ...points].slice(-N);
  const pts = raw.map((_, i) => {
    const win = raw.slice(Math.max(0, i - 2), i + 1);
    return { items: win.reduce((a, p) => a + p.items, 0) / win.length, bytes: win.reduce((a, p) => a + p.bytes, 0) / win.length };
  });
  const series = (key, scale, c1, c2, fill) => {
    const max = Math.max(...pts.map((p) => p[key] * scale), 0.001);
    const xy = pts.map((p, i) => [(i / (N - 1)) * w, h - 6 - ((p[key] * scale) / max) * (h - 16)]);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.beginPath();
    xy.forEach(([x, y], i) => {
      if (!i) return ctx.moveTo(x, y);
      const [px, py] = xy[i - 1];
      const mx = (px + x) / 2;
      ctx.bezierCurveTo(mx, py, mx, y, x, y);
    });
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (fill) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const f = ctx.createLinearGradient(0, 0, 0, h);
      f.addColorStop(0, fill);
      f.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = f;
      ctx.fill();
    }
    const [lx, ly] = xy[xy.length - 1];
    ctx.beginPath();
    ctx.arc(lx - 3, ly, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = c2;
    ctx.fill();
  };
  series('bytes', 1 / (1024 * 1024), 'rgba(34,211,238,.4)', '#22d3ee', 'rgba(34,211,238,0.14)');
  series('items', 1, 'rgba(139,123,255,.5)', '#a99dff', null);
}
window.addEventListener('resize', () => state.stats && drawChart(state.stats.chart));

// ------------------------------------------------------------------ sets

function setCardHtml(s) {
  const h = hue(s.id);
  const logo = s.localLogo ? `<img src="/files/${encodeURI(s.localLogo)}" alt="">` : esc(s.id.slice(0, 5).toUpperCase());
  return `<div class="set${s.selected ? ' selected' : ''}" data-id="${esc(s.id)}" role="checkbox" aria-checked="${!!s.selected}" tabindex="0">
    <span class="check"></span>
    <div class="top">
      <div class="logo" style="background:linear-gradient(135deg,hsl(${h} 70% 45%),hsl(${(h + 50) % 360} 70% 35%))">${logo}</div>
      <div style="min-width:0"><div class="name">${esc(s.name)}</div><div class="meta">${esc(s.id)} · ${s.cards ?? '?'} cards</div></div>
    </div>
    <div class="bar"><i class="p"></i><i class="f"></i></div>
    <div class="row"><span class="prog"></span><span class="act"></span></div>
  </div>`;
}

function renderSets() {
  const box = $('#sets');
  const all = [...state.sets.values()];
  $('#setsEmpty').hidden = all.length > 0;
  box.hidden = !all.length;
  $('#setsCount').textContent = all.length ? String(all.length) : '';
  const needle = $('#setSearch').value.trim().toLowerCase();
  const groups = new Map();
  for (const s of all) {
    if (needle && !`${s.name} ${s.id} ${s.serie?.name}`.toLowerCase().includes(needle)) continue;
    const key = s.serie?.id ?? 'other';
    if (!groups.has(key)) groups.set(key, { name: s.serie?.name ?? 'Other', sets: [] });
    groups.get(key).sets.push(s);
  }
  box.innerHTML = [...groups.entries()]
    .map(([id, g]) => {
      const cards = g.sets.reduce((a, s) => a + (s.cards ?? 0), 0);
      const sel = g.sets.filter((s) => s.selected).length;
      return `<section class="serie"><div class="serie-head"><h4>${esc(g.name)}</h4><small>${g.sets.length} set${g.sets.length === 1 ? '' : 's'} · ${fmtInt(cards)} cards</small><button class="chip" data-serie="${esc(id)}" data-on="${sel < g.sets.length}">${sel < g.sets.length ? 'Select series' : 'Deselect series'}</button></div><div class="set-grid">${g.sets.map(setCardHtml).join('')}</div></section>`;
    })
    .join('');
  updateSetCards();
  renderEstimate();
}

function updateSetCards() {
  for (const el of $$('.set', $('#sets'))) {
    const s = state.sets.get(el.dataset.id);
    if (!s) continue;
    const pct = s.total ? (s.done / s.total) * 100 : 0;
    const fpct = s.total ? (s.failed / s.total) * 100 : 0;
    el.querySelector('.bar .p').style.width = `${pct}%`;
    el.querySelector('.bar .f').style.width = `${fpct}%`;
    el.classList.toggle('complete', s.queued && s.total > 0 && s.done === s.total);
    el.classList.toggle('active-set', (s.active ?? 0) > 0);
    el.querySelector('.prog').textContent = s.queued ? `${fmtInt(s.done)}/${fmtInt(s.total)}${s.failed ? ` · ${s.failed} failed` : ''} · ${fmtBytes(s.bytes)}` : s.selected ? 'selected' : 'not queued';
    const act = el.querySelector('.act');
    const pending = s.queued && s.done + s.failed < s.total;
    if (pending && !act.dataset.on) {
      act.dataset.on = '1';
      act.innerHTML = '<button data-prio>Do next</button>';
    } else if (!pending && act.dataset.on) {
      delete act.dataset.on;
      act.innerHTML = '';
    }
    if (s.localLogo && !el.querySelector('.logo img')) el.querySelector('.logo').innerHTML = `<img src="/files/${encodeURI(s.localLogo)}" alt="">`;
  }
}

function renderEstimate() {
  const st = state.stats?.settings;
  const sel = [...state.sets.values()].filter((s) => s.selected);
  if (!sel.length || !st) return ($('#estimate').innerHTML = '');
  const cards = sel.reduce((a, s) => a + (s.cards ?? 0), 0);
  const req = cards * ((st.images ? 1 : 0) + (st.cardData ? 1 : 0)) + sel.length * (st.setAssets ? 3 : 1);
  const perImg = st.quality === 'high' ? (st.format === 'png' ? 0.55 : 0.12) : st.format === 'png' ? 0.11 : 0.03;
  const mb = (st.images ? cards * perImg : 0) + (st.cardData ? cards * 0.004 : 0);
  $('#estimate').innerHTML = `<b>${sel.length}</b> sets · <b>${fmtInt(cards)}</b> cards · ~<b>${fmtInt(req)}</b> requests · ~<b>${fmtDur(req / st.rate)}</b> at ${st.rate}/s · ~<b>${mb > 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'}</b>`;
}

async function select(ids, selected) {
  for (const id of ids) {
    const s = state.sets.get(id);
    if (s) s.selected = selected;
  }
  renderSets();
  await api('/api/select', { ids, selected }).catch((e) => toast(e.message, 'error'));
}

$('#sets').addEventListener('click', (e) => {
  const prio = e.target.closest('[data-prio]');
  const card = e.target.closest('.set');
  const serie = e.target.closest('[data-serie]');
  if (prio && card) {
    e.stopPropagation();
    api(`/api/sets/${encodeURIComponent(card.dataset.id)}/prioritize`, {}).then((r) => toast(`${r.moved} items moved to the front.`));
    return;
  }
  if (serie) {
    const ids = [...state.sets.values()].filter((s) => (s.serie?.id ?? 'other') === serie.dataset.serie).map((s) => s.id);
    return select(ids, serie.dataset.on === 'true');
  }
  if (card) {
    const s = state.sets.get(card.dataset.id);
    select([s.id], !s.selected);
  }
});
$('#sets').addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && e.target.classList.contains('set')) {
    e.preventDefault();
    e.stopPropagation();
    e.target.click();
  }
});
$('#setSearch').addEventListener('input', renderSets);
$('#selAll').onclick = () => select([...state.sets.keys()], true);
$('#selNone').onclick = () => select([...state.sets.keys()], false);

// ------------------------------------------------------------------ queue

let queueTimer = null;
function refreshQueue(now) {
  clearTimeout(queueTimer);
  queueTimer = setTimeout(loadQueue, now ? 0 : 350);
}
async function loadQueue() {
  const q = state.queue;
  if (q.loading) return refreshQueue();
  q.loading = true;
  const want = q.pendingVersion ?? q.version;
  try {
    const p = new URLSearchParams({ status: q.status, kind: q.kind, q: q.q, limit: String(q.limit) });
    const d = await api(`/api/queue?${p}`);
    q.version = want;
    renderQueue(d);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    q.loading = false;
  }
}

function renderQueue(d) {
  const box = $('#queue');
  const keep = box.scrollTop;
  box.innerHTML = d.items.length
    ? d.items
        .map((it) => {
          const wait = it.status === 'pending' && it.waitMs > 0 ? `<span class="w">· ${Math.ceil(it.waitMs / 1000)}s</span>` : '';
          const err = it.error ? `<span class="e ${it.status === 'failed' ? 'bad' : ''}">${esc(it.error)}</span>` : it.file ? `<span class="e">${esc(it.file)}${it.cached ? ' (already had it)' : ''}</span>` : '';
          const acts = [
            it.status === 'pending' ? `<button class="icon-btn" data-act="prioritize" title="Do next">${ICON.up}</button>` : '',
            it.status === 'pending' || it.status === 'failed' ? `<button class="icon-btn" data-act="skip" title="Skip">${ICON.skip}</button>` : '',
            it.status === 'failed' || it.status === 'skipped' ? `<button class="icon-btn" data-act="retry" title="Retry">${ICON.retry}</button>` : '',
            it.file && /\.(png|jpg|webp)$/.test(it.file) ? `<button class="icon-btn" data-act="view" title="View">${ICON.open}</button>` : '',
          ].join('');
          return `<div class="q-row" data-id="${esc(it.id)}" data-file="${esc(it.file ?? '')}" data-label="${esc(it.label)}">
            <div class="q-label"><span class="k">${ICON[it.kind] ?? ''}</span><div style="min-width:0"><span class="t">${esc(it.label)}${it.urgent ? '<span class="urgent-tag">next</span>' : ''}</span>${err}</div></div>
            <div class="q-set">${esc(it.setId)}</div>
            <div><span class="st ${it.status}"><i></i>${STATUS_LABEL[it.status]}${wait}${it.attempts > 1 ? `<span class="w">· try ${it.attempts}</span>` : ''}</span></div>
            <div class="q-size">${it.bytes ? fmtBytes(it.bytes) : ''}</div>
            <div class="q-actions">${acts}</div>
          </div>`;
        })
        .join('')
    : '<div class="empty small"><p>Nothing here.</p></div>';
  box.scrollTop = keep;
  $('#queueShown').textContent = d.total ? `Showing ${fmtInt(Math.min(d.items.length, d.total))} of ${fmtInt(d.total)}` : '';
  $('#queueMore').hidden = d.items.length >= d.total;
}

$('#queue').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const row = b.closest('.q-row');
  if (b.dataset.act === 'view') return openLightbox(row.dataset.file, row.dataset.label);
  const r = await api(`/api/queue/${encodeURIComponent(row.dataset.id)}/${b.dataset.act}`, {}).catch((err) => toast(err.message, 'error'));
  if (r && !r.ok) toast('That item changed in the meantime.', 'error');
  refreshQueue(true);
});
function segControl(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', $(id)).forEach((x) => x.classList.toggle('on', x === b));
    state.queue[key] = b.dataset.v;
    state.queue.limit = 100;
    refreshQueue(true);
  });
}
segControl('#qStatus', 'status');
segControl('#qKind', 'kind');
$('#qSearch').addEventListener('input', (e) => {
  state.queue.q = e.target.value;
  refreshQueue();
});
$('#queueMore').onclick = () => {
  state.queue.limit += 200;
  refreshQueue(true);
};
$('#retryFailed').onclick = () => api('/api/retry-failed', {}).then((r) => toast(r.retried ? `Retrying ${r.retried} items.` : 'Nothing has failed.'));
$('#tileFailed').onclick = () => {
  switchTab('queue');
  $$('#qStatus button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'failed'));
  state.queue.status = 'failed';
  refreshQueue(true);
};

// ------------------------------------------------------------------ gallery & filmstrip

function thumb(i) {
  const el = document.createElement('button');
  el.className = 'card-thumb';
  el.title = i.label;
  el.innerHTML = `<img loading="lazy" src="/files/${encodeURI(i.file)}" alt=""><span>${esc(i.label.split(' · ')[0])}</span>`;
  el.onclick = () => openLightbox(i.file, i.label);
  return el;
}
function addImage(i) {
  if (state.galleryIds.has(i.id)) return;
  state.galleryIds.add(i.id);
  state.gallery.unshift(i);
  const strip = $('#filmstrip');
  strip.prepend(thumb(i));
  while (strip.children.length > 40) strip.lastChild.remove();
  const g = $('#gallery');
  g.prepend(thumb(i));
  while (g.children.length > 240) g.lastChild.remove();
  $('#galleryEmpty').hidden = true;
  $('#galleryCount').textContent = fmtInt(state.galleryIds.size);
}
function openLightbox(file, label) {
  const lb = $('#lightbox');
  lb.querySelector('img').src = `/files/${encodeURI(file)}`;
  lb.querySelector('p').textContent = `${label ?? ''}\n${file}`;
  lb.hidden = false;
}
$('#lightbox').onclick = () => ($('#lightbox').hidden = true);

// ------------------------------------------------------------------ log

function addLog(l) {
  const box = $('#log');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const row = document.createElement('div');
  row.className = l.level;
  row.innerHTML = `<time>${fmtTime(l.t)}</time><span>${esc(l.msg)}</span>`;
  box.append(row);
  while (box.children.length > 400) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
  if (l.level === 'error' && document.hidden === false && ++state.logs % 25 === 1) toast(l.msg, 'error');
}
$('#logClear').onclick = () => ($('#log').innerHTML = '');

// ------------------------------------------------------------------ settings

function fillRange(el) {
  el.style.setProperty('--fill', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
}
function syncSettings(s) {
  const rate = $('#rate'), conc = $('#conc');
  rate.value = s.rate;
  conc.value = s.concurrency;
  $('#rateOut').textContent = s.rate;
  $('#concOut').textContent = s.concurrency;
  fillRange(rate);
  fillRange(conc);
  $('#optImages').checked = s.images;
  $('#optData').checked = s.cardData;
  $('#optAssets').checked = s.setAssets;
  $('#optLang').value = s.lang;
  $$('#optQuality button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.quality));
  $$('#optFormat button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.format));
  renderEstimate();
}
let settingsTimer;
function pushSettings(patch) {
  state.settingsDirty = Date.now();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => api('/api/settings', patch).catch((e) => toast(e.message, 'error')), 250);
}
$('#rate').addEventListener('input', (e) => {
  $('#rateOut').textContent = e.target.value;
  fillRange(e.target);
  pushSettings({ rate: Number(e.target.value) });
});
$('#conc').addEventListener('input', (e) => {
  $('#concOut').textContent = e.target.value;
  fillRange(e.target);
  pushSettings({ concurrency: Number(e.target.value) });
});
for (const [id, key] of [['#optImages', 'images'], ['#optData', 'cardData'], ['#optAssets', 'setAssets']]) {
  $(id).addEventListener('change', (e) => pushSettings({ [key]: e.target.checked }));
}
$('#optLang').addEventListener('change', (e) => {
  pushSettings({ lang: e.target.value });
  toast('Language changed: press Discover to list that language\'s sets.');
});
for (const [id, key] of [['#optQuality', 'quality'], ['#optFormat', 'format']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', $(id)).forEach((x) => x.classList.toggle('on', x === b));
    pushSettings({ [key]: b.dataset.v });
  });
}

// ------------------------------------------------------------------ main controls

async function discover() {
  try {
    const r = await api('/api/discover', {});
    toast(`Found ${r.catalog.sets.length} sets.`);
    const sets = await api('/api/sets');
    state.sets = new Map(sets.sets.map((s) => [s.id, s]));
    renderSets();
  } catch (e) {
    toast(`Discovery failed: ${e.message}`, 'error');
  }
}
$('#btnDiscover').onclick = discover;
$('#btnDiscover2').onclick = discover;
$('#btnStart').onclick = async () => {
  if (![...state.sets.values()].some((s) => s.selected) && !state.stats?.counts.pending) return toast('Select at least one set first.', 'error');
  await api('/api/start', { plan: true });
  const sets = await api('/api/sets');
  state.sets = new Map(sets.sets.map((s) => [s.id, s]));
  renderSets();
};
$('#btnPause').onclick = () => api('/api/pause', {});
$('#btnResume').onclick = () => api('/api/resume', {});
$('#btnClear').onclick = async () => {
  if (!confirm('Drop everything that has not been downloaded yet? Files already saved stay.')) return;
  await api('/api/clear', {});
  const sets = await api('/api/sets');
  state.sets = new Map(sets.sets.map((s) => [s.id, s]));
  renderSets();
  refreshQueue(true);
};

// ------------------------------------------------------------------ tabs & keys

function switchTab(t) {
  state.tab = t;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  for (const id of ['sets', 'queue', 'gallery']) $(`#tab-${id}`).hidden = id !== t;
  if (t === 'queue') refreshQueue(true);
}
$$('.tab').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === ' ' && !e.target.closest('button, .set')) {
    e.preventDefault();
    if (state.stats?.status === 'running') api('/api/pause', {});
    else if (state.stats?.status === 'paused') api('/api/resume', {});
  }
  if (e.key === '/') {
    e.preventDefault();
    switchTab('queue');
    $('#qSearch').focus();
  }
  if (e.key === 'Escape') $('#lightbox').hidden = true;
});

// live countdowns in the queue (retry waits) without a server round trip
setInterval(() => {
  if (state.tab === 'queue' && state.stats?.status === 'running') refreshQueue();
}, 3000);

connect();
