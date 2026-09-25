// Online storage: Netlify Database (Postgres). Many rooms, each with its own queue and
// history; the song catalogue and lyrics are shared. Same interface as store-sqlite.js.
import crypto from 'node:crypto';

const SUNG = "q.status IN ('done','playing') AND COALESCE(q.end_reason,'') <> 'skipped'";
const randomToken = bytes => crypto.randomBytes(bytes).toString('base64url');

export function createPostgresStore(database) {
  async function withClient(work) {
    const client = await database.pool.connect();
    try { return await work(client); } finally { client.release(); }
  }
  const rows = (text, params = []) => withClient(async client => (await client.query(text, params)).rows);
  const one = async (text, params) => (await rows(text, params))[0] ?? null;
  // Queue changes lock the room row so two phones pressing buttons at once can't
  // double-advance or collide on sort order.
  function roomTransaction(roomId, work) {
    return withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);
        const result = await work((text, params = []) => client.query(text, params).then(r => r.rows));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
  async function promoteIfIdle(query, roomId) {
    const [playing] = await query("SELECT id FROM queue WHERE room_id=$1 AND status='playing' LIMIT 1", [roomId]);
    if (playing) return;
    const [next] = await query("SELECT id FROM queue WHERE room_id=$1 AND status='pending' ORDER BY sort_order,id LIMIT 1", [roomId]);
    if (next) await query("UPDATE queue SET status='playing', started_at=now() WHERE id=$1", [next.id]);
  }
  async function enqueue(query, roomId, seenId, mode, name) {
    const [song] = await query('SELECT id FROM seen WHERE id=$1', [seenId]);
    if (!song) return false;
    const [{ n }] = await query(
      `SELECT ${mode === 'next' ? 'MIN' : 'MAX'}(sort_order) AS n FROM queue WHERE room_id=$1 AND status='pending'`, [roomId]);
    const order = mode === 'next' ? (n ?? 0) - 1 : (n ?? 0) + 1;
    await query("INSERT INTO queue(room_id,seen_id,status,sort_order,added_by) VALUES($1,$2,'pending',$3,$4)", [roomId, seenId, order, name]);
    await promoteIfIdle(query, roomId);
    return true;
  }
  const lyricsRow = seenId => one('SELECT lrclib_id, track, synced, offset_ms FROM lyrics WHERE seen_id=$1', [seenId]);

  return {
    mode: 'online',

    async createRoom(name) {
      const room = { code: randomToken(6), hostToken: randomToken(24), guestToken: randomToken(24) };
      await rows('INSERT INTO rooms(code,host_token,guest_token,name) VALUES($1,$2,$3,$4)', [room.code, room.hostToken, room.guestToken, name]);
      return room;
    },
    async resolveToken(token) {
      if (!token) return null;
      const room = await one('SELECT id, host_token FROM rooms WHERE host_token=$1 OR guest_token=$1', [token]);
      return room ? { role: room.host_token === token ? 'admin' : 'client', roomId: room.id } : null;
    },
    async joinToken(code) { return (await one('SELECT guest_token FROM rooms WHERE code=$1', [code]))?.guest_token ?? null; },
    async roomInfo(roomId) { return one('SELECT code, name FROM rooms WHERE id=$1', [roomId]); },

    async state(roomId) {
      const list = await rows(`SELECT q.id, q.status, q.added_by, q.created_at, s.id AS seen_id,
          s.title, s.youtube_url, s.video_id FROM queue q JOIN seen s ON s.id=q.seen_id
          WHERE q.room_id=$1 AND q.status IN ('playing','pending')
          ORDER BY CASE q.status WHEN 'playing' THEN 0 ELSE 1 END, q.sort_order, q.id`, [roomId]);
      return { current: list.find(row => row.status === 'playing') ?? null, upcoming: list.filter(row => row.status === 'pending') };
    },
    async advance(roomId, reason) {
      await roomTransaction(roomId, async query => {
        await query("UPDATE queue SET status='done', ended_at=now(), end_reason=$2 WHERE room_id=$1 AND status='playing'", [roomId, reason]);
        await promoteIfIdle(query, roomId);
      });
    },
    async addToQueue(roomId, seenId, mode, name) {
      return roomTransaction(roomId, query => enqueue(query, roomId, seenId, mode, name));
    },
    async removeFromQueue(roomId, id) {
      return (await rows("UPDATE queue SET status='removed' WHERE id=$1 AND room_id=$2 AND status='pending' RETURNING id", [id, roomId])).length > 0;
    },
    async moveToNext(roomId, id) {
      return roomTransaction(roomId, async query => {
        const [{ n }] = await query("SELECT MIN(sort_order) AS n FROM queue WHERE room_id=$1 AND status='pending'", [roomId]);
        return (await query("UPDATE queue SET sort_order=$1 WHERE id=$2 AND room_id=$3 AND status='pending' RETURNING id", [(n ?? 0) - 1, id, roomId])).length > 0;
      });
    },

    async listSeen({ query, all }) {
      if (all) {
        return rows(`SELECT id,title,youtube_url,video_id,
            (SELECT COUNT(*)::int FROM queue q WHERE q.seen_id=seen.id AND ${SUNG}) AS play_count
            FROM seen ORDER BY lower(title), id DESC LIMIT 500`);
      }
      if (query) {
        return rows("SELECT id,title,youtube_url,video_id FROM seen WHERE title ILIKE $1 ESCAPE '\\' ORDER BY id DESC LIMIT 30",
          [`%${query.replace(/[\\%_]/g, '\\$&')}%`]);
      }
      return rows('SELECT id,title,youtube_url,video_id FROM seen ORDER BY id DESC LIMIT 30');
    },
    async insertSeen(title, youtubeUrl, videoId) {
      return (await one('INSERT INTO seen(title,youtube_url,video_id) VALUES($1,$2,$3) RETURNING id', [title, youtubeUrl, videoId])).id;
    },
    async knownVideoIds(videoIds) {
      if (!videoIds.length) return new Set();
      return new Set((await rows('SELECT DISTINCT video_id FROM seen WHERE video_id = ANY($1)', [videoIds])).map(row => row.video_id));
    },
    async importSongs(roomId, songs, withQueue, name) {
      return roomTransaction(roomId, async query => {
        const result = { added: 0, existing: 0, queued: 0 };
        for (const song of songs) {
          let [existing] = await query('SELECT id FROM seen WHERE video_id=$1 ORDER BY id LIMIT 1', [song.videoId]);
          if (existing) result.existing += 1;
          else {
            [existing] = await query('INSERT INTO seen(title,youtube_url,video_id) VALUES($1,$2,$3) RETURNING id',
              [song.title, `https://www.youtube.com/watch?v=${song.videoId}`, song.videoId]);
            result.added += 1;
          }
          if (withQueue && await enqueue(query, roomId, existing.id, 'end', name)) result.queued += 1;
        }
        return result;
      });
    },

    async history(roomId) {
      const songs = await rows(`SELECT q.id, q.seen_id, s.title, s.video_id, q.added_by, q.status, q.end_reason,
          COALESCE(q.started_at, q.created_at) AS played_at
          FROM queue q JOIN seen s ON s.id=q.seen_id
          WHERE q.room_id=$1 AND q.status IN ('done','playing')
          ORDER BY played_at DESC, q.id DESC LIMIT 500`, [roomId]);
      // Popularity is across all rooms, like the shared catalogue.
      const popular = await rows(`SELECT s.id AS seen_id, s.title, s.video_id, COUNT(*)::int AS plays,
          MAX(COALESCE(q.started_at, q.created_at)) AS last_played
          FROM queue q JOIN seen s ON s.id=q.seen_id WHERE ${SUNG}
          GROUP BY s.id ORDER BY plays DESC, last_played DESC LIMIT 30`);
      return { songs, popular };
    },

    async seenTitle(seenId) { return (await one('SELECT title FROM seen WHERE id=$1', [seenId]))?.title ?? null; },
    lyricsRow,
    async saveLyrics(seenId, { lrclibId, track, synced }) {
      await rows(`INSERT INTO lyrics(seen_id,lrclib_id,track,synced) VALUES($1,$2,$3,$4)
          ON CONFLICT(seen_id) DO UPDATE SET lrclib_id=excluded.lrclib_id, track=excluded.track,
          synced=excluded.synced, updated_at=now()`, [seenId, lrclibId, track, synced]);
      return lyricsRow(seenId);
    },
    async setLyricsOffset(seenId, offsetMs) {
      return (await rows('UPDATE lyrics SET offset_ms=$1 WHERE seen_id=$2 RETURNING seen_id', [offsetMs, seenId])).length > 0;
    }
  };
}
