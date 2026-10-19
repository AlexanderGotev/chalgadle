// Сървър на играта — само с вградените в Node.js модули, без npm install.
// Пускане:  node server.js
//   Играта:            http://localhost:3000
//   Управление:        http://localhost:3000/admin   (само от този компютър)
// Песните се слагат в папка music/<жанр>/... и се добавят с бутон „Сканирай“ в /admin.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, q, randomSong } = require('./db');
const lib = require('./library');

const PORT = 3000;
const PUBLIC = path.join(__dirname, 'public');
const COVERS = path.join(__dirname, 'data', 'covers');   // обложки <id>.jpg (fetch_covers.js)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ===== Помощни =====
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too-big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { return {}; }
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Няма такава страница'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// Стрийминг на песен с поддръжка на Range (превъртане, частично зареждане)
function serveAudio(req, res, song) {
  const abs = lib.resolve(song.file);
  if (!abs) return send(res, 403, { error: 'Забранено' });
  fs.stat(abs, (err, st) => {
    if (err) return send(res, 404, { error: 'Файлът липсва в папката music' });
    const type = lib.MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      let start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : st.size - 1;
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(abs, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      fs.createReadStream(abs).pipe(res);
    }
  });
}

// ===== Достъп =====
// Заявка от самия компютър (а не от приятел по мрежата)?
// Важно: ако има X-Forwarded-For, заявката е минала през Caddy/прокси —
// значи идва отвън, не е локална, дори адресът да е 127.0.0.1.
// Само SSH тунелът стига до Node директно (без това заглавие).
// Caddy винаги добавя X-Forwarded-For и клиентът не може да го махне,
// затова проверката „отказва при наличие" е безопасна (fail-closed).
function isLocal(req) {
  if (req.headers['x-forwarded-for'] || req.headers['forwarded']) return false;
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
// Само тези адреси са отворени за другите; всичко останало (/admin, промени) е само за този компютър
const PUBLIC_POST = new Set(['/api/guess']);   // единствената промяна, разрешена отвън: опит за познаване
function allowedFromNetwork(req, p) {
  if (req.method === 'POST' && PUBLIC_POST.has(p)) return true;
  if (req.method !== 'GET') return false;
  if (/^\/audio\/\d+$/.test(p)) return false;            // по номер — само за /admin; играта ползва /audio/r/<рунд>
  if (p === '/admin' || p === '/admin/' || /^\/admin\./.test(p)) return false;
  if (p.startsWith('/api/admin/') || p.startsWith('/api/scan')) return false;
  return true;
}

// ===== API =====
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// --- за играта ---
route('GET', /^\/api\/genres$/, (req, res) => {
  const genres = q.genres.all();
  send(res, 200, { genres, total: genres.reduce((s, g) => s + g.n, 0) });
});

route('GET', /^\/api\/songs$/, (req, res) => send(res, 200, q.publicAll.all()));

// ===== Рундове =====
// Отговорът стои само тук. Браузърът получава случаен код на рунда, тегли аудиото по него
// и праща опитите си; името на песента научава чак когато рундът свърши.
const ROUND_TRIES = 5;                  // колкото са стъпките в играта (0,1 / 0,5 / 2 / 8 / 16 сек)
const ROUND_TTL = 6 * 3600 * 1000;
const ROUND_MAX = 50000;                // таван на паметта: най-старите рундове се забравят
const rounds = new Map();               // код → { id, tries, over, t }

function openRound(songId) {
  const code = crypto.randomBytes(16).toString('base64url');
  rounds.set(code, { id: songId, tries: 0, over: false, t: Date.now() });
  if (rounds.size > ROUND_MAX) rounds.delete(rounds.keys().next().value);
  return code;
}
const roundOf = (code) => (typeof code === 'string' && code.length <= 32 ? rounds.get(code) : undefined);
setInterval(() => {
  const old = Date.now() - ROUND_TTL;
  for (const [code, r] of rounds) { if (r.t < old) rounds.delete(code); else break; }
}, 10 * 60 * 1000).unref();

function reveal(id) {
  const s = q.byId.get(id);
  return s ? { id: s.id, artist: s.artist, title: s.title, genre: s.genre } : null;
}

// Случаен рунд от жанр, без вече изиграните (exclude=<код>,<код>…).
// Ако всички са изиграни, връща reset: true и започва отначало.
route('GET', /^\/api\/random$/, (req, res, url) => {
  const genre = url.searchParams.get('genre') || 'all';
  const exclude = (url.searchParams.get('exclude') || '').split(',').slice(-500)
    .map((c) => roundOf(c)).filter(Boolean).map((r) => r.id);
  const lastRound = roundOf(url.searchParams.get('last'));
  let song = randomSong(genre, exclude);
  let reset = false;
  if (!song && exclude.length) {
    song = randomSong(genre, lastRound ? [lastRound.id] : []) || randomSong(genre, []);
    reset = true;
  }
  if (!song) return send(res, 404, { error: 'Няма песни в този жанр' });
  send(res, 200, { song: { round: openRound(song.id), start: song.start }, reset });
});

// Опит: { round, song: <id от списъка> | null (пропусни / непозната песен) }
route('POST', /^\/api\/guess$/, async (req, res) => {
  const b = await readJson(req);
  const r = roundOf(b.round);
  if (!r) return send(res, 410, { error: 'Рундът е изтекъл' });
  if (r.over) return send(res, 200, { correct: false, over: true, song: reveal(r.id) });
  r.tries++;
  const correct = Number(b.song) === r.id;
  if (correct || r.tries >= ROUND_TRIES) {
    r.over = true;
    return send(res, 200, { correct, over: true, song: reveal(r.id) });
  }
  send(res, 200, { correct: false, over: false, left: ROUND_TRIES - r.tries });
});

route('GET', /^\/audio\/r\/([A-Za-z0-9_-]{1,32})$/, (req, res, url, m) => {
  const r = roundOf(m[1]);
  const song = r && q.byId.get(r.id);
  if (!song || song.hidden) return send(res, 404, { error: 'Няма такъв рунд' });
  serveAudio(req, res, song);
});

// Обложка — само число в името, затова не може да се излезе от папката
route('GET', /^\/covers\/(\d+)\.jpg$/, (req, res, url, m) => {
  const song = q.byId.get(Number(m[1]));
  if (!song || song.hidden) return send(res, 404, { error: 'Няма обложка' });
  fs.readFile(path.join(COVERS, `${song.id}.jpg`), (err, data) => {
    if (err) return send(res, 404, { error: 'Няма обложка' });
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Content-Length': data.length });
    res.end(data);
  });
});

// --- обложки: преглед и ръчна смяна (само от този компютър) ---
const COVER_REPORT = path.join(COVERS, '_report.json');
function readCoverReport() {
  try { return JSON.parse(fs.readFileSync(COVER_REPORT, 'utf8')); } catch (e) { return {}; }
}
function writeCoverReport(r) {
  fs.mkdirSync(COVERS, { recursive: true });
  const tmp = COVER_REPORT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(r, null, 1));
  fs.renameSync(tmp, COVER_REPORT);
}
const coverFile = (id) => path.join(COVERS, `${id}.jpg`);
const FOUND = new Set(['deezer', 'itunes', 'deezer-artist', 'embedded']);

// ?show=review (несигурни, непрегледани) | missing (без обложка)
route('GET', /^\/api\/admin\/covers$/, (req, res, url) => {
  const show = url.searchParams.get('show') === 'missing' ? 'missing' : 'review';
  const rep = readCoverReport();
  const out = [];
  for (const s of q.adminAll.all()) {
    const r = rep[s.id];
    const has = fs.existsSync(coverFile(s.id));
    if (show === 'review') {
      if (!has || !r || !FOUND.has(r.source) || r.reviewed) continue;
      if (r.score !== null && r.score >= 1 && r.source !== 'deezer-artist') continue;
    } else if (has || !r || !['none', 'rejected'].includes(r.source)) continue;   // само обработените от скрипта
    out.push({ id: s.id, artist: s.artist, title: s.title, has,
      source: r ? r.source : null, matched: r ? r.matched : null, score: r ? r.score : null,
      nearest: r ? r.nearest || null : null });
  }
  send(res, 200, { show, items: out });
});

// Одобряване наведнъж — само на изпратените id-та (тези, които си видял в списъка)
route('POST', /^\/api\/admin\/covers\/approve$/, async (req, res) => {
  const b = await readJson(req);
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 10000);
  const rep = readCoverReport();
  let n = 0;
  for (const id of ids) {
    if (!rep[id] || !fs.existsSync(coverFile(id))) continue;
    rep[id] = { ...rep[id], reviewed: true };
    n++;
  }
  writeCoverReport(rep);
  send(res, 200, { approved: n });
});

route('POST', /^\/api\/admin\/covers\/(\d+)\/(approve|reject)$/, (req, res, url, m) => {
  const id = Number(m[1]);
  if (!q.byId.get(id)) return send(res, 404, { error: 'Няма такава песен' });
  const rep = readCoverReport();
  const r = rep[id] || {};
  if (m[2] === 'approve') rep[id] = { ...r, reviewed: true };
  else {
    try { fs.unlinkSync(coverFile(id)); } catch (e) { /* вече я няма */ }
    rep[id] = { ...r, source: 'rejected', reviewed: true };   // скриптът няма да я търси пак
  }
  writeCoverReport(rep);
  send(res, 200, { ok: true });
});

// Ръчна обложка: тялото на заявката е самият JPEG файл (до 1 MB)
route('PUT', /^\/api\/admin\/covers\/(\d+)$/, async (req, res, url, m) => {
  const id = Number(m[1]);
  if (!q.byId.get(id)) return send(res, 404, { error: 'Няма такава песен' });
  let buf;
  try { buf = await readBody(req, 1024 * 1024); } catch (e) { return send(res, 413, { error: 'Файлът е над 1 MB' }); }
  if (buf.length < 500 || buf[0] !== 0xFF || buf[1] !== 0xD8) return send(res, 400, { error: 'Трябва да е JPG картинка' });
  fs.mkdirSync(COVERS, { recursive: true });
  const tmp = coverFile(id) + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, coverFile(id));
  const rep = readCoverReport();
  rep[id] = { ...(rep[id] || {}), source: 'manual', reviewed: true, score: 1, at: new Date().toISOString() };
  writeCoverReport(rep);
  send(res, 200, { ok: true });
});

route('GET', /^\/audio\/(\d+)$/, (req, res, url, m) => {
  const song = q.byId.get(Number(m[1]));
  if (!song || song.hidden) return send(res, 404, { error: 'Няма такава песен' });
  serveAudio(req, res, song);
});

// --- управление (само от този компютър) ---
route('GET', /^\/api\/admin\/songs$/, (req, res) => {
  send(res, 200, { songs: q.adminAll.all(), hidden: q.hiddenCount.get().n });
});

route('PUT', /^\/api\/admin\/songs\/(\d+)$/, async (req, res, url, m) => {
  const id = Number(m[1]);
  const s = q.byId.get(id);
  if (!s) return send(res, 404, { error: 'Няма такава песен' });
  const b = await readJson(req);
  const artist = String(b.artist ?? s.artist).trim();
  const title = String(b.title ?? s.title).trim();
  const genre = String(b.genre ?? s.genre).trim();
  if (!artist || !title || !genre) return send(res, 400, { error: 'Изпълнител, заглавие и жанр са задължителни' });
  q.update.run({ id, artist, title, genre });
  if (b.start !== undefined && b.start !== null) {
    const start = Number(b.start);
    if (!Number.isFinite(start) || start < 0) return send(res, 400, { error: 'Невалидна начална секунда' });
    q.setStart.run({ id, start: Math.round(start * 100) / 100, manual: b.manual === false ? 0 : 1 });
  }
  send(res, 200, q.byId.get(id));
});

// Резултат от автоматичния анализ (прави се в браузъра)
route('POST', /^\/api\/admin\/songs\/(\d+)\/analysis$/, async (req, res, url, m) => {
  const id = Number(m[1]);
  if (!q.byId.get(id)) return send(res, 404, { error: 'Няма такава песен' });
  const b = await readJson(req);
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
  if (num(b.start) === null) return send(res, 400, { error: 'Липсва начало' });
  if (b.resetManual) q.setStart.run({ id, start: num(b.start), manual: 0 });
  q.setAnalysis.run({
    id, auto_start: num(b.start), entry: num(b.entry), duration: num(b.duration),
    choruses: JSON.stringify(Array.isArray(b.choruses) ? b.choruses.slice(0, 40) : []),
    reason: String(b.reason || '').slice(0, 120),
  });
  send(res, 200, q.byId.get(id));
});

route('DELETE', /^\/api\/admin\/songs\/(\d+)$/, (req, res, url, m) => {
  const id = Number(m[1]);
  const s = q.byId.get(id);
  if (!s) return send(res, 404, { error: 'Няма такава песен' });
  // Файлът остава в music; песента само се скрива, за да не я върне следващото сканиране
  q.hide.run(id);
  send(res, 200, { ok: true });
});

route('POST', /^\/api\/admin\/unhide$/, (req, res) => {
  const info = q.unhideAll.run();
  send(res, 200, { restored: info.changes });
});

// --- сканиране ---
route('GET', /^\/api\/scan$/, (req, res) => {
  send(res, 200, lib.preview(q.allFiles.all()));
});

route('POST', /^\/api\/scan$/, async (req, res) => {
  const b = await readJson(req);
  const p = lib.preview(q.allFiles.all());
  const take = new Set(Array.isArray(b.files) ? b.files : p.add.map((a) => a.file));
  const removeMissing = new Set(Array.isArray(b.removeMissing) ? b.removeMissing.map(Number) : []);
  let added = 0, removed = 0;
  db.exec('BEGIN');
  try {
    for (const a of p.add) {
      if (!take.has(a.file)) continue;
      q.insert.run({ file: a.file, artist: a.artist || '(без изпълнител)', title: a.title || a.file, genre: a.genre, size: a.size });
      added++;
    }
    for (const m of p.missing) if (removeMissing.has(m.id)) { q.remove.run(m.id); removed++; }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(e);
    return send(res, 500, { error: 'Грешка при записа в базата' });
  }
  send(res, 200, { added, removed });
});

// ===== Сървър =====
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, { error: 'Невалиден адрес' }); }

  if (!isLocal(req) && !allowedFromNetwork(req, p)) {
    return send(res, 403, { error: 'Тази страница е достъпна само от компютъра, на който върви сървърът' });
  }

  try {
    if (p.startsWith('/api/') || p.startsWith('/audio/') || p.startsWith('/covers/')) {
      for (const r of routes) {
        const m = r.method === req.method && p.match(r.pattern);
        if (m) return await r.handler(req, res, url, m);
      }
      return send(res, 404, { error: 'Няма такъв адрес' });
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'Не е позволено' });
    if (p === '/') return serveFile(res, path.join(PUBLIC, 'index.html'));
    if (p === '/admin' || p === '/admin/') return serveFile(res, path.join(PUBLIC, 'admin.html'));

    const file = path.join(PUBLIC, p);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'Забранено' });
    serveFile(res, file);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Грешка в сървъра' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Порт ${PORT} е зает. Може би сървърът вече е пуснат в друг прозорец.\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

// Слуша само на 127.0.0.1 — отвън се стига само през Caddy (и Cloudflare пред него).
server.listen(PORT, '127.0.0.1', () => {
  const n = q.genres.all().reduce((s, g) => s + g.n, 0);
  console.log('');
  console.log(`  Песни в базата:     ${n}`);
  console.log(`  Играта (ти):        http://localhost:${PORT}`);
  console.log(`  Управление:         http://localhost:${PORT}/admin   (само от този компютър)`);
  console.log(`  Папка с песните:    ${lib.MUSIC}`);
  console.log('');
  console.log('  Спиране: Ctrl+C');
});
