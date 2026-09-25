import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSqliteStore } from './lib/store-sqlite.js';
import { handleApi } from './lib/api.js';

export { youtubeVideoId, searchYouTube, youtubePlaylistId, fetchYouTubePlaylist, spotifyListRef, fetchSpotifyList, lyricsQueries } from './lib/external.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const store = createSqliteStore({ dbPath: path.join(dataDir, 'ktv.sqlite'), seedPath: path.join(root, 'seed', 'songs.json') });
const { adminToken, clientToken, roomCode } = store;
const port = Number(process.env.PORT || 3000);

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req, limit = 16_384) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('資料過大');
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
  const result = await handleApi({
    method: req.method,
    path: url.pathname,
    params: url.searchParams,
    token: req.headers.authorization?.replace(/^Bearer /, '') || '',
    json: limit => body(req, limit)
  }, store, { clientUrl: room => `${clientAddress()}/join/${room.code}` });
  json(res, result.status, result.body);
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
