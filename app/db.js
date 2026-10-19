// Базата данни: data/library.db (SQLite, вградена в Node.js)
// Старата YouTube база (data/songs.db) не се пипа — тя е и в _backup.

const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (String((w && w.message) || w).includes('SQLite')) return;
  return emitWarning.call(process, w, ...rest);
};

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DIR = path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const db = new DatabaseSync(path.join(DIR, 'library.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    file         TEXT    NOT NULL UNIQUE,   -- път спрямо папката music, с /
    artist       TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    genre        TEXT    NOT NULL,
    start        REAL,                      -- откъде започва откъсът (сек); NULL = още не е анализирана
    start_manual INTEGER NOT NULL DEFAULT 0,-- 1 = нагласено на ръка (автоматиката не го презаписва)
    auto_start   REAL,                      -- какво е предложила автоматиката
    choruses     TEXT,                      -- JSON [[от, до], ...] — открити припеви
    entry        REAL,                      -- кога песента „влиза“
    duration     REAL,
    reason       TEXT,
    size         INTEGER,
    hidden       INTEGER NOT NULL DEFAULT 0,-- 1 = изтрита от теб (сканирането не я връща)
    created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const DEFAULT_START = 30;

const PUBLIC_COLS = 'id, artist, title, genre';
const q = {
  publicAll: db.prepare(`SELECT ${PUBLIC_COLS} FROM songs WHERE hidden = 0 ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE`),
  adminAll: db.prepare('SELECT * FROM songs WHERE hidden = 0 ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE'),
  allFiles: db.prepare('SELECT id, file, artist, title, genre, hidden, size FROM songs'),
  byId: db.prepare('SELECT * FROM songs WHERE id = ?'),
  genres: db.prepare('SELECT genre, COUNT(*) AS n FROM songs WHERE hidden = 0 GROUP BY genre ORDER BY genre COLLATE NOCASE'),
  insert: db.prepare(`INSERT INTO songs (file, artist, title, genre, size) VALUES (:file, :artist, :title, :genre, :size)`),
  update: db.prepare(`UPDATE songs SET artist = :artist, title = :title, genre = :genre WHERE id = :id`),
  setStart: db.prepare(`UPDATE songs SET start = :start, start_manual = :manual WHERE id = :id`),
  setAnalysis: db.prepare(`UPDATE songs SET auto_start = :auto_start, choruses = :choruses, entry = :entry,
                           duration = :duration, reason = :reason,
                           start = CASE WHEN start_manual = 1 THEN start ELSE :auto_start END
                           WHERE id = :id`),
  hide: db.prepare('UPDATE songs SET hidden = 1 WHERE id = ?'),
  unhideAll: db.prepare('UPDATE songs SET hidden = 0 WHERE hidden = 1'),
  remove: db.prepare('DELETE FROM songs WHERE id = ?'),
  hiddenCount: db.prepare('SELECT COUNT(*) AS n FROM songs WHERE hidden = 1'),
};

function randomSong(genre, exclude) {
  const where = ['hidden = 0'];
  const params = [];
  if (genre && genre !== 'all') { where.push('genre = ?'); params.push(genre); }
  const ids = (exclude || []).filter((n) => Number.isInteger(n));
  if (ids.length) { where.push(`id NOT IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  const sql = `SELECT id, artist, title, genre, COALESCE(start, ${DEFAULT_START}) AS start
               FROM songs WHERE ${where.join(' AND ')} ORDER BY RANDOM() LIMIT 1`;
  return db.prepare(sql).get(...params) || null;
}

module.exports = { db, q, randomSong, DEFAULT_START };
