// Сваля обложки за песните в data/covers/<id>.jpg
// Ред на търсене: Deezer (песен) → iTunes (песен) → Deezer (снимка на изпълнителя)
//                 → вградена картинка във файла (ако има) → нищо (играта показва инициали).
//
// Пускане (като ubuntu, сайтът може да си работи):
//   node fetch_covers.js --limit 20     пробно, само първите 20 без обложка
//   node fetch_covers.js                всички без обложка
//   node fetch_covers.js --retry        опитва пак и тези, за които преди не е намерено
//   node fetch_covers.js --id 393       само една песен (презаписва)
//   node fetch_covers.js --misses       само тези, за които преди не е намерено
//
// Отчет: data/covers/_report.json — откъде е всяка обложка и колко е сигурно съвпадението.
// Ръчна обложка: сложи JPG като data/covers/<id>.jpg — скриптът не я пипа.

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { q } = require('./db');
const lib = require('./library');

const DIR = path.join(__dirname, 'data', 'covers');
const REPORT = path.join(DIR, '_report.json');
const MAX_BYTES = 1024 * 1024;
const args = process.argv.slice(2);
const opt = (name) => args.includes(name);
const val = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

fs.mkdirSync(DIR, { recursive: true });
const report = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
const touched = new Set();   // записваме само песните от този пуск — промените от /admin междувременно остават
const saveReport = () => {
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch (e) { /* още няма */ }
  for (const id of touched) disk[id] = report[id];
  const tmp = REPORT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(disk, null, 1));
  fs.renameSync(tmp, REPORT);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- сравнение на имена (същата логика като при повторенията в library.js) ----------
const FEAT_BG = /\s+(?:вкл\.?|с участието на|feat\.?|ft\.?)\s+.*$/i;   // „Недей ме напряга вкл. VRGO“
const JUNK = /\(.*?\)|\[.*?\]|official\s*(music\s*)?(video|audio)|lyric(s)?\s*video|\bvideo\b|\baudio\b|\bhd\b|\b4k\b|премиера|клип/gi;
const LEADNUM = /^\s*(?:0\d\s*[.\-_)]?|\d{1,3}\s*[.\-_)])\s*(?=\D)/;   // „09 Dim4ou“, „03.Боро Първи“, „1. Песен“ — но не „50 Cent“
const cleanTitle = (t) => String(t).replace(LEADNUM, '').replace(JUNK, ' ').replace(FEAT_BG, '').replace(/\s+/g, ' ').trim();
const mainArtist = (a) => String(a).replace(LEADNUM, '').split(/\s*(?:,|&| и | x | х | вкл\.? |\bft\.?|\bfeat\.?)\s*/i)[0].trim();

// Deezer/iTunes не транслитерират сами: „Lud li si“ не намира „Луд ли си“. Затова търсим и в двете азбуки.
const LAT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sht',ъ:'a',ь:'y',ю:'yu',я:'ya' };
const CYR = [['sht','щ'],['sh','ш'],['ch','ч'],['zh','ж'],['ts','ц'],['yu','ю'],['ya','я'],['dj','дж'],
  ['a','а'],['b','б'],['v','в'],['g','г'],['d','д'],['e','е'],['z','з'],['i','и'],['y','й'],['k','к'],['l','л'],
  ['m','м'],['n','н'],['o','о'],['p','п'],['r','р'],['s','с'],['t','т'],['u','у'],['f','ф'],['h','х'],['c','ц'],
  ['j','й'],['w','в'],['q','я'],['x','кс'],['4','ч'],['6','ш']];
const toLat = (s) => s.replace(/[а-яА-Я]/g, (c) => { const l = LAT[c.toLowerCase()] ?? c; return c === c.toLowerCase() ? l : l.charAt(0).toUpperCase() + l.slice(1); });
function toCyr(s) {
  if (/[а-я]/i.test(s)) return s;                  // вече е на кирилица
  let out = '', i = 0;
  const low = s.toLowerCase();
  while (i < s.length) {
    const hit = CYR.find(([l]) => low.startsWith(l, i));
    if (!hit) { out += s[i]; i++; continue; }
    const up = s[i] !== low[i];
    out += up ? hit[1].charAt(0).toUpperCase() + hit[1].slice(1) : hit[1];
    i += hit[0].length;
  }
  return out;
}
// Варианти за търсене: оригинал, всичко на латиница, всичко на кирилица (без повторения)
function variants(A, T) {
  const seen = new Set(), out = [];
  const toLatU = (x) => toLat(String(x).replace(/ъ/g, 'у').replace(/Ъ/g, 'У'));
  for (const [a, t] of [[A, T], [toLat(A), toLat(T)], [toLatU(A), toLatU(T)], [toCyr(A), toCyr(T)], [A, toCyr(T)], [A, toLat(T)]]) {
    const k = (a + '|' + t).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push([a, t]); }
  }
  return out;
}
const artistKey = (a) => lib.songKey(String(a).replace(LEADNUM, ''), 'x').split('|')[0];
const titleKey = (t) => lib.songKey('x', cleanTitle(t)).split('|')[1];

// Прилика между два низа (0..1) по двойки букви
function similar(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const p = s.slice(i, i + 2); m.set(p, (m.get(p) || 0) + 1); } return m; };
  const A = pairs(a), B = pairs(b);
  let hit = 0;
  for (const [p, n] of A) hit += Math.min(n, B.get(p) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
// „ъ“ се пише и като „a“, и като „u“ (Първи = Parvi / Purvi) — сравняваме и двата варианта
const yer = (s) => [String(s), String(s).replace(/ъ/g, 'у').replace(/Ъ/g, 'У')];
function artistMatch(want, got) {
  let m = 0;
  for (const w of yer(want)) for (const g of yer(got)) m = Math.max(m, artistMatch1(w, g));
  return m;
}
function titleMatch(want, got) {
  let m = 0;
  for (const w of yer(want)) for (const g of yer(got)) m = Math.max(m, titleMatch1(w, g));
  return m;
}
function artistMatch1(want, got) {
  const w = artistKey(want), g = artistKey(got);
  if (!w || !g) return 0;
  if (w === g) return 1;
  // „F.O.“ в „F.O. & Imera“ — но не „Ива“ в „Иван“
  if ((g.startsWith(w) || w.startsWith(g)) && Math.min(w.length, g.length) >= 4) return 0.95;
  return similar(w, g);
}
function titleMatch1(want, got) {
  const w = titleKey(want), g = titleKey(got);
  if (!w || !g) return 0;
  if (w === g) return 1;
  if ((g.includes(w) || w.includes(g)) && Math.min(w.length, g.length) >= 4) return 0.9;
  return similar(w, g);
}

// ---------- мрежа ----------
async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'chalgadle-cover-fetcher/1.0' }, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status === 403) { await sleep(10000); continue; }
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.error && data.error.code === 4) { await sleep(5000); continue; } // Deezer: твърде много заявки
      return data;
    } catch (e) { await sleep(2000); }
  }
  return null;
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/jpeg')) throw new Error('не е JPEG: ' + type);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500 || buf.length > MAX_BYTES) throw new Error('странен размер: ' + buf.length);
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error('не е JPEG по съдържание');
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

// ---------- източници ----------
let lastDeezer = 0, lastItunes = 0;
async function throttle(kind) {
  // Deezer позволява ~50 заявки / 5 сек; iTunes ~20 / минута
  const gap = kind === 'deezer' ? 200 : 3200;
  const last = kind === 'deezer' ? lastDeezer : lastItunes;
  const wait = last + gap - Date.now();
  if (wait > 0) await sleep(wait);
  if (kind === 'deezer') lastDeezer = Date.now(); else lastItunes = Date.now();
}

function best(cands, song) {
  let top = null;
  for (const c of cands) {
    const a = artistMatch(song.artist, c.artist);
    const t = titleMatch(song.title, c.title);
    const score = Math.min(a, t);
    // при равенство — по-краткото заглавие (оригиналът, а не „… [Remix]“)
    if (!top || score > top.score || (score === top.score && String(c.title).length < String(top.title).length)) top = { ...c, a, t, score };
  }
  return top;
}

let nearest = null;   // най-близкото отхвърлено съвпадение — записва се в отчета, за да се види защо
function remember(top) { if (top && (!nearest || top.score > nearest.score)) nearest = top; }

async function fromDeezer(song) {
  const A = mainArtist(song.artist), T = cleanTitle(song.title);
  const queries = [`artist:"${A}" track:"${T}"`];
  for (const [a, t] of variants(A, T)) queries.push(`${a} ${t}`);
  for (const [, t] of variants(A, T)) queries.push(`track:"${t}"`);       // само по заглавие, изпълнителят се проверява после
  for (const qs of [...new Set(queries)]) {
    await throttle('deezer');
    const data = await getJson(`https://api.deezer.com/search?limit=15&q=${encodeURIComponent(qs)}`);
    const list = (data && data.data) || [];
    const top = best(list.map((d) => ({
      artist: d.artist && d.artist.name, title: d.title,
      img: d.album && (d.album.cover_medium || d.album.cover_big),
    })).filter((c) => c.img), song);
    if (top && top.score >= 0.75) return { source: 'deezer', ...top };
    remember(top);
  }
  return null;
}

async function fromItunes(song) {
  const A = mainArtist(song.artist), T = cleanTitle(song.title);
  // Българският магазин има повече местна музика от американския (по подразбиране)
  const tries = [['BG', A, T], ['BG', toCyr(A), toCyr(T)], ['US', A, T]];
  for (const [country, a, t] of tries) {
    await throttle('itunes');
    const data = await getJson(`https://itunes.apple.com/search?entity=song&limit=15&country=${country}&term=${encodeURIComponent(`${a} ${t}`)}`);
    const list = (data && data.results) || [];
    const top = best(list.map((d) => ({
      artist: d.artistName, title: d.trackName,
      img: d.artworkUrl100 && d.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/300x300bb.jpg'),
    })).filter((c) => c.img), song);
    if (top && top.score >= 0.75) return { source: 'itunes', ...top };
    remember(top);
  }
  return null;
}

async function fromDeezerArtist(song) {
  const A = mainArtist(song.artist);
  let list = [];
  for (const a of [...new Set([A, toLat(A), toCyr(A)])]) {
    await throttle('deezer');
    const data = await getJson(`https://api.deezer.com/search/artist?limit=5&q=${encodeURIComponent(a)}`);
    list = list.concat((data && data.data) || []);
  }
  let top = null;
  for (const d of list) {
    const a = artistMatch(A, d.name);
    // снимка-заместител от Deezer (без лице) не ни трябва
    if (!d.picture_medium || /\/artist\/\//.test(d.picture_medium)) continue;
    if (!top || a > top.a) top = { artist: d.name, title: '(снимка на изпълнителя)', img: d.picture_medium, a, t: 0, score: a };
  }
  if (top && top.a >= 0.95) return { source: 'deezer-artist', ...top };
  return null;
}

const FFMPEG = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : null;
function fromEmbedded(song, dest) {
  if (!FFMPEG) return null;
  const src = lib.resolve(song.file);
  if (!src || !fs.existsSync(src)) return null;
  const tmp = dest + '.tmp.jpg';
  try {
    // YouTube картинките са 16:9 → режем квадрат от средата
    execFileSync(FFMPEG, ['-nostdin', '-y', '-v', 'error', '-i', src, '-an', '-map', '0:v:0', '-frames:v', '1',
      '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=300:300", '-q:v', '4', tmp], { stdio: 'ignore' });
    if (fs.statSync(tmp).size < 500) throw new Error('празна');
    fs.renameSync(tmp, dest);
    return { source: 'embedded', score: 1 };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }
}

// ---------- главно ----------
(async () => {
  const onlyId = val('--id') ? Number(val('--id')) : null;
  const limit = val('--limit') ? Number(val('--limit')) : Infinity;
  const retry = opt('--retry') || opt('--misses');
  const missesOnly = opt('--misses');

  let songs = q.adminAll.all();
  if (onlyId) songs = songs.filter((s) => s.id === onlyId);
  const todo = songs.filter((s) => {
    const file = path.join(DIR, `${s.id}.jpg`);
    if (onlyId) return true;
    if (fs.existsSync(file)) return false;                      // вече има (или е ръчна)
    const prev = report[s.id];
    if (prev && (prev.source === 'rejected' || prev.source === 'manual')) return false;   // решено от теб в /admin
    if (missesOnly) return !!prev && prev.source === 'none';
    if (prev && prev.source === 'none' && !retry) return false;
    return true;
  }).slice(0, limit);

  console.log(`Песни без обложка за обработка: ${todo.length}\n`);
  const count = { deezer: 0, itunes: 0, 'deezer-artist': 0, embedded: 0, none: 0, errors: 0 };
  const review = [];

  for (const [i, s] of todo.entries()) {
    const dest = path.join(DIR, `${s.id}.jpg`);
    let hit = null;
    nearest = null;
    try {
      hit = await fromDeezer(s) || await fromItunes(s);
      if (hit) await download(hit.img, dest);
      else {
        hit = fromEmbedded(s, dest);
        if (!hit) {
          hit = await fromDeezerArtist(s);
          if (hit) await download(hit.img, dest);
        }
      }
    } catch (e) {
      console.error(`  грешка при ${s.id} (${s.artist} – ${s.title}): ${e.message}`);
      count.errors++;
      hit = null;
    }

    const src = hit ? hit.source : 'none';
    count[src]++;
    touched.add(String(s.id));
    report[s.id] = {
      source: src,
      song: `${s.artist} – ${s.title}`,
      matched: hit && hit.artist ? `${hit.artist} – ${hit.title}` : null,
      score: hit && hit.score !== undefined ? Math.round(hit.score * 100) / 100 : null,
      nearest: !hit && nearest ? `${nearest.artist} – ${nearest.title} (${Math.round(nearest.score * 100) / 100})` : undefined,
      at: new Date().toISOString(),
    };
    if (hit && hit.score < 1) review.push(`${s.id}: ${s.artist} – ${s.title}  →  ${report[s.id].matched} (${report[s.id].score})`);
    if ((i + 1) % 25 === 0) { saveReport(); console.log(`  …${i + 1}/${todo.length}`); }
  }
  saveReport();

  console.log('\n==== Готово ====');
  console.log(`Deezer (обложка):        ${count.deezer}`);
  console.log(`iTunes (обложка):        ${count.itunes}`);
  console.log(`Вградена във файла:      ${count.embedded}`);
  console.log(`Снимка на изпълнителя:   ${count['deezer-artist']}`);
  console.log(`Без обложка (инициали):  ${count.none}`);
  console.log(`Грешки:                  ${count.errors}`);
  const misses = todo.filter((s) => report[s.id].source === 'none');
  if (misses.length) {
    console.log(`\nБез обложка (${misses.length}) — най-близкото намерено:`);
    for (const s of misses) console.log(`  ${s.id}: ${s.artist} – ${s.title}  →  ${report[s.id].nearest || 'нищо'}`);
  }
  if (review.length) {
    console.log(`\nЗа преглед — не съвсем сигурни съвпадения (${review.length}):`);
    for (const r of review) console.log('  ' + r);
    console.log('\nАко някоя е грешна: изтрий data/covers/<id>.jpg (или сложи правилната на нейно място).');
  }
})();
