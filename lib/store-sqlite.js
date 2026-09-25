// Local storage: one SQLite file on the host computer, one room per computer.
// Implements the same async store interface as store-postgres.js.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// SQLite CURRENT_TIMESTAMP is UTC without a zone; hand the page ISO strings like Postgres does.
const iso = value => (value ? `${value.replace(' ', 'T')}Z` : value);
// Skipped songs don't count towards how popular a song is.
const SUNG = "q.status IN ('done','playing') AND COALESCE(q.end_reason,'') <> 'skipped'";

export function createSqliteStore({ dbPath, seedPath }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  youtube_url TEXT NOT NULL,
  video_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS seen_title ON seen(title);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seen_id INTEGER NOT NULL REFERENCES seen(id),
  status TEXT NOT NULL CHECK(status IN ('pending','playing','done','removed')),
  sort_order INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS queue_active ON queue(status,sort_order);
CREATE TABLE IF NOT EXISTS lyrics (
  seen_id INTEGER PRIMARY KEY REFERENCES seen(id),
  lrclib_id INTEGER,
  track TEXT,
  synced TEXT,
  offset_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);`);
  // Play history: when each song started/ended and whether it finished or was skipped.
  // Older rows only have created_at (the request time).
  const queueColumns = db.prepare('PRAGMA table_info(queue)').all().map(column => column.name);
  for (const column of ['started_at', 'ended_at', 'end_reason']) {
    if (!queueColumns.includes(column)) db.exec(`ALTER TABLE queue ADD COLUMN ${column} TEXT`);
  }
  // 原唱／伴唱: each song can point at its other version. offset_ms is how far ahead the
  // partner video is at the same moment in the song. use_partner marks a switched queue item.
  if (!queueColumns.includes('use_partner')) db.exec('ALTER TABLE queue ADD COLUMN use_partner INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS song_partner (
  seen_id INTEGER PRIMARY KEY REFERENCES seen(id),
  partner_id INTEGER NOT NULL REFERENCES seen(id),
  offset_ms INTEGER NOT NULL DEFAULT 0
);`);

  if (db.prepare('SELECT COUNT(*) AS count FROM seen').get().count === 0 && fs.existsSync(seedPath)) {
    const songs = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const insert = db.prepare('INSERT INTO seen(title,youtube_url,video_id) VALUES(?,?,?)');
    transaction(() => { for (const song of songs) insert.run(song.title, song.youtubeUrl, song.videoId); });
    console.log(`已從種子資料載入 ${songs.length} 首歌曲。`);
  }

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function setting(key) {
    let row = db.prepare('SELECT value FROM config WHERE key=?').get(key);
    if (!row) {
      const value = crypto.randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO config(key,value) VALUES(?,?)').run(key, value);
      row = { value };
    }
    return row.value;
  }
  const clientToken = setting('client_token');
  const adminToken = setting('admin_token');
  const roomCode = setting('room_code').slice(0, 8);

  function promoteIfIdle() {
    if (!db.prepare("SELECT id FROM queue WHERE status='playing' LIMIT 1").get()) {
      const next = db.prepare("SELECT id FROM queue WHERE status='pending' ORDER BY sort_order,id LIMIT 1").get();
      if (next) db.prepare("UPDATE queue SET status='playing', started_at=CURRENT_TIMESTAMP WHERE id=?").run(next.id);
    }
  }
  function enqueue(seenId, mode, name) {
    if (!db.prepare('SELECT id FROM seen WHERE id=?').get(seenId)) return false;
    const order = mode === 'next'
      ? (db.prepare("SELECT MIN(sort_order) AS n FROM queue WHERE status='pending'").get().n ?? 0) - 1
      : (db.prepare("SELECT MAX(sort_order) AS n FROM queue WHERE status='pending'").get().n ?? 0) + 1;
    db.prepare("INSERT INTO queue(seen_id,status,sort_order,added_by) VALUES(?,'pending',?,?)").run(seenId, order, name);
    promoteIfIdle();
    return true;
  }
  const lyricsRow = seenId => db.prepare('SELECT lrclib_id, track, synced, offset_ms FROM lyrics WHERE seen_id=?').get(seenId) ?? null;

  return {
    mode: 'local',
    adminToken,
    clientToken,
    roomCode,

    async resolveToken(token) {
      if (token === adminToken) return { role: 'admin', roomId: 0 };
      if (token === clientToken) return { role: 'client', roomId: 0 };
      return null;
    },
    async joinToken(code) { return code === roomCode ? clientToken : null; },
    async roomInfo() { return { code: roomCode, name: null }; },

    async state() {
      const rows = db.prepare(`SELECT q.id, q.status, q.added_by, q.created_at, q.use_partner, s.id AS seen_id,
          s.title, s.youtube_url, s.video_id FROM queue q JOIN seen s ON s.id=q.seen_id
          WHERE q.status IN ('playing','pending')
          ORDER BY CASE q.status WHEN 'playing' THEN 0 ELSE 1 END, q.sort_order, q.id`).all()
        .map(row => ({ ...row, use_partner: Boolean(row.use_partner), created_at: iso(row.created_at) }));
      return { current: rows.find(row => row.status === 'playing') ?? null, upcoming: rows.filter(row => row.status === 'pending') };
    },
    async advance(_roomId, reason) {
      transaction(() => {
        db.prepare("UPDATE queue SET status='done', ended_at=CURRENT_TIMESTAMP, end_reason=? WHERE status='playing'").run(reason);
        const next = db.prepare("SELECT id FROM queue WHERE status='pending' ORDER BY sort_order,id LIMIT 1").get();
        if (next) db.prepare("UPDATE queue SET status='playing', started_at=CURRENT_TIMESTAMP WHERE id=?").run(next.id);
      });
    },
    async addToQueue(_roomId, seenId, mode, name) { return enqueue(seenId, mode, name); },
    async removeFromQueue(_roomId, id) {
      return db.prepare("UPDATE queue SET status='removed' WHERE id=? AND status='pending'").run(id).changes > 0;
    },
    async moveToNext(_roomId, id) {
      const first = (db.prepare("SELECT MIN(sort_order) AS n FROM queue WHERE status='pending'").get().n ?? 0) - 1;
      return db.prepare("UPDATE queue SET sort_order=? WHERE id=? AND status='pending'").run(first, id).changes > 0;
    },

    async listSeen({ query, all }) {
      if (all) {
        return db.prepare(`SELECT id,title,youtube_url,video_id,
            (SELECT COUNT(*) FROM queue q WHERE q.seen_id=seen.id AND ${SUNG}) AS play_count
            FROM seen ORDER BY title COLLATE NOCASE, id DESC LIMIT 500`).all();
      }
      if (query) {
        return db.prepare('SELECT id,title,youtube_url,video_id FROM seen WHERE title LIKE ? ESCAPE \'\\\' ORDER BY id DESC LIMIT 30')
          .all(`%${query.replace(/[\\%_]/g, '\\$&')}%`);
      }
      return db.prepare('SELECT id,title,youtube_url,video_id FROM seen ORDER BY id DESC LIMIT 30').all();
    },
    async insertSeen(title, youtubeUrl, videoId) {
      return Number(db.prepare('INSERT INTO seen(title,youtube_url,video_id) VALUES(?,?,?)').run(title, youtubeUrl, videoId).lastInsertRowid);
    },
    async knownVideoIds(videoIds) {
      const known = db.prepare('SELECT 1 FROM seen WHERE video_id=? LIMIT 1');
      return new Set(videoIds.filter(id => known.get(id)));
    },
    async importSongs(_roomId, songs, withQueue, name) {
      const findExisting = db.prepare('SELECT id FROM seen WHERE video_id=? ORDER BY id LIMIT 1');
      const insert = db.prepare('INSERT INTO seen(title,youtube_url,video_id) VALUES(?,?,?)');
      const result = { added: 0, existing: 0, queued: 0 };
      transaction(() => {
        for (const song of songs) {
          let seenId = findExisting.get(song.videoId)?.id;
          if (seenId) result.existing += 1;
          else {
            seenId = Number(insert.run(song.title, `https://www.youtube.com/watch?v=${song.videoId}`, song.videoId).lastInsertRowid);
            result.added += 1;
          }
          if (withQueue && enqueue(seenId, 'end', name)) result.queued += 1;
        }
      });
      return result;
    },

    async history() {
      const songs = db.prepare(`SELECT q.id, q.seen_id, s.title, s.video_id, q.added_by, q.status, q.end_reason,
          COALESCE(q.started_at, q.created_at) AS played_at
          FROM queue q JOIN seen s ON s.id=q.seen_id
          WHERE q.status IN ('done','playing')
          ORDER BY played_at DESC, q.id DESC LIMIT 500`).all()
        .map(row => ({ ...row, played_at: iso(row.played_at) }));
      const popular = db.prepare(`SELECT s.id AS seen_id, s.title, s.video_id, COUNT(*) AS plays,
          MAX(COALESCE(q.started_at, q.created_at)) AS last_played
          FROM queue q JOIN seen s ON s.id=q.seen_id WHERE ${SUNG}
          GROUP BY s.id ORDER BY plays DESC, last_played DESC LIMIT 30`).all()
        .map(row => ({ ...row, last_played: iso(row.last_played) }));
      return { songs, popular };
    },

    async setUsePartner(_roomId, queueId, on) {
      return db.prepare("UPDATE queue SET use_partner=? WHERE id=? AND status='playing'").run(on ? 1 : 0, queueId).changes > 0;
    },
    async partnerOf(seenId) {
      return db.prepare(`SELECT s.id AS seen_id, s.title, s.video_id, p.offset_ms FROM song_partner p
          JOIN seen s ON s.id=p.partner_id WHERE p.seen_id=?`).get(seenId) ?? null;
    },
    async savePartner(seenId, partnerId, offsetMs) {
      const upsert = db.prepare(`INSERT INTO song_partner(seen_id,partner_id,offset_ms) VALUES(?,?,?)
          ON CONFLICT(seen_id) DO UPDATE SET partner_id=excluded.partner_id, offset_ms=excluded.offset_ms`);
      // Drop both songs' old links first, so a replaced partner doesn't keep pointing back.
      const unlink = db.prepare('DELETE FROM song_partner WHERE seen_id IN (?,?) OR partner_id IN (?,?)');
      transaction(() => {
        unlink.run(seenId, partnerId, seenId, partnerId);
        upsert.run(seenId, partnerId, offsetMs);
        upsert.run(partnerId, seenId, -offsetMs);
      });
    },
    async setPartnerOffset(seenId, offsetMs) {
      const pair = db.prepare('SELECT partner_id FROM song_partner WHERE seen_id=?').get(seenId);
      if (!pair) return false;
      transaction(() => {
        db.prepare('UPDATE song_partner SET offset_ms=? WHERE seen_id=?').run(offsetMs, seenId);
        db.prepare('UPDATE song_partner SET offset_ms=? WHERE seen_id=?').run(-offsetMs, pair.partner_id);
      });
      return true;
    },
    async seenWithPrefix(prefix) {
      return db.prepare("SELECT id, title, video_id FROM seen WHERE title LIKE ? ESCAPE '\\' ORDER BY id LIMIT 30")
        .all(`${prefix.replace(/[\\%_]/g, '\\$&')}%`);
    },
    async findSeenByVideo(videoId) {
      return db.prepare('SELECT id FROM seen WHERE video_id=? ORDER BY id LIMIT 1').get(videoId)?.id ?? null;
    },

    async seenTitle(seenId) { return db.prepare('SELECT title FROM seen WHERE id=?').get(seenId)?.title ?? null; },
    async lyricsRow(seenId) { return lyricsRow(seenId); },
    async saveLyrics(seenId, { lrclibId, track, synced }) {
      db.prepare(`INSERT INTO lyrics(seen_id,lrclib_id,track,synced) VALUES(?,?,?,?)
          ON CONFLICT(seen_id) DO UPDATE SET lrclib_id=excluded.lrclib_id, track=excluded.track,
          synced=excluded.synced, updated_at=CURRENT_TIMESTAMP`).run(seenId, lrclibId, track, synced);
      return lyricsRow(seenId);
    },
    async setLyricsOffset(seenId, offsetMs) {
      return db.prepare('UPDATE lyrics SET offset_ms=? WHERE seen_id=?').run(offsetMs, seenId).changes > 0;
    }
  };
}
