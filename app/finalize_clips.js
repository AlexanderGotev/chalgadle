// Еднократно (и после при нужда) нарязване на песните до ~16с.
// За всяка песен с намерено начало: реже 16,5с от началото, ЗАМЕНЯ файла на място
// и нулира началото (откъсът вече почва от 0). Пести място — цялата песен изчезва.
//
// ВАЖНО: необратимо е! Пази оригиналите другаде (лаптоп) ПРЕДИ да пуснеш това.
// Песни без намерено начало се пропускат — първо „Намери начало" в /admin.
// Идемпотентно: вече късите (<=20с) се прескачат, може да се пуска пак.
//
// Пускане (най-добре със спрян сайт, за да няма заключване на базата):
//   sudo systemctl stop chalgadle
//   node finalize_clips.js
//   sudo systemctl start chalgadle

'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const { q } = require('./db');
const lib = require('./library');

const FFMPEG = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : 'ffprobe';
const LEN = 16.5;            // секунди (малко над 16-те в играта)
const SHORT = 20;            // файл под толкова сек се смята вече нарязан

function duration(file) {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nk=1:nw=1', file], { encoding: 'utf8' });
    return parseFloat(out) || 0;
  } catch (e) { return 0; }
}

const songs = q.adminAll.all();
let cut = 0, already = 0, noStart = 0, missing = 0, errors = 0, freed = 0;

console.log(`Песни за преглед: ${songs.length}\n`);

for (const s of songs) {
  const src = lib.resolve(s.file);
  if (!src || !fs.existsSync(src)) { missing++; continue; }

  const dur = duration(src);
  if (dur && dur <= SHORT) {                       // вече е къс → само нулирай началото, ако трябва
    if (Number(s.start) !== 0) q.setStart.run({ id: s.id, start: 0, manual: 1 });
    already++;
    continue;
  }

  const start = Number(s.start);
  if (!Number.isFinite(start) || start < 0) {      // няма намерено начало
    noStart++;
    continue;
  }

  const before = fs.statSync(src).size;
  const tmp = src + '.cut.tmp.mp3';
  try {
    execFileSync(FFMPEG, ['-nostdin', '-y', '-ss', String(start), '-i', src,
      '-t', String(LEN), '-map', '0:a:0', '-c:a', 'libmp3lame', '-b:a', '128k',
      '-f', 'mp3', tmp], { stdio: 'ignore' });
    fs.renameSync(tmp, src);                        // замяна на място (атомарно)
    q.setStart.run({ id: s.id, start: 0, manual: 1 });
    freed += Math.max(0, before - fs.statSync(src).size);
    cut++;
    if (cut % 25 === 0) console.log(`  …нарязани ${cut}`);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    console.error(`  ГРЕШКА при ${s.id} (${s.file}): ${e.message}`);
    errors++;
  }
}

console.log('\n==== Готово ====');
console.log(`Нарязани сега:         ${cut}`);
console.log(`Вече къси (прескочени): ${already}`);
console.log(`Без начало (пусни „Намери начало"): ${noStart}`);
console.log(`Липсващ файл:           ${missing}`);
console.log(`Грешки:                 ${errors}`);
console.log(`Освободено:             ${(freed / 1048576).toFixed(0)} MB`);
if (noStart) console.log('\nЗабележка: песните без начало НЕ са нарязани. Намери им начало в /admin и пусни пак.');
