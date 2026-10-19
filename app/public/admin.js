'use strict';

const $ = (id) => document.getElementById(id);
const CLIP = 16;
const PAGE = 200;

let songs = [];
let hiddenCount = 0;
let listGenre = 'all';
let listState = 'all';
let shownLimit = PAGE;

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};
const norm = (t) => String(t).toLowerCase().replace(/[а-я]/g, (c) => TRANSLIT[c] ?? c).replace(/[^a-z0-9]+/g, ' ').trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = (s) => { if (s == null || !Number.isFinite(s)) return '—'; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const fmtNum = (s) => String(Math.round(s * 10) / 10).replace('.', ',');

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Грешка от сървъра');
  return data;
}

// ===================== Списък =====================
async function refresh() {
  const d = await api('GET', '/api/admin/songs');
  songs = d.songs;
  hiddenCount = d.hidden;
  renderGenres();
  renderList();
  renderAnaInfo();
}

function genreCounts() {
  const m = new Map();
  for (const s of songs) m.set(s.genre, (m.get(s.genre) || 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'bg'));
}

function renderGenres() {
  const g = genreCounts();
  $('genreChips').innerHTML = g.map(([n, c]) => `<span class="chip">${esc(n)} <b>${c}</b></span>`).join('');
  if (listGenre !== 'all' && !g.some(([n]) => n === listGenre)) listGenre = 'all';
  $('lGenre').innerHTML = [['all', songs.length], ...g]
    .map(([n]) => `<button data-g="${esc(n)}" class="${n === listGenre ? 'active' : ''}">${n === 'all' ? 'Всички жанрове' : esc(n)}</button>`).join('');
  $('genreList').innerHTML = g.map(([n]) => `<option value="${esc(n)}">`).join('');
  $('cAll').textContent = songs.length;
  $('unhideBtn').hidden = !hiddenCount;
  $('unhideBtn').textContent = `Върни изтритите (${hiddenCount})`;
}

function filtered() {
  const words = norm($('lSearch').value).split(' ').filter(Boolean);
  return songs.filter((s) =>
    (listGenre === 'all' || s.genre === listGenre) &&
    (listState === 'all' || (listState === 'none' ? s.start == null : s.start_manual === 1)) &&
    words.every((w) => norm(`${s.artist} ${s.title}`).includes(w)));
}

function startCell(s) {
  if (s.start == null) return '<span class="tag none">няма</span>';
  return `${fmtT(s.start)} <span class="tag ${s.start_manual ? 'manual' : 'auto'}">${s.start_manual ? 'ръчно' : 'авто'}</span>`;
}

function renderList() {
  const rows = filtered();
  const cur = editor.song && editor.song.id;
  $('list').innerHTML = rows.slice(0, shownLimit).map((s) => `
    <tr data-id="${s.id}" class="${s.id === cur ? 'current' : ''}">
      <td>${esc(s.artist)}</td>
      <td>${esc(s.title)}</td>
      <td><span class="tag genre">${esc(s.genre)}</span></td>
      <td>${startCell(s)}</td>
      <td class="actions"><button class="icon-btn" data-edit="${s.id}" title="Отвори">✎</button></td>
    </tr>`).join('');
  $('listEmpty').hidden = rows.length > 0;
  $('moreWrap').hidden = rows.length <= shownLimit;
}

$('list').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openEditor(Number(tr.dataset.id));
});
$('lSearch').addEventListener('input', () => { shownLimit = PAGE; renderList(); });
$('lGenre').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  listGenre = b.dataset.g; shownLimit = PAGE; renderGenres(); renderList();
});
$('lState').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  listState = b.dataset.s; shownLimit = PAGE;
  [...$('lState').children].forEach((x) => x.classList.toggle('active', x === b));
  renderList();
});
$('moreBtn').addEventListener('click', () => { shownLimit += PAGE; renderList(); });
$('unhideBtn').addEventListener('click', async () => {
  if (!confirm(`Да върна ли ${hiddenCount} изтрити песни в играта?`)) return;
  await api('POST', '/api/admin/unhide'); await refresh();
});

// ===================== Сканиране =====================
let lastScan = null;

$('scanBtn').addEventListener('click', async () => {
  $('scanBtn').disabled = true;
  $('scanResult').innerHTML = '<div class="import-box">Сканирам…</div>';
  try {
    lastScan = await api('GET', '/api/scan');
    renderScan();
  } catch (e) {
    $('scanResult').innerHTML = `<div class="import-box err">${esc(e.message)}</div>`;
  }
  $('scanBtn').disabled = false;
});

function renderScan() {
  const r = lastScan;
  const genres = Object.entries(r.perGenre).map(([g, n]) => `${esc(g)}: <b>${n}</b>`).join(' · ');
  const list = (items, fn) => `<ul class="scan-list">${items.map(fn).join('')}</ul>`;
  const sections = [];

  if (r.add.length) {
    sections.push(`<details open><summary><b class="ok">Нови: ${r.add.length}</b> ${genres ? '— ' + genres : ''}</summary>
      <div class="scan-tools"><label class="check"><input type="checkbox" id="scanAll" checked> всички</label>
      <span class="muted small">Жълтите са без ясно разчетен изпълнител — провери ги след добавяне.</span></div>
      <div class="table-wrap scan-table"><table><thead><tr><th></th><th>Изпълнител</th><th>Заглавие</th><th>Жанр</th><th>Разчетено от</th></tr></thead><tbody>
      ${r.add.map((a, i) => `<tr class="${!a.artist || a.source.includes('без') ? 'warn' : ''}" title="${esc(a.file)}">
        <td><input type="checkbox" class="scanPick" data-i="${i}" checked></td>
        <td>${esc(a.artist) || '<i>?</i>'}</td><td>${esc(a.title)}</td><td>${esc(a.genre)}</td><td class="muted small">${esc(a.source)}</td></tr>`).join('')}
      </tbody></table></div></details>`);
  }
  if (r.duplicates.length) {
    sections.push(`<details><summary><b class="warn-t">Повторения (няма да се добавят): ${r.duplicates.length}</b></summary>
      ${list(r.duplicates, (d) => `<li><b>${esc(d.file)}</b><br><span class="muted">същата като ${esc(d.duplicateLabel)} — ${esc(d.duplicateOf)}</span></li>`)}</details>`);
  }
  if (r.noGenre.length) {
    sections.push(`<details><summary><b class="warn-t">Без жанр: ${r.noGenre.length}</b> <span class="muted">— сложи ги в подпапка на music</span></summary>
      ${list(r.noGenre, (f) => `<li>${esc(f)}</li>`)}</details>`);
  }
  if (r.missing.length) {
    sections.push(`<details open><summary><b class="err-t">Липсват от папката: ${r.missing.length}</b> <span class="muted">— файлът е изтрит или преместен</span></summary>
      ${list(r.missing, (m) => `<li><label class="check"><input type="checkbox" class="missPick" data-id="${m.id}"> махни от играта</label> ${esc(m.label)} <span class="muted small">(${esc(m.file)})</span></li>`)}</details>`);
  }
  const actionable = r.add.length || r.missing.length;
  $('scanResult').innerHTML = `<div class="import-box">
      <div class="muted small">Файлове в папката: ${r.total} · вече в играта: ${r.unchanged}${r.hiddenSkipped ? ` · изтрити от теб: ${r.hiddenSkipped}` : ''}</div>
      ${actionable ? '' : '<div class="big">Няма нищо ново за добавяне.</div>'}
      ${sections.join('')}
      ${actionable ? `<div class="field-row" style="margin-top:12px"><button class="btn primary" id="scanApply">${r.add.length ? 'Добави избраните' : 'Приложи'}</button><button class="ghost" id="scanCancel">Отказ</button></div>` : ''}
    </div>`;
  const all = $('scanAll');
  if (all) all.addEventListener('change', () => document.querySelectorAll('.scanPick').forEach((c) => { c.checked = all.checked; }));
  const apply = $('scanApply');
  if (apply) apply.addEventListener('click', applyScan);
  const cancel = $('scanCancel');
  if (cancel) cancel.addEventListener('click', () => { $('scanResult').innerHTML = ''; });
}

async function applyScan() {
  const files = [...document.querySelectorAll('.scanPick')].filter((c) => c.checked).map((c) => lastScan.add[Number(c.dataset.i)].file);
  const removeMissing = [...document.querySelectorAll('.missPick')].filter((c) => c.checked).map((c) => Number(c.dataset.id));
  $('scanApply').disabled = true;
  try {
    const r = await api('POST', '/api/scan', { files, removeMissing });
    await refresh();
    const pending = songs.filter((s) => s.start == null).length;
    $('scanResult').innerHTML = `<div class="import-box"><span class="big">Добавени: ${r.added}</span>${r.removed ? ` · махнати: ${r.removed}` : ''}
      ${pending ? `<div style="margin-top:10px">Сега намери началото им: <button class="btn primary sm2" id="scanAnalyze">Намери начало за ${pending} песни</button></div>` : ''}</div>`;
    const b = $('scanAnalyze');
    if (b) b.addEventListener('click', () => runAnalysis(songs.filter((s) => s.start == null)));
  } catch (e) {
    $('scanResult').insertAdjacentHTML('beforeend', `<div class="import-box err">${esc(e.message)}</div>`);
  }
}

// ===================== Аудио (за редактора и анализа) =====================
let actx = null;
const getCtx = () => (actx || (actx = new (window.AudioContext || window.webkitAudioContext)()));

async function loadBuffer(id, signal) {
  const res = await fetch('/audio/' + id, { signal });
  if (!res.ok) throw new Error(res.status === 404 ? 'файлът липсва в папката music' : 'грешка ' + res.status);
  const data = await res.arrayBuffer();
  return getCtx().decodeAudioData(data);
}

// ===================== Автоматичен анализ =====================
let worker = null;
let workerSeq = 0;
const workerWaits = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker('analyze-worker.js');
  worker.onmessage = (e) => {
    const w = workerWaits.get(e.data.id);
    if (!w) return;
    workerWaits.delete(e.data.id);
    e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data.result);
  };
  return worker;
}
function analyzeInWorker(buf) {
  const id = ++workerSeq;
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
  return new Promise((resolve, reject) => {
    workerWaits.set(id, { resolve, reject });
    getWorker().postMessage({ id, channels, sampleRate: buf.sampleRate }, channels.map((c) => c.buffer));
  });
}

async function analyzeAndSave(song, buf, resetManual) {
  const r = await analyzeInWorker(buf);
  return api('POST', `/api/admin/songs/${song.id}/analysis`, { ...r, resetManual: !!resetManual });
}

let anaStop = false;
let anaRunning = false;

function renderAnaInfo() {
  const none = songs.filter((s) => s.start == null).length;
  const manual = songs.filter((s) => s.start_manual).length;
  $('anaInfo').textContent = songs.length
    ? `${none ? `${none} песни още нямат начало (в играта започват от 30-та сек).` : 'Всички песни имат начало.'} ${manual ? `${manual} са нагласени на ръка.` : ''}`
    : 'Още няма песни — първо сканирай папката.';
  $('anaNewBtn').textContent = `Намери начало за новите${none ? ` (${none})` : ''}`;
  $('anaNewBtn').disabled = !none || anaRunning;
  $('anaAllBtn').disabled = !songs.length || anaRunning;
}

async function runAnalysis(list, resetManual) {
  if (anaRunning || !list.length) return;
  anaRunning = true; anaStop = false;
  renderAnaInfo();
  $('anaProgress').hidden = false;
  const t0 = performance.now();
  let done = 0, failed = 0;
  const fails = [];
  const fetchNext = (i) => (i < list.length ? loadBuffer(list[i].id).then((b) => ({ b }), (e) => ({ e })) : null);
  let next = fetchNext(0);
  for (let i = 0; i < list.length && !anaStop; i++) {
    const s = list[i];
    const per = done ? (performance.now() - t0) / done : 0;
    const left = per ? Math.ceil((per * (list.length - i)) / 60000) : null;
    $('anaText').textContent = `${i + 1} / ${list.length} · ${s.artist} – ${s.title}${left != null ? ` · остават ~${left} мин` : ''}`;
    $('anaBar').style.width = (i / list.length) * 100 + '%';
    const got = await next;
    next = fetchNext(i + 1);                        // следващата се зарежда, докато тази се анализира
    try {
      if (got.e) throw got.e;
      const saved = await analyzeAndSave(s, got.b, resetManual);
      const k = songs.findIndex((x) => x.id === s.id);
      if (k >= 0) songs[k] = saved;
      done++;
    } catch (e) {
      failed++; fails.push(`${s.artist} – ${s.title}: ${e.message}`);
    }
    if (i % 10 === 9) { renderList(); renderAnaInfo(); }
  }
  anaRunning = false;
  $('anaBar').style.width = '100%';
  const mins = ((performance.now() - t0) / 60000).toFixed(1).replace('.', ',');
  $('anaText').textContent = `${anaStop ? 'Спряно. ' : 'Готово. '}Анализирани: ${done}${failed ? ` · неуспешни: ${failed}` : ''} · ${mins} мин`;
  if (fails.length) console.warn('Неуспешни:\n' + fails.join('\n'));
  await refresh();
}

$('anaNewBtn').addEventListener('click', () => runAnalysis(songs.filter((s) => s.start == null)));
$('anaAllBtn').addEventListener('click', () => {
  const inc = $('anaIncludeManual').checked;
  const list = inc ? songs : songs.filter((s) => !s.start_manual);
  const mins = Math.ceil(list.length * 0.8 / 60);
  if (!confirm(`Да анализирам ли наново ${list.length} песни? Ще отнеме около ${mins} мин.${inc ? '\nНагласените на ръка също ще се презапишат.' : ''}`)) return;
  runAnalysis(list, inc);
});
$('anaStop').addEventListener('click', () => { anaStop = true; });

// ===================== Редактор =====================
const editor = { song: null, buf: null, peaks: null, start: 0, choruses: [], entry: null, play: null, loadToken: 0 };
const canvas = $('wave');
const cx = canvas.getContext('2d');

async function openEditor(id) {
  const s = songs.find((x) => x.id === id);
  if (!s) return;
  stopPlay();
  editor.song = s;
  editor.buf = null; editor.peaks = null;
  editor.start = s.start ?? 30;
  editor.choruses = s.choruses ? JSON.parse(s.choruses) : [];
  editor.entry = s.entry;
  $('editor').hidden = false;
  $('edTitle').textContent = `${s.artist} – ${s.title}`;
  $('edArtist').value = s.artist;
  $('edSong').value = s.title;
  $('edGenre').value = s.genre;
  $('edFile').textContent = 'Файл: music/' + s.file;
  $('edReason').textContent = s.reason ? `Автоматиката: ${s.reason}` : '';
  setMsg('');
  updateStartUi();
  renderList();
  $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setBusy(true, 'Зареждам песента…');
  const token = ++editor.loadToken;
  try {
    const buf = await loadBuffer(id);
    if (token !== editor.loadToken) return;
    editor.buf = buf;
    sizeCanvas();
    // ако още няма анализ — направи го веднага
    if (s.start == null) {
      setBusy(true, 'Търся началото…');
      const saved = await analyzeAndSave(s, buf);
      if (token !== editor.loadToken) return;
      syncSaved(saved, true);
    }
    setBusy(false);
  } catch (e) {
    if (token !== editor.loadToken) return;
    setBusy(false);
    setMsg('Песента не може да се зареди: ' + e.message, 'err');
  }
}

function syncSaved(saved, takeStart) {
  const k = songs.findIndex((x) => x.id === saved.id);
  if (k >= 0) songs[k] = saved;
  editor.song = saved;
  editor.choruses = saved.choruses ? JSON.parse(saved.choruses) : [];
  editor.entry = saved.entry;
  if (takeStart) editor.start = saved.start ?? editor.start;
  $('edReason').textContent = saved.reason ? `Автоматиката: ${saved.reason}` : '';
  updateStartUi();
  renderList(); renderAnaInfo();
}

function setBusy(on, text) {
  $('waveTime').textContent = on ? text : '';
  canvas.classList.toggle('busy', on);
  draw();
}
function setMsg(t, kind) { $('edMsg').textContent = t; $('edMsg').className = 'msg ' + (kind || ''); }

function sizeCanvas() {
  const w = canvas.clientWidth || 800;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(150 * dpr);
  if (editor.buf) editor.peaks = SongAnalyzer.peaks(editor.buf, Math.round(w));
  draw();
}
window.addEventListener('resize', () => { if (!$('editor').hidden) sizeCanvas(); });

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function draw(playhead) {
  const W = canvas.width, H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  cx.clearRect(0, 0, W, H);
  cx.fillStyle = '#0d1210';
  cx.fillRect(0, 0, W, H);
  const dur = editor.buf ? editor.buf.duration : (editor.song && editor.song.duration) || 0;
  if (!dur) return;
  const X = (t) => (t / dur) * W;

  // припеви
  cx.fillStyle = 'rgba(255, 181, 71, 0.16)';
  for (const [a, b] of editor.choruses) cx.fillRect(X(a), 0, X(b) - X(a), H);
  // откъс
  cx.fillStyle = 'rgba(35, 226, 122, 0.18)';
  cx.fillRect(X(editor.start), 0, X(Math.min(dur, editor.start + CLIP)) - X(editor.start), H);

  // вълна
  if (editor.peaks) {
    const p = editor.peaks;
    const bw = W / p.length;
    for (let i = 0; i < p.length; i++) {
      const t = (i / p.length) * dur;
      const inClip = t >= editor.start && t <= editor.start + CLIP;
      cx.fillStyle = inClip ? '#23e27a' : '#4d5a53';
      const h = Math.max(1 * dpr, p[i] * (H - 16 * dpr));
      cx.fillRect(i * bw, (H - h) / 2, Math.max(1, bw - 0.5), h);
    }
  }
  // песента влиза
  if (editor.entry != null) {
    cx.strokeStyle = '#7fa8ff'; cx.setLineDash([4 * dpr, 4 * dpr]); cx.lineWidth = 1.5 * dpr;
    cx.beginPath(); cx.moveTo(X(editor.entry), 0); cx.lineTo(X(editor.entry), H); cx.stroke(); cx.setLineDash([]);
  }
  // маркер
  cx.fillStyle = '#e8efe9';
  cx.fillRect(X(editor.start) - 1 * dpr, 0, 2 * dpr, H);
  cx.beginPath(); cx.moveTo(X(editor.start) - 6 * dpr, 0); cx.lineTo(X(editor.start) + 6 * dpr, 0); cx.lineTo(X(editor.start), 9 * dpr); cx.fill();
  // минути
  cx.fillStyle = '#7d8a82'; cx.font = `${10 * dpr}px system-ui`;
  for (let m = 30; m < dur; m += 30) { cx.fillRect(X(m), H - 5 * dpr, 1, 5 * dpr); cx.fillText(fmtT(m).replace('.0', ''), X(m) + 3 * dpr, H - 3 * dpr); }
  // текуща позиция
  if (playhead != null) { cx.fillStyle = '#ffb547'; cx.fillRect(X(playhead) - 1, 0, 2 * dpr, H); }
}

function updateStartUi() {
  $('edStart').value = (Math.round(editor.start * 10) / 10).toFixed(1);
  const s = editor.song;
  const parts = [`${fmtT(editor.start)} от ${fmtT(editor.buf ? editor.buf.duration : s && s.duration)}`];
  if (s && s.auto_start != null && Math.abs(s.auto_start - editor.start) > 0.05) parts.push(`автоматиката предлага ${fmtT(s.auto_start)}`);
  const inChorus = editor.choruses.find(([a, b]) => editor.start + CLIP > a && editor.start < b);
  if (inChorus) parts.push('⚠ откъсът стига до открит припев');
  $('edStartInfo').textContent = parts.join(' · ');
  $('edRevert').disabled = !(s && s.auto_start != null && Math.abs(s.auto_start - editor.start) > 0.05);
  draw();
}

function setStart(t) {
  const dur = editor.buf ? editor.buf.duration : 9999;
  editor.start = Math.max(0, Math.min(Math.round(t * 100) / 100, Math.max(0, dur - 1)));
  stopPlay();
  updateStartUi();
}

// мишка по графиката: щракни/влачи = ново начало
let dragging = false;
function timeAt(e) {
  const r = canvas.getBoundingClientRect();
  const dur = editor.buf ? editor.buf.duration : 0;
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur;
}
canvas.addEventListener('pointerdown', (e) => { if (!editor.buf) return; dragging = true; canvas.setPointerCapture(e.pointerId); setStart(timeAt(e)); });
canvas.addEventListener('pointermove', (e) => {
  if (!editor.buf) return;
  if (dragging) setStart(timeAt(e));
  else $('waveTime').textContent = fmtT(timeAt(e));
});
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointerleave', () => { if (!canvas.classList.contains('busy')) $('waveTime').textContent = ''; });

document.querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => setStart(editor.start + Number(b.dataset.nudge))));
$('edStart').addEventListener('change', () => setStart(Number($('edStart').value) || 0));

// пускане
function stopPlay() {
  if (editor.play) {
    try { editor.play.src.onended = null; editor.play.src.stop(); } catch (e) { /* вече */ }
    cancelAnimationFrame(editor.play.raf);
    editor.play.btn && editor.play.btn.classList.remove('playing');
    editor.play = null;
    draw();
  }
}
function playFrom(t, dur, btn) {
  stopPlay();
  if (!editor.buf) return;
  const c = getCtx(); c.resume();
  const src = c.createBufferSource();
  const g = c.createGain();
  src.buffer = editor.buf;
  src.connect(g).connect(c.destination);
  const t0 = c.currentTime + 0.02;
  if (dur) {
    const fade = Math.min(0.012, dur / 4);
    g.gain.setValueAtTime(1, t0 + dur - fade);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    src.start(t0, t, dur);
  } else src.start(t0, t);
  btn && btn.classList.add('playing');
  const p = { src, btn, raf: 0 };
  editor.play = p;
  src.onended = () => { if (editor.play === p) stopPlay(); };
  const tick = () => { if (editor.play !== p) return; draw(t + Math.max(0, c.currentTime - t0)); p.raf = requestAnimationFrame(tick); };
  tick();
}
$('preview').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (editor.play && editor.play.btn === b) { stopPlay(); return; }
  playFrom(editor.start, Number(b.dataset.d), b);
});

$('edAuto').addEventListener('click', async () => {
  if (!editor.buf) return;
  stopPlay();
  $('edAuto').disabled = true;
  setBusy(true, 'Търся началото…');
  try {
    const saved = await analyzeAndSave(editor.song, editor.buf, true);
    syncSaved(saved, true);
    setMsg('Автоматиката избра ' + fmtT(saved.start), 'ok');
  } catch (e) { setMsg(e.message, 'err'); }
  setBusy(false);
  $('edAuto').disabled = false;
});
$('edRevert').addEventListener('click', () => { if (editor.song.auto_start != null) setStart(editor.song.auto_start); });

$('edSave').addEventListener('click', async () => {
  const s = editor.song; if (!s) return;
  const isAuto = s.auto_start != null && Math.abs(editor.start - s.auto_start) <= 0.005;
  try {
    const saved = await api('PUT', `/api/admin/songs/${s.id}`, {
      artist: $('edArtist').value, title: $('edSong').value, genre: $('edGenre').value,
      start: editor.start,
      manual: !isAuto,
    });
    syncSaved(saved, false);
    $('edTitle').textContent = `${saved.artist} – ${saved.title}`;
    renderGenres();
    setMsg('Запазено', 'ok');
  } catch (e) { setMsg(e.message, 'err'); }
});

$('edDelete').addEventListener('click', async () => {
  const s = editor.song; if (!s) return;
  if (!confirm(`Да махна ли „${s.artist} – ${s.title}“ от играта?\nФайлът остава в папката music.`)) return;
  try {
    await api('DELETE', `/api/admin/songs/${s.id}`);
    closeEditor();
    await refresh();
  } catch (e) { setMsg(e.message, 'err'); }
});

function closeEditor() {
  stopPlay();
  editor.loadToken++;
  editor.song = null; editor.buf = null; editor.peaks = null;
  $('editor').hidden = true;
  renderList();
}
$('edClose').addEventListener('click', closeEditor);

document.addEventListener('keydown', (e) => {
  if ($('editor').hidden || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.key === ' ') { e.preventDefault(); editor.play ? stopPlay() : playFrom(editor.start, 16, document.querySelector('#preview [data-d="16"]')); }
  if (e.key === 'ArrowLeft') setStart(editor.start - (e.shiftKey ? 5 : 1));
  if (e.key === 'ArrowRight') setStart(editor.start + (e.shiftKey ? 5 : 1));
  if (e.key === 'Escape') closeEditor();
});

// ===================== Старт =====================
refresh().catch(() => {
  $('listEmpty').hidden = false;
  $('listEmpty').textContent = 'Няма връзка със сървъра.';
});
