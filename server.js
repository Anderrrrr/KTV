import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'ktv.sqlite'));
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

function seedSongsWhenEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM seen').get().count;
  if (count > 0) return;
  const seedPath = path.join(root, 'seed', 'songs.json');
  if (!fs.existsSync(seedPath)) return;
  const songs = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const insert = db.prepare('INSERT INTO seen(title,youtube_url,video_id) VALUES(?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const song of songs) insert.run(song.title, song.youtubeUrl, song.videoId);
    db.exec('COMMIT');
    console.log(`已從種子資料載入 ${songs.length} 首歌曲。`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
seedSongsWhenEmpty();

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

export function youtubeVideoId(input) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    let id = null;
    if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else if (/^\/(shorts|live|embed)\//.test(url.pathname)) id = url.pathname.split('/')[2];
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id ?? '') ? id : null;
  } catch { return null; }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function state() {
  const rows = db.prepare(`SELECT q.id, q.status, q.added_by, q.created_at, s.id AS seen_id,
      s.title, s.youtube_url, s.video_id FROM queue q JOIN seen s ON s.id=q.seen_id
      WHERE q.status IN ('playing','pending')
      ORDER BY CASE q.status WHEN 'playing' THEN 0 ELSE 1 END, q.sort_order, q.id`).all();
  return { current: rows.find(x => x.status === 'playing') ?? null, upcoming: rows.filter(x => x.status === 'pending') };
}
function advance() {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE queue SET status='done' WHERE status='playing'").run();
    const next = db.prepare("SELECT id FROM queue WHERE status='pending' ORDER BY sort_order,id LIMIT 1").get();
    if (next) db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(next.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function promoteIfIdle() {
  if (!db.prepare("SELECT id FROM queue WHERE status='playing' LIMIT 1").get()) {
    const next = db.prepare("SELECT id FROM queue WHERE status='pending' ORDER BY sort_order,id LIMIT 1").get();
    if (next) db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(next.id);
  }
}
function addToQueue(seenId, mode, name) {
  const song = db.prepare('SELECT id FROM seen WHERE id=?').get(seenId);
  if (!song) return false;
  const order = mode === 'next'
    ? (db.prepare("SELECT MIN(sort_order) AS n FROM queue WHERE status='pending'").get().n ?? 0) - 1
    : (db.prepare("SELECT MAX(sort_order) AS n FROM queue WHERE status='pending'").get().n ?? 0) + 1;
  db.prepare("INSERT INTO queue(seen_id,status,sort_order,added_by) VALUES(?,'pending',?,?)")
    .run(seenId, order, name);
  promoteIfIdle();
  return true;
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error('資料過大');
  }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('JSON 格式錯誤'); }
}
function clientAddress() {
  const supplied = process.env.PUBLIC_ORIGIN;
  if (supplied) return supplied.replace(/\/$/, '');
  const candidates = [];
  for (const [name, nets] of Object.entries(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family !== 'IPv4' || net.internal || net.address.startsWith('169.254.')) continue;
      const virtual = /tailscale|vethernet|virtual|vmware|docker|wsl|loopback/i.test(name);
      const privateNetwork = /^192\.168\./.test(net.address) || /^10\./.test(net.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(net.address);
      candidates.push({ address: net.address, score: (privateNetwork ? 10 : 0) - (virtual ? 20 : 0) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0]) return `http://${candidates[0].address}:${port}`;
  return `http://localhost:${port}`;
}
const port = Number(process.env.PORT || 3000);
const youtubeSearchCache = new Map();

function jsonObjectAfter(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf('{', markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  return null;
}

function collectYouTubeVideos(value, results, foundIds) {
  if (!value || results.length >= 5) return;
  if (Array.isArray(value)) {
    for (const item of value) collectYouTubeVideos(item, results, foundIds);
    return;
  }
  if (typeof value !== 'object') return;
  const video = value.videoRenderer;
  if (video && /^[A-Za-z0-9_-]{11}$/.test(video.videoId || '') && !foundIds.has(video.videoId)) {
    const title = video.title?.runs?.map(run => run.text).join('') || video.title?.simpleText || '';
    if (title) {
      foundIds.add(video.videoId);
      results.push({
        title,
        channel: video.ownerText?.runs?.map(run => run.text).join('') || '',
        videoId: video.videoId,
        youtubeUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`
      });
    }
  }
  for (const child of Object.values(value)) collectYouTubeVideos(child, results, foundIds);
}

export async function searchYouTube(query) {
  const cacheKey = query.toLocaleLowerCase('zh-Hant');
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;
  const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.7'
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error('YouTube 搜尋暫時無法使用');
  const html = await response.text();
  const initialData = jsonObjectAfter(html, 'var ytInitialData =')
    || jsonObjectAfter(html, 'ytInitialData =');
  if (!initialData) throw new Error('無法讀取 YouTube 搜尋結果');
  const results = [];
  collectYouTubeVideos(initialData, results, new Set());
  youtubeSearchCache.set(cacheKey, { results, expiresAt: Date.now() + 10 * 60_000 });
  if (youtubeSearchCache.size > 100) youtubeSearchCache.delete(youtubeSearchCache.keys().next().value);
  return results;
}

export function lyricsQueries(title) {
  const queries = [];
  const add = value => {
    const cleaned = value
      .replace(/[－—–-]\s*(原唱|純伴奏|伴奏|KTV|卡拉OK).*$/i, '')
      .replace(/[（(\[].*?[)）\]]/g, ' ')
      .replace(/\b(official|music|video|mv|lyrics?|hd|4k|ktv)\b/gi, ' ')
      .replace(/(官方|完整版|高畫質|歌詞版|動態歌詞|中文字幕)/g, ' ')
      .replace(/[|｜/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && !queries.includes(cleaned)) queries.push(cleaned);
  };
  for (const match of title.matchAll(/[【《「](.+?)[】》」]/g)) add(match[1]);
  add(title.replace(/[【《「].*?[】》」]/g, ' '));
  add(title);
  return queries.slice(0, 3);
}

async function lyricsCandidates(title, duration) {
  for (const query of lyricsQueries(title)) {
    const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'KTV-Jukebox/1.0 (LAN karaoke)' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error('歌詞服務暫時無法使用');
    const found = (await response.json()).filter(item => item.syncedLyrics && !item.instrumental);
    if (!found.length) continue;
    // Seed titles have no artist, so covers compete with the original. The original artist
    // usually has many uploads (albums, re-releases), so artist frequency is a useful signal
    // alongside the video length.
    const artist = item => String(item.artistName || '').replace(/[（(].*?[)）]/g, '').trim().toLowerCase();
    const counts = new Map();
    for (const item of found) counts.set(artist(item), (counts.get(artist(item)) || 0) + 1);
    const score = item => (item.trackName === query ? 0 : 30)
      + (duration > 0 ? Math.min(Math.abs(item.duration - duration), 60) : 0)
      - 5 * Math.min(counts.get(artist(item)), 5);
    return found.sort((a, b) => score(a) - score(b));
  }
  return [];
}

function lyricsRow(seenId) {
  return db.prepare('SELECT lrclib_id, track, synced, offset_ms FROM lyrics WHERE seen_id=?').get(seenId);
}

async function findLyrics(seenId, { duration = 0, query = '', skipCurrent = false } = {}) {
  const song = db.prepare('SELECT title FROM seen WHERE id=?').get(seenId);
  if (!song) return null;
  const existing = lyricsRow(seenId);
  const candidates = await lyricsCandidates(query || song.title, duration);
  let pick = candidates[0];
  if (skipCurrent && existing?.lrclib_id && !query) {
    const index = candidates.findIndex(item => item.id === existing.lrclib_id);
    pick = candidates[(index + 1) % candidates.length];
  }
  db.prepare(`INSERT INTO lyrics(seen_id,lrclib_id,track,synced,offset_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(seen_id) DO UPDATE SET lrclib_id=excluded.lrclib_id, track=excluded.track,
      synced=excluded.synced, updated_at=CURRENT_TIMESTAMP`)
    .run(seenId, pick?.id ?? null, pick ? `${pick.trackName} - ${pick.artistName}` : null, pick?.syncedLyrics ?? null, existing?.offset_ms ?? 0);
  return lyricsRow(seenId);
}

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/qr.html': ['qr.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/qr-display.js': ['qr-display.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/qr-display.css': ['qr-display.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml']
};

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const remoteAddress = req.socket.remoteAddress || '';
  const isLocalRequest = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  if (req.method === 'GET' && url.pathname === '/' && !url.searchParams.has('token') && isLocalRequest) {
    res.writeHead(302, { Location: `/?token=${adminToken}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === `/join/${roomCode}`) {
    res.writeHead(302, { Location: `/?token=${clientToken}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (url.pathname in files && req.method === 'GET') {
    const [filename, type] = files[url.pathname];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(path.join(root, 'public', filename)).pipe(res);
    return;
  }
  if (!url.pathname.startsWith('/api/')) { json(res, 404, { error: '找不到頁面' }); return; }
  const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
  const isAdmin = token === adminToken;
  if (!isAdmin && token !== clientToken) { json(res, 401, { error: '連結無效，請重新掃描 QR code' }); return; }
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, { ...state(), role: isAdmin ? 'admin' : 'client', clientUrl: isAdmin ? `${clientAddress()}/join/${roomCode}` : undefined });
    } else if (req.method === 'GET' && url.pathname === '/api/seen') {
      const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
      const showAll = url.searchParams.get('all') === '1';
      const rows = showAll
        ? db.prepare('SELECT id,title,youtube_url,video_id FROM seen ORDER BY title COLLATE NOCASE, id DESC LIMIT 500').all()
        : query
        ? db.prepare('SELECT id,title,youtube_url,video_id FROM seen WHERE title LIKE ? ESCAPE \'\\\' ORDER BY id DESC LIMIT 30')
          .all(`%${query.replace(/[\\%_]/g, '\\$&')}%`)
        : db.prepare('SELECT id,title,youtube_url,video_id FROM seen ORDER BY id DESC LIMIT 30').all();
      json(res, 200, { songs: rows });
    } else if (req.method === 'GET' && url.pathname === '/api/youtube-search') {
      const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
      if (!query) { json(res, 400, { error: '請輸入要搜尋的歌名' }); return; }
      json(res, 200, { results: await searchYouTube(query) });
    } else if (req.method === 'POST' && url.pathname === '/api/seen') {
      const data = await body(req);
      const title = String(data.title || '').trim().slice(0, 120);
      const videoId = youtubeVideoId(String(data.youtubeUrl || '').trim());
      if (!title || !videoId) { json(res, 400, { error: '請填歌名和有效的 YouTube 連結' }); return; }
      const canonical = `https://www.youtube.com/watch?v=${videoId}`;
      const row = db.prepare('INSERT INTO seen(title,youtube_url,video_id) VALUES(?,?,?)').run(title, canonical, videoId);
      const seenId = Number(row.lastInsertRowid);
      if (data.enqueue !== false) addToQueue(seenId, data.mode === 'next' ? 'next' : 'end', String(data.name || '訪客').trim().slice(0, 40) || '訪客');
      json(res, 201, { seenId, ...state() });
    } else if (req.method === 'POST' && url.pathname === '/api/queue') {
      const data = await body(req);
      if (!addToQueue(Number(data.seenId), data.mode === 'next' ? 'next' : 'end', String(data.name || '訪客').trim().slice(0, 40) || '訪客')) {
        json(res, 404, { error: '找不到這首歌' }); return;
      }
      json(res, 201, state());
    } else if (req.method === 'DELETE' && /^\/api\/queue\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').pop());
      const row = db.prepare("UPDATE queue SET status='removed' WHERE id=? AND status='pending'").run(id);
      if (!row.changes) { json(res, 404, { error: '這首歌已不在待播清單' }); return; }
      json(res, 200, state());
    } else if (req.method === 'PATCH' && /^\/api\/queue\/\d+\/next$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/')[3]);
      const first = (db.prepare("SELECT MIN(sort_order) AS n FROM queue WHERE status='pending'").get().n ?? 0) - 1;
      const row = db.prepare("UPDATE queue SET sort_order=? WHERE id=? AND status='pending'").run(first, id);
      if (!row.changes) { json(res, 404, { error: '這首歌已不在待播清單' }); return; }
      json(res, 200, state());
    } else if (req.method === 'GET' && /^\/api\/lyrics\/\d+$/.test(url.pathname)) {
      const seenId = Number(url.pathname.split('/').pop());
      const row = lyricsRow(seenId) ?? await findLyrics(seenId, { duration: Number(url.searchParams.get('duration')) || 0 });
      if (!row) { json(res, 404, { error: '找不到這首歌' }); return; }
      json(res, 200, row);
    } else if (req.method === 'POST' && /^\/api\/lyrics\/\d+\/search$/.test(url.pathname)) {
      if (!isAdmin) { json(res, 403, { error: '只有主機可以更換歌詞' }); return; }
      const data = await body(req);
      const row = await findLyrics(Number(url.pathname.split('/')[3]), {
        duration: Number(data.duration) || 0,
        query: String(data.query || '').trim().slice(0, 100),
        skipCurrent: true
      });
      if (!row) { json(res, 404, { error: '找不到這首歌' }); return; }
      json(res, 200, row);
    } else if (req.method === 'PATCH' && /^\/api\/lyrics\/\d+$/.test(url.pathname)) {
      if (!isAdmin) { json(res, 403, { error: '只有主機可以調整歌詞' }); return; }
      const data = await body(req);
      const offset = Math.max(-60_000, Math.min(60_000, Math.round(Number(data.offsetMs) || 0)));
      const row = db.prepare('UPDATE lyrics SET offset_ms=? WHERE seen_id=?').run(offset, Number(url.pathname.split('/').pop()));
      if (!row.changes) { json(res, 404, { error: '這首歌還沒有歌詞' }); return; }
      json(res, 200, { offset_ms: offset });
    } else if (req.method === 'POST' && url.pathname === '/api/next') {
      advance(); json(res, 200, state());
    } else { json(res, 404, { error: '找不到功能' }); }
  } catch (e) {
    json(res, 400, { error: e.message || '操作失敗' });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`連接埠 ${port} 已被使用；KTV 可能已經在執行。`);
      console.error(`請先開啟 http://localhost:${port}，或關閉舊的 KTV 視窗後再試。`);
    } else {
      console.error('KTV 啟動失敗：', error.message);
    }
    process.exitCode = 1;
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`KTV 管理畫面：http://localhost:${port}/?token=${adminToken}`);
    console.log(`手機點歌連結：${clientAddress()}/join/${roomCode}`);
    console.log('請讓手機與這台電腦連上同一個網路。');
  });
}
