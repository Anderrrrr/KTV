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
CREATE INDEX IF NOT EXISTS queue_active ON queue(status,sort_order);`);

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
