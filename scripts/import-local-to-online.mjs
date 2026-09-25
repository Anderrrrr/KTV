// Copies a local KTV database (data/ktv.sqlite) into the online Postgres database:
// songs not already online, lyrics (without overwriting online ones), and the play history,
// which goes into a new online room. Prints that room's host link.
//
// Usage: KTV_DATABASE_URL=postgres://... node scripts/import-local-to-online.mjs "<room name>" [path/to/ktv.sqlite]
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const [roomName = '從本機匯入', dbPath = path.join(import.meta.dirname, '..', 'data', 'ktv.sqlite')] = process.argv.slice(2);
const connectionString = process.env.KTV_DATABASE_URL;
const siteUrl = (process.env.KTV_SITE_URL || '').replace(/\/$/, '');
if (!connectionString) {
  console.error('Set KTV_DATABASE_URL to the online database connection string.');
  process.exit(1);
}

const local = new DatabaseSync(dbPath, { readOnly: true });
const utc = value => (value ? `${value.replace(' ', 'T')}Z` : null);
const token = bytes => crypto.randomBytes(bytes).toString('base64url');

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');

  const seenMap = new Map();
  let addedSongs = 0;
  for (const song of local.prepare('SELECT id, title, youtube_url, video_id, created_at FROM seen ORDER BY id').all()) {
    let { rows: [online] } = await client.query('SELECT id FROM seen WHERE video_id=$1 ORDER BY id LIMIT 1', [song.video_id]);
    if (!online) {
      ({ rows: [online] } = await client.query(
        'INSERT INTO seen(title,youtube_url,video_id,created_at) VALUES($1,$2,$3,$4) RETURNING id',
        [song.title, song.youtube_url, song.video_id, utc(song.created_at)]));
      addedSongs += 1;
    }
    seenMap.set(song.id, online.id);
  }

  let copiedLyrics = 0;
  for (const row of local.prepare('SELECT seen_id, lrclib_id, track, synced, offset_ms FROM lyrics').all()) {
    const result = await client.query(
      'INSERT INTO lyrics(seen_id,lrclib_id,track,synced,offset_ms) VALUES($1,$2,$3,$4,$5) ON CONFLICT(seen_id) DO NOTHING',
      [seenMap.get(row.seen_id), row.lrclib_id, row.track, row.synced, row.offset_ms]);
    copiedLyrics += result.rowCount;
  }

  const hostToken = token(24);
  const { rows: [room] } = await client.query(
    'INSERT INTO rooms(code,host_token,guest_token,name) VALUES($1,$2,$3,$4) RETURNING id',
    [token(6), hostToken, token(24), roomName]);
  // Only finished history; songs still waiting or playing stay on the local machine.
  const history = local.prepare(`SELECT seen_id, sort_order, added_by, created_at, started_at, ended_at, end_reason
      FROM queue WHERE status='done' ORDER BY id`).all();
  for (const row of history) {
    await client.query(`INSERT INTO queue(room_id,seen_id,status,sort_order,added_by,created_at,started_at,ended_at,end_reason)
        VALUES($1,$2,'done',$3,$4,$5,$6,$7,$8)`,
      [room.id, seenMap.get(row.seen_id), row.sort_order, row.added_by, utc(row.created_at), utc(row.started_at), utc(row.ended_at), row.end_reason]);
  }

  await client.query('COMMIT');
  console.log(`Songs: ${seenMap.size} local, ${addedSongs} added online (the rest were already there).`);
  console.log(`Lyrics copied: ${copiedLyrics}. History rows copied: ${history.length}.`);
  console.log(`Room "${roomName}" host link: ${siteUrl || '<your site>'}/?token=${hostToken}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
