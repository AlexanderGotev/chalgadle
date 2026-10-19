// Сканиране на папката music: жанр = подпапка, изпълнител/заглавие от таговете
// във файла или от името му, търсене на повторения.
const fs = require('fs');
const path = require('path');

const MUSIC = path.join(__dirname, 'music');
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac']);
const MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
};

fs.mkdirSync(MUSIC, { recursive: true });

// ---------- текст ----------
const CP1251 = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
function decodeCp1251(buf) {
  let s = '';
  for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : CP1251[b - 0x80];
  return s;
}
// Много български MP3-та пишат тагове в Windows-1251, обявени като Latin-1
function decodeLatinOrCp1251(buf) {
  let high = 0;
  for (const b of buf) if (b >= 0xC0) high++;
  return high >= 2 ? decodeCp1251(buf) : buf.toString('latin1');
}
const clean0 = (s) => s.replace(/\u0000+$/g, '').replace(/\u0000/g, ' ').trim();

// ---------- ID3 тагове ----------
function readHead(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally { fs.closeSync(fd); }
}
function readTail(file, n, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(n, size));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf;
  } finally { fs.closeSync(fd); }
}

function decodeId3Text(b) {
  if (!b.length) return '';
  const enc = b[0];
  const body = b.subarray(1);
  if (enc === 0) return clean0(decodeLatinOrCp1251(body));
  if (enc === 3) return clean0(body.toString('utf8'));
  if (enc === 1 || enc === 2) {
    let le = enc === 1;
    let d = body;
    if (d[0] === 0xFF && d[1] === 0xFE) { le = true; d = d.subarray(2); }
    else if (d[0] === 0xFE && d[1] === 0xFF) { le = false; d = d.subarray(2); }
    if (!le) { const s = Buffer.from(d); for (let i = 0; i + 1 < s.length; i += 2) [s[i], s[i + 1]] = [s[i + 1], s[i]]; d = s; }
    return clean0(d.subarray(0, d.length - (d.length % 2)).toString('utf16le'));
  }
  return '';
}

function readId3(file, size) {
  const tags = {};
  try {
    const head = readHead(file, 10);
    if (head.length === 10 && head.toString('latin1', 0, 3) === 'ID3') {
      const ver = head[3];
      const tagSize = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
      const buf = readHead(file, Math.min(10 + tagSize, 2 * 1024 * 1024)).subarray(10);
      let p = 0;
      if (head[5] & 0x40 && ver >= 3) {            // разширен хедър
        const ext = ver === 4 ? ((buf[0] << 21) | (buf[1] << 14) | (buf[2] << 7) | buf[3]) : buf.readUInt32BE(0) + 4;
        p += ext;
      }
      while (p + (ver === 2 ? 6 : 10) <= buf.length) {
        let id, len, hl;
        if (ver === 2) {
          id = buf.toString('latin1', p, p + 3); len = (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5]; hl = 6;
        } else {
          id = buf.toString('latin1', p, p + 4);
          len = ver === 4 ? ((buf[p + 4] << 21) | (buf[p + 5] << 14) | (buf[p + 6] << 7) | buf[p + 7]) : buf.readUInt32BE(p + 4);
          hl = 10;
        }
        if (!/^[A-Z0-9]{3,4}$/.test(id) || len <= 0 || p + hl + len > buf.length) break;
        const data = buf.subarray(p + hl, p + hl + len);
        if (id === 'TIT2' || id === 'TT2') tags.title = decodeId3Text(data);
        else if (id === 'TPE1' || id === 'TP1') tags.artist = decodeId3Text(data);
        else if ((id === 'TPE2' || id === 'TP2') && !tags.albumArtist) tags.albumArtist = decodeId3Text(data);
        p += hl + len;
      }
    }
    if ((!tags.title || !tags.artist) && size > 128) {
      const t = readTail(file, 128, size);
      if (t.toString('latin1', 0, 3) === 'TAG') {
        const title = clean0(decodeLatinOrCp1251(t.subarray(3, 33)));
        const artist = clean0(decodeLatinOrCp1251(t.subarray(33, 63)));
        if (!tags.title && title) tags.title = title;
        if (!tags.artist && artist) tags.artist = artist;
      }
    }
  } catch (e) { /* без тагове */ }
  if (!tags.artist && tags.albumArtist) tags.artist = tags.albumArtist;
  return tags;
}

// ---------- име на файл ----------
const JUNK = /\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|1080p|720p|480p|remaster(ed)?|клип|видео|текст|премиера|prod\.?[^)\]]*)\b/i;
function tidy(s) {
  return s
    .replace(/[([{][^)\]}]*[)\]}]/g, (m) => (JUNK.test(m) || /^\W*\d{4}\W*$/.test(m) ? '' : m))
    .replace(/\s*[|•].*$/, '')
    .replace(/[,\s-]+((19|20)\d{2})\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—.,]+|[\s\-–—.,]+$/g, '')
    .trim();
}
const TRAIL_JUNK = /(\s+(official|music|video|audio|lyrics?|lyric|visuali[sz]er|hd|hq|4k|clip|клип|видео))+\s*$/i;
function fromFilename(name) {
  let base = name.replace(/\.[^.]+$/, '');
  // „Latin - Title _ Кирилица - Заглавие“: в имената на файлове „/“ и „|“ често стават „_“
  const segs = base.split(/\s+[_/|]\s+|\s*\|\s*/).map((x) => x.trim()).filter(Boolean);
  const prep = (s) => s.replace(/_/g, ' ').replace(/\s{2,}/g, ' ')
    .replace(/^\s*\d{1,3}\s*[.\-)]\s+/, '')        // „01. “, „03 - “
    .replace(TRAIL_JUNK, '')
    .trim();
  const SEP = /\s+[-–—]\s+|\s*[–—]\s*/;
  const withSep = segs.map(prep).filter((x) => SEP.test(x));
  const pick = withSep.find((x) => /[а-я]/i.test(x)) || withSep[0];
  if (pick) {
    const parts = pick.split(SEP);
    return { artist: tidy(parts[0]), title: tidy(parts.slice(1).join(' - ')), guessed: false };
  }
  return { artist: '', title: tidy(prep(segs.join(' '))), guessed: true };
}

// ГЛАВНИ БУКВИ → Нормални
function fixCaps(s, isTitle) {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length < 3 || letters !== letters.toUpperCase()) return s;
  const low = s.toLowerCase();
  if (isTitle) return low.charAt(0).toUpperCase() + low.slice(1);
  return low.replace(/(^|[\s\-.(&])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(Ft|Feat)\b/g, (m) => m.toLowerCase()).replace(/\bDj\b/g, 'DJ').replace(/\bМс\b|\bMc\b/g, 'MC');
}

// ---------- сравнение за повторения ----------
const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sht',ъ:'a',ь:'y',ю:'yu',я:'ya' };
function key(s) {
  return String(s).toLowerCase()
    .replace(/[а-я]/g, (c) => TR[c] || c)
    .replace(/[šś]/g, 'sh').replace(/[čć]/g, 'ch').replace(/[žź]/g, 'zh').replace(/đ/g, 'dj')
    .replace(/\b(ft|feat|featuring)\b.*$/, '')
    .replace(/(ii|iy|ij)/g, 'i').replace(/q/g, 'ya').replace(/j/g, 'y').replace(/w/g, 'v').replace(/x/g, 'ks')
    .replace(/[^a-z0-9]+/g, '');
}
function mainArtistKey(a) { return key(String(a).split(/\s*(?:,|&| и | x | х |ft\.?|feat\.?)\s*/i)[0]); }
const songKey = (artist, title) => mainArtistKey(artist) + '|' + key(title);

// ---------- обхождане ----------
function walk(dir, rel = '', out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(abs, r, out);
    else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push({ abs, rel: r });
  }
  return out;
}

// Преглед на промените — нищо не записва
function preview(existing) {
  const byFile = new Map(existing.map((s) => [s.file, s]));
  const byKey = new Map();
  for (const s of existing) if (!s.hidden) byKey.set(songKey(s.artist, s.title), s);

  const files = walk(MUSIC);
  const seenFiles = new Set();
  const add = [], duplicates = [], noGenre = [], needsCheck = [];
  let unchanged = 0, hiddenSkipped = 0;

  for (const f of files) {
    seenFiles.add(f.rel);
    const known = byFile.get(f.rel);
    if (known) { known.hidden ? hiddenSkipped++ : unchanged++; continue; }
    const slash = f.rel.indexOf('/');
    if (slash < 0) { noGenre.push(f.rel); continue; }
    const genre = f.rel.slice(0, slash).trim();
    const size = fs.statSync(f.abs).size;
    const tags = readId3(f.abs, size);
    const fn = fromFilename(path.basename(f.rel));
    let artist = tags.artist || fn.artist;
    let title = tags.title || fn.title;
    const source = tags.artist && tags.title ? 'тагове' : (fn.guessed ? 'име на файла (без изпълнител)' : 'име на файла');
    artist = fixCaps(tidy(artist || ''), false);
    title = fixCaps(tidy(title || ''), true);
    const item = { file: f.rel, artist, title, genre, size, source };
    const k = songKey(artist, title);
    const dup = byKey.get(k);
    if (dup && key(title)) {
      duplicates.push({ ...item, duplicateOf: dup.file || '(в този сканиране)', duplicateLabel: `${dup.artist} – ${dup.title}` });
      continue;
    }
    if (!artist || !title) needsCheck.push(item.file);
    byKey.set(k, item);
    add.push(item);
  }
  const missing = existing.filter((s) => !s.hidden && !seenFiles.has(s.file)).map((s) => ({ id: s.id, file: s.file, label: `${s.artist} – ${s.title}` }));
  const perGenre = {};
  for (const a of add) perGenre[a.genre] = (perGenre[a.genre] || 0) + 1;
  return { add, duplicates, noGenre, missing, needsCheck, unchanged, hiddenSkipped, perGenre, total: files.length };
}

// Абсолютен път към песен — само вътре в music
function resolve(rel) {
  const abs = path.resolve(MUSIC, rel);
  if (!abs.startsWith(MUSIC + path.sep)) return null;
  return abs;
}

module.exports = { MUSIC, MIME, preview, resolve, readId3, fromFilename, songKey };
