'use strict';

// ===== Настройки =====
const STAGES = [0.1, 0.5, 2, 8, 16];          // секунди слушане на всеки етап
const TOTAL = STAGES[STAGES.length - 1];
const ORDINALS = ['първия', 'втория', 'третия', 'четвъртия', 'петия'];

// ===== Състояние =====
let SONGS = [];         // всички песни от базата (за търсачката)

const state = {
  genre: 'all',
  song: null,         // текущият рунд: { round, start }; името идва от сървъра чак в края
  busy: false,        // чака отговор от сървъра за опит
  stage: 0,           // индекс в STAGES
  attempts: [],       // { type: 'skip' | 'wrong' | 'correct' | 'giveup', song?, text? }
  selected: null,     // песен, избрана от падащия списък
  over: false,
  ready: false,       // клипът е зареден
  played: {},         // изиграни песни по жанр, за да няма повторения
  streak: 0,
  wins: 0,
};

// ===== Елементи =====
const $ = (id) => document.getElementById(id);
const el = {
  genres: $('genres'),
  progress: $('progress'),
  track: $('progressTrack'),
  fill: $('progressFill'),
  labels: $('progressLabels'),
  playBtn: $('playBtn'),
  dur: $('durLabel'),
  volRange: $('volRange'),
  status: $('status'),
  input: $('guessInput'),
  sugg: $('suggestions'),
  action: $('actionBtn'),
  hint: $('hint'),
  attempts: $('attempts'),
  overlay: $('overlay'),
  card: $('card'),
  badge: $('resultBadge'),
  rTitle: $('resultTitle'),
  rText: $('resultText'),
  cover: $('cover'),
  revTitle: $('revealTitle'),
  revArtist: $('revealArtist'),
  listen: $('listenBtn'),
  next: $('nextBtn'),
  streak: $('streak'),
  wins: $('wins'),
};

// ===== Помощни =====
const fmt = (s) => String(s).replace('.', ',') + 'с';
const songLabel = (s) => `${s.artist} – ${s.title}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

// Привежда текст към латиница, малки букви и само букви/цифри,
// за да се търси еднакво на кирилица и латиница.
function norm(text) {
  return text
    .toLowerCase()
    .replace(/[а-я]/g, (c) => TRANSLIT[c] ?? c)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hashStr(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// ===== Прогрес бар =====
// Сегментите са пропорционални на времето, така че барът се пълни с постоянна скорост.
function buildProgress() {
  el.track.innerHTML = STAGES.map((s, i) => {
    const prev = i ? STAGES[i - 1] : 0;
    return `<div class="seg" style="width:${((s - prev) / TOTAL) * 100}%"></div>`;
  }).join('');
  el.labels.innerHTML = STAGES.map((s) => {
    const pct = (s / TOTAL) * 100;
    // надписите близо до краищата не излизат извън бара
    const [shift, arrow] = pct < 8 ? ['-6px', '6px']
      : pct > 92 ? ['calc(-100% + 6px)', 'calc(100% - 6px)']
      : ['-50%', '50%'];
    return `<span style="left:${pct}%;--shift:${shift};--arrow:${arrow}">${fmt(s)}</span>`;
  }).join('');
}

const timeToPct = (t) => Math.min(t / TOTAL, 1) * 100;
const setFill = (pct) => el.fill.style.setProperty('--p', pct);

// Под бара се показва само текущата граница и крайните 16с.
function renderProgress() {
  const segs = el.track.children;
  const labels = el.labels.children;
  for (let i = 0; i < STAGES.length; i++) {
    const a = state.attempts[i];
    segs[i].className = 'seg' +
      (i <= state.stage ? ' unlocked' : '') +
      (a && a.type === 'wrong' ? ' wrong' : '');
    labels[i].className =
      i === state.stage ? 'current' : (i === STAGES.length - 1 ? 'end' : 'hidden');
  }
}

// ===== Сървър =====
async function api(url, body) {
  const res = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Грешка'), { status: res.status });
  return data;
}

async function fetchRandomSong(genre) {
  // Изиграните се помнят като кодове на рундове (сървърът знае коя песен е зад всеки)
  const used = state.played[genre] || (state.played[genre] = new Set());
  const params = new URLSearchParams({ genre, exclude: [...used].slice(-300).join(',') });
  if (state.song) params.set('last', state.song.round);
  const { song, reset } = await api('/api/random?' + params);
  if (reset) { used.clear(); if (state.song) used.add(state.song.round); }
  used.add(song.round);
  return song;
}

// Избира и зарежда песен (за текущия рунд или предварително за следващия)
function prepare(genre) {
  const p = (async () => {
    const song = await fetchRandomSong(genre);
    try {
      const loaded = await Player.load(song);
      return { song, clip: loaded.clip };
    } catch (e) {
      return { song, error: e };
    }
  })();
  p.catch(() => {});
  return { genre, promise: p };
}

// Незавършените рундове се помнят за всеки жанр, за да не може човек
// да избяга от трудна песен (и да запази серията), сменяйки жанра и връщайки се.
const rounds = {};

function saveRound(genre) {
  if (!state.song || state.over || !state.ready) return;
  rounds[genre] = {
    song: state.song,
    clip: state.clip,
    stage: state.stage,
    attempts: state.attempts.slice(),
  };
}

function restoreRound(genre) {
  const r = rounds[genre];
  delete rounds[genre];
  Player.stop();
  ++loadToken;                 // отменя всяко висящо зареждане
  el.overlay.hidden = true;
  state.song = r.song;
  state.clip = r.clip;
  state.stage = r.stage;
  state.attempts = r.attempts.slice();
  state.selected = null;
  state.over = false;
  state.ready = true;
  Player.setClip(r.clip);
  Player.setLimit(STAGES[state.stage]);
  setFill('0%');
  el.input.value = '';
  el.input.disabled = false;
  el.hint.textContent = '';
  el.playBtn.classList.remove('playing');
  closeSuggestions();
  render();
  el.playBtn.disabled = false;
  el.status.textContent = 'Натисни, за да чуеш';
  preloadNext();
}

// Следващата песен се зарежда, докато се играе текущата
let preloaded = null;
function preloadNext() {
  if (!preloaded || preloaded.genre !== state.genre) preloaded = prepare(state.genre);
}

// ===== Рунд =====
let loadToken = 0;
let failures = 0;          // поредни песни, които не тръгнаха

async function newRound() {
  Player.stop();
  el.overlay.hidden = true;
  state.stage = 0;
  state.attempts = [];
  state.selected = null;
  state.over = false;
  state.ready = false;
  el.input.value = '';
  el.input.disabled = false;
  el.hint.textContent = '';
  el.playBtn.classList.remove('playing');
  closeSuggestions();
  render();

  const token = ++loadToken;
  el.playBtn.disabled = true;
  el.status.textContent = 'Зарежда…';

  // вземи предварително заредената песен, ако е от същия жанр
  const job = preloaded && preloaded.genre === state.genre ? preloaded : prepare(state.genre);
  preloaded = null;

  let result;
  try {
    result = await job.promise;
  } catch (e) {
    if (token !== loadToken) return;
    state.song = null;
    el.status.textContent = e.status === 404
      ? 'Няма песни в този жанр. Добави от localhost:3000/admin'
      : 'Няма връзка със сървъра. Пуснат ли е?';
    return;
  }
  if (token !== loadToken) return;
  state.song = result.song;

  if (result.error) {
    console.warn('Песента не тръгна:', result.error.message);
    if (++failures >= 5) {
      failures = 0;
      el.status.textContent = 'Песните не се зареждат. Провери папката music и сървъра.';
      return;
    }
    el.status.textContent = 'Тази песен не може да се пусне, зареждам друга…';
    await sleep(800);
    if (token === loadToken) newRound();
    return;
  }

  failures = 0;
  state.clip = result.clip;
  state.ready = true;
  Player.setClip(result.clip);
  Player.setLimit(STAGES[state.stage]);
  setFill('0%');
  el.playBtn.disabled = false;
  el.status.textContent = 'Натисни, за да чуеш';
  preloadNext();
}

function render() {
  renderProgress();
  setFill('0%');
  el.dur.textContent = fmt(STAGES[state.stage]);
  renderAttempts();
  updateAction();
}

function renderAttempts() {
  const rows = [];
  for (let i = 0; i < STAGES.length; i++) {
    const a = state.attempts[i];
    if (!a) { rows.push(`<li><span class="mark"></span><span></span><span class="time">${fmt(STAGES[i])}</span></li>`); continue; }
    const text = {
      skip: ['›', 'Пропуснато'],
      giveup: ['⚑', 'Отказ'],
      wrong: ['✕', a.song ? songLabel(a.song) : a.text],
      correct: ['✓', a.song && songLabel(a.song)],
    }[a.type];
    const cls = a.type === 'giveup' ? 'skip' : a.type;
    rows.push(`<li class="${cls}"><span class="mark">${text[0]}</span><span>${escapeHtml(text[1])}</span><span class="time">${fmt(STAGES[i])}</span></li>`);
  }
  el.attempts.innerHTML = rows.join('');
}

// Бутонът вдясно: Пропусни / Познай / Предай се
function updateAction() {
  const hasText = el.input.value.trim().length > 0;
  const last = state.stage === STAGES.length - 1;
  if (hasText) {
    el.action.className = 'action guess';
    el.action.textContent = 'Познай';
  } else if (last) {
    el.action.className = 'action giveup';
    el.action.textContent = 'Предай се';
  } else {
    el.action.className = 'action skip';
    el.action.textContent = 'Пропусни';
  }
}

// ===== Пускане =====
function onPlay() {
  if (!state.ready) return;
  Player.toggle();                           // свири ↔ пауза (продължава оттам, докъдето е)
  const on = Player.isPlaying();
  el.playBtn.classList.toggle('playing', on);
  if (on) el.status.textContent = 'Слушаш…';
  else if (!state.over) el.status.textContent = 'На пауза — продължи или познай';
}

// ===== Предположение =====
// Всеки опит (и пропускането) отива на сървъра — само той знае отговора.
async function onAction() {
  if (state.over || !state.song || state.busy) return;
  const text = el.input.value.trim();
  const last = state.stage === STAGES.length - 1;

  let song = null;
  if (text) {
    song = state.selected;
    if (!song) {
      const matches = search(text);
      const n = norm(text);
      song = matches.find((s) => norm(songLabel(s)) === n || norm(s.title) === n) ||
             (matches.length === 1 ? matches[0] : null);
    }
  }

  const round = state.song;
  state.busy = true;
  el.action.disabled = true;
  let r;
  try {
    r = await api('/api/guess', { round: round.round, song: song ? song.id : null });
  } catch (e) {
    state.busy = false;
    el.action.disabled = false;
    if (e.status === 410) { el.status.textContent = 'Рундът изтече — зареждам нова песен…'; await sleep(900); return newRound(); }
    el.status.textContent = 'Няма връзка със сървъра — опитай пак';
    return;
  }
  state.busy = false;
  el.action.disabled = false;
  if (state.song !== round) return;            // междувременно е сменен жанрът/рундът

  if (r.song) state.song = { ...round, ...r.song };   // разкрита песен (в края на рунда)

  if (r.correct) {
    state.attempts.push({ type: 'correct', song });
    return endRound(true);
  }
  if (!text) {
    state.attempts.push({ type: last ? 'giveup' : 'skip' });
  } else {
    // Грешен опит (или текст, който не е песен от списъка):
    // наказание — следващо ниво, и полето се изчиства.
    state.attempts.push({ type: 'wrong', song, text });
    shake(el.input);
    el.input.value = '';
    state.selected = null;
  }
  if (r.over) return endRound(false);
  advance();
}

function advance() {
  Player.stop(true);                 // спри и върни позицията в началото
  state.stage++;
  Player.setLimit(STAGES[state.stage]);
  el.hint.textContent = '';
  closeSuggestions();
  render();
  el.status.textContent = `Отключени ${fmt(STAGES[state.stage])}`;
}

function shake(node) {
  node.classList.remove('shake');
  void node.offsetWidth;
  node.classList.add('shake');
}

// ===== Край на рунда =====
function endRound(won) {
  Player.stop();
  state.over = true;
  el.input.disabled = true;
  closeSuggestions();
  renderProgress();
  renderAttempts();

  if (won) {
    state.streak++;
    state.wins++;
  } else {
    state.streak = 0;
  }
  saveStats();
  renderStats();

  const s = state.song;
  const n = state.attempts.length;
  el.card.className = 'card ' + (won ? 'win' : 'lose');
  el.badge.textContent = won ? '✓' : '✕';
  el.rTitle.textContent = won ? 'Позна!' : 'Не позна';
  el.rText.textContent = won
    ? `От ${ORDINALS[n - 1]} опит, за ${fmt(STAGES[n - 1]).replace('с', ' сек.')}`
    : 'Песента беше:';
  el.revTitle.textContent = s.title;
  el.revArtist.textContent = s.artist;
  paintCover(s);
  el.next.textContent = won ? 'Следваща песен' : 'Опитай пак';
  el.listen.classList.remove('playing');
  el.overlay.hidden = false;
  el.next.focus();
}

// Първо инициали върху цветен фон; ако има обложка, тя се зарежда отгоре.
// Обложката се тегли чак тук, на крайния екран, за да не издава песента по време на рунда.
function paintCover(s) {
  const h = hashStr(songLabel(s)) % 360;
  el.cover.style.background = `linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${(h + 50) % 360} 70% 25%))`;
  el.cover.textContent = s.artist.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const img = new Image();
  img.alt = '';
  img.onload = () => {
    if (state.song !== s) return;            // междувременно е започнала друга песен
    el.cover.textContent = '';
    el.cover.appendChild(img);
  };
  img.src = `/covers/${s.id}.jpg`;           // ако няма обложка → 404 и остават инициалите
}

function onListen() {
  if (Player.isPlaying()) { Player.pause(); el.listen.classList.remove('playing'); return; }
  if (!state.clip) return;
  Player.setClip(state.clip);
  Player.setLimit(state.clip.duration);   // на разкриващия екран — цялата
  el.listen.classList.add('playing');
  Player.play(0);
}

// ===== Търсене и падащ списък =====
let searchIndex = [];
let activeIdx = -1;
let shown = [];

function buildIndex() {
  searchIndex = SONGS.map((s) => ({ s, hay: norm(songLabel(s)) }));
}

function search(text) {
  const words = norm(text).split(' ').filter(Boolean);
  if (!words.length) return [];
  const tried = new Set(state.attempts.filter((a) => a.song).map((a) => a.song.id));
  return searchIndex
    .filter(({ s, hay }) => !tried.has(s.id) && words.every((w) => hay.includes(w)))
    .map(({ s }) => s)
    .slice(0, 100);
}

function openSuggestions() {
  const text = el.input.value.trim();
  if (!text || state.over) { closeSuggestions(); return; }
  shown = search(text);
  activeIdx = shown.length ? 0 : -1;
  el.sugg.innerHTML = shown.length
    ? shown.map((s, i) => `<li data-i="${i}" class="${i === activeIdx ? 'active' : ''}">${escapeHtml(s.title)}<small>${escapeHtml(s.artist)}</small></li>`).join('')
    : '<li class="empty">Няма такава песен</li>';
  el.sugg.hidden = false;
}

function closeSuggestions() {
  el.sugg.hidden = true;
  shown = [];
  activeIdx = -1;
}

function highlight(i) {
  activeIdx = i;
  [...el.sugg.children].forEach((li, j) => li.classList.toggle('active', j === i));
  el.sugg.children[i] && el.sugg.children[i].scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const s = shown[i];
  if (!s) return;
  state.selected = s;
  el.input.value = songLabel(s);
  el.hint.textContent = '';
  closeSuggestions();
  updateAction();
  el.input.focus();
}

// ===== Статистика =====
function saveStats() {
  try { localStorage.setItem('pp-stats', JSON.stringify({ streak: state.streak, wins: state.wins })); } catch (e) { /* няма място */ }
}
function loadStats() {
  try {
    const d = JSON.parse(localStorage.getItem('pp-stats') || '{}');
    state.streak = d.streak || 0;
    state.wins = d.wins || 0;
  } catch (e) { /* няма записани */ }
}
function renderStats() {
  el.streak.textContent = state.streak;
  el.wins.textContent = state.wins;
}

// ===== Събития =====
el.playBtn.addEventListener('click', onPlay);
el.action.addEventListener('click', onAction);
el.next.addEventListener('click', newRound);
el.listen.addEventListener('click', onListen);

el.genres.addEventListener('click', (e) => {
  const btn = e.target.closest('.genre');
  if (!btn || btn.dataset.genre === state.genre) return;
  saveRound(state.genre);               // запомни текущия незавършен рунд
  state.genre = btn.dataset.genre;
  try { localStorage.setItem('pp-genre', state.genre); } catch (err) { /* без запомняне */ }
  [...el.genres.children].forEach((b) => b.classList.toggle('active', b === btn));
  if (rounds[state.genre]) restoreRound(state.genre);   // върни същата песен, ако има
  else newRound();
});

// Как да се изписва жанрът в играта: ключ = името на папката, стойност = надписът на бутона.
// Папка, която я няма тук, се показва с името си. Добавяй нови редове при нужда.
const GENRE_LABELS = {
  'Хип-хоп': 'Хип-хоп/Рап',
  'Поп-фолк': 'Поп-фолк/Чалга',
};

// Бутоните за жанр се правят от наличните жанрове (подпапките в music)
function renderGenres(genres) {
  const names = genres.map((g) => g.genre);
  if (state.genre !== 'all' && !names.includes(state.genre)) state.genre = 'all';
  el.genres.innerHTML = [{ genre: 'all', label: 'Всички' }, ...genres.map((g) => ({ genre: g.genre, label: GENRE_LABELS[g.genre] || g.genre }))]
    .map((g) => `<button class="genre${g.genre === state.genre ? ' active' : ''}" data-genre="${escapeHtml(g.genre)}">${escapeHtml(g.label)}</button>`)
    .join('');
  el.genres.hidden = genres.length < 2;
}

el.input.addEventListener('input', () => {
  state.selected = null;
  el.hint.textContent = '';
  updateAction();
  openSuggestions();
});
el.input.addEventListener('focus', openSuggestions);

el.input.addEventListener('keydown', (e) => {
  const open = !el.sugg.hidden && shown.length;
  if (e.key === 'ArrowDown' && open) { e.preventDefault(); highlight((activeIdx + 1) % shown.length); }
  else if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlight((activeIdx - 1 + shown.length) % shown.length); }
  else if (e.key === 'Escape') closeSuggestions();
  else if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();   // иначе същият Enter веднага затваря екрана с резултата
    if (open && activeIdx >= 0) choose(activeIdx);
    else onAction();
  }
});

el.sugg.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) { e.preventDefault(); choose(+li.dataset.i); }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) closeSuggestions();
});

document.addEventListener('keydown', (e) => {
  if (!el.overlay.hidden && e.key === 'Enter' && document.activeElement !== el.listen) {
    e.preventDefault();
    newRound();
  }
});

// ===== Плейър: ticks за запълването + слайдър по прогрес бара =====
function initPlayer() {
  Player.setCallbacks(
    (pos) => setFill(timeToPct(pos) + '%'),
    () => {
      el.playBtn.classList.remove('playing');
      el.listen.classList.remove('playing');
      if (!state.over) el.status.textContent = 'Пусни отново или познай';
    }
  );

  let scrubbing = false, resume = false;
  const timeAt = (clientX) => {
    const r = el.progress.getBoundingClientRect();
    let f = (clientX - r.left) / r.width;
    f = Math.max(0, Math.min(1, f));
    return Math.min(f * TOTAL, STAGES[state.stage]);   // само до отключеното ниво
  };
  el.progress.addEventListener('pointerdown', (e) => {
    if (!state.ready || state.over) return;
    scrubbing = true;
    resume = Player.isPlaying();
    if (resume) Player.pause();
    try { el.progress.setPointerCapture(e.pointerId); } catch (_) {}
    Player.seek(timeAt(e.clientX));
    e.preventDefault();
  });
  el.progress.addEventListener('pointermove', (e) => { if (scrubbing) Player.seek(timeAt(e.clientX)); });
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (resume) {
      Player.play();                        // продължи от новата позиция
      el.playBtn.classList.add('playing');
      el.status.textContent = 'Слушаш…';
    }
  };
  el.progress.addEventListener('pointerup', endScrub);
  el.progress.addEventListener('pointercancel', endScrub);
}

// ===== Сила на звука =====
function initVolume() {
  let v = 1;
  try { const s = localStorage.getItem('pp-vol'); if (s !== null) v = Number(s); } catch (e) { /* няма запис */ }
  if (!(v >= 0 && v <= 1)) v = 1;
  Player.setVolume(v);
  if (el.volRange) {
    el.volRange.value = Math.round(v * 100);
    el.volRange.addEventListener('input', () => {
      const nv = Number(el.volRange.value) / 100;
      Player.setVolume(nv);
      try { localStorage.setItem('pp-vol', String(nv)); } catch (e) { /* без запомняне */ }
    });
  }
}

// ===== Старт =====
async function start() {
  buildProgress();
  initPlayer();
  initVolume();
  loadStats();
  renderStats();
  render();
  el.playBtn.disabled = true;
  try { state.genre = localStorage.getItem('pp-genre') || 'all'; } catch (e) { state.genre = 'all'; }
  try {
    const [songs, g] = await Promise.all([api('/api/songs'), api('/api/genres')]);
    SONGS = songs;
    renderGenres(g.genres);
  } catch (e) {
    el.status.textContent = 'Няма връзка със сървъра. Пуснат ли е?';
    return;
  }
  buildIndex();
  if (!SONGS.length) {
    el.status.textContent = 'Базата е празна. Добави песни от localhost:3000/admin';
    return;
  }
  newRound();
}

start();
