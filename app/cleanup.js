// Маха от играта дубликатите (…(2),(3)) и live изпълненията.
// Пускане:
//   node cleanup.js            преглед (нищо не променя)
//   node cleanup.js --apply    скрива ги от играта И трие файловете им (спестява място)
//
// Необратимо е за файловете! Увери се, че оригиналите са на лаптопа.
// Скриването е обратимо през /admin („Върни изтритите"), но файлът — не.

'use strict';
const fs = require('fs');
const { q } = require('./db');
const lib = require('./library');

const apply = process.argv.includes('--apply');

const DUP = /\s\(\d+\)\s*$/;                 // завършва на " (2)", " (3)" …
const LIVE = /\blive\b|на\s+сцена|зад\s+кулис|backstage|behind the scenes|jam\s+session|club\s+xray|hashtagstudio|\bbts\b|\bon\s+stage\b/i;
const NOT_LIVE = /live\s+is\s+life|life\s+is\s+life/i;   // това е заглавие, не концерт

const rows = q.allFiles.all();               // id, file, artist, title, genre, hidden, size
const dups = [], live = [];
for (const r of rows) {
  if (r.hidden) continue;
  const name = `${r.artist} - ${r.title}`;
  if (DUP.test(name)) dups.push(r);
  else if (LIVE.test(name) && !NOT_LIVE.test(name)) live.push(r);
}

function show(title, list) {
  console.log(`\n=== ${title} (${list.length}) ===`);
  for (const r of list) console.log('  ', r.artist, '-', r.title);
}
show('ДУБЛИКАТИ', dups);
show('LIVE', live);

const all = [...dups, ...live];
console.log(`\nОбщо за махане: ${all.length}`);

if (!apply) {
  console.log('\nПреглед беше. Ако е наред, пусни:  node cleanup.js --apply');
  process.exit(0);
}

let hidden = 0, deleted = 0, freed = 0;
for (const r of all) {
  try { q.hide.run(r.id); hidden++; } catch (e) { console.error('скриване', r.id, e.message); }
  const abs = lib.resolve(r.file);
  if (abs && fs.existsSync(abs)) {
    try { const sz = fs.statSync(abs).size; fs.unlinkSync(abs); deleted++; freed += sz; }
    catch (e) { console.error('триене', r.file, e.message); }
  }
}
console.log(`\nГотово. Скрити: ${hidden} | изтрити файла: ${deleted} | освободено: ${(freed/1048576).toFixed(0)} MB`);
