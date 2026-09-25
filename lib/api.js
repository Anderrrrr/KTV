// The /api/* routes, shared by the local server (server.js, SQLite) and the online
// Netlify function (netlify/functions/api.mjs, Postgres).
import crypto from 'node:crypto';
import {
  youtubeVideoId, searchYouTube, youtubePlaylistId, fetchYouTubePlaylist,
  spotifyListRef, fetchSpotifyList, lyricsCandidates
} from './external.js';
import { versionKind, baseTitle, partnerPlan } from './versions.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const cleanName = value => String(value || '訪客').trim().slice(0, 40) || '訪客';

function samePassword(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

async function markInCatalog(store, songs) {
  const known = await store.knownVideoIds(songs.map(song => song.videoId));
  return songs.map(song => ({ ...song, inCatalog: known.has(song.videoId) }));
}

// The other version of a song. Pairs already in the catalogue (e.g. "X－原唱" and
// "X－純伴奏") are linked the first time anyone asks.
async function versions(store, seenId) {
  const title = await store.seenTitle(seenId);
  if (!title) return null;
  const plan = partnerPlan(title);
  let partner = await store.partnerOf(seenId);
  if (!partner) {
    const base = baseTitle(title);
    const match = (await store.seenWithPrefix(base)).find(song => song.id !== seenId
      && baseTitle(song.title) === base && (versionKind(song.title) ?? 'vocal') === plan.partnerKind);
    if (match) {
      await store.savePartner(seenId, match.id, 0);
      partner = await store.partnerOf(seenId);
    }
  }
  return { kind: plan.kind, partnerKind: plan.partnerKind, searchQuery: plan.searchQuery, partner };
}

async function findLyrics(store, seenId, { duration = 0, query = '', skipCurrent = false } = {}) {
  const title = await store.seenTitle(seenId);
  if (!title) return null;
  const existing = await store.lyricsRow(seenId);
  const candidates = await lyricsCandidates(query || title, duration);
  let pick = candidates[0];
  if (skipCurrent && existing?.lrclib_id && !query) {
    const index = candidates.findIndex(item => item.id === Number(existing.lrclib_id));
    pick = candidates[(index + 1) % candidates.length];
  }
  return store.saveLyrics(seenId, {
    lrclibId: pick?.id ?? null,
    track: pick ? `${pick.trackName} - ${pick.artistName}` : null,
    synced: pick?.syncedLyrics ?? null
  });
}

/**
 * request: { method, path, params (URLSearchParams), token, json(limit) }
 * options: { clientUrl(room) → guest link, roomPassword (online only) }
 * Returns { status, body }.
 */
export async function handleApi(request, store, options) {
  try {
    return await route(request, store, options);
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: { error: error.message } };
    console.error(error);
    return { status: 400, body: { error: error.message || '操作失敗' } };
  }
}

async function route({ method, path, params, token, json }, store, options) {
  const ok = (body, status = 200) => ({ status, body });

  if (method === 'GET' && path === '/api/config') return ok({ mode: store.mode });
  if (method === 'POST' && path === '/api/rooms') {
    if (store.mode !== 'online') fail(404, '找不到功能');
    const data = await json();
    if (!options.roomPassword) fail(503, '尚未設定建立房間的密碼');
    if (!samePassword(data.password || '', options.roomPassword)) fail(403, '密碼錯誤');
    const room = await store.createRoom(String(data.name || '').trim().slice(0, 40) || null);
    return ok({ hostToken: room.hostToken }, 201);
  }

  const auth = await store.resolveToken(token);
  if (!auth) fail(401, '連結無效，請重新掃描 QR code');
  const { roomId } = auth;
  const isAdmin = auth.role === 'admin';
  const state = async () => store.state(roomId);

  if (method === 'GET' && path === '/api/state') {
    const room = await store.roomInfo(roomId);
    return ok({ ...(await state()), role: auth.role, roomName: room.name, clientUrl: isAdmin ? options.clientUrl(room) : undefined });
  }
  if (method === 'GET' && path === '/api/seen') {
    const query = (params.get('q') || '').trim().slice(0, 100);
    return ok({ songs: await store.listSeen({ query, all: params.get('all') === '1' }) });
  }
  if (method === 'GET' && path === '/api/youtube-search') {
    const query = (params.get('q') || '').trim().slice(0, 100);
    if (!query) fail(400, '請輸入要搜尋的歌名');
    return ok({ results: await markInCatalog(store, await searchYouTube(query)) });
  }
  if (method === 'POST' && path === '/api/import/playlist') {
    const data = await json();
    const listId = youtubePlaylistId(String(data.url || '').trim());
    if (!listId) fail(400, '請貼上有效的 YouTube 播放清單連結');
    if (/^(RD|UL|LL|WL)/.test(listId)) fail(400, '自動合輯、稍後觀看等清單無法匯入，請使用一般播放清單');
    const playlist = await fetchYouTubePlaylist(listId);
    return ok({ title: playlist.title, truncated: playlist.truncated, songs: await markInCatalog(store, playlist.songs) });
  }
  if (method === 'POST' && path === '/api/import/spotify') {
    const data = await json();
    const ref = spotifyListRef(String(data.url || '').trim());
    if (!ref) fail(400, '請貼上 Spotify 播放清單或專輯連結');
    return ok(await fetchSpotifyList(ref));
  }
  if (method === 'POST' && path === '/api/import') {
    const data = await json(131_072);
    const songs = (Array.isArray(data.songs) ? data.songs.slice(0, 300) : [])
      .map(song => ({ videoId: youtubeVideoId(String(song.youtubeUrl || '').trim()), title: String(song.title || '').trim().slice(0, 120) }))
      .filter(song => song.videoId && song.title);
    if (!songs.length) fail(400, '沒有要匯入的歌曲');
    const result = await store.importSongs(roomId, songs, data.enqueue === true, cleanName(data.name));
    return ok({ ...result, ...(await state()) }, 201);
  }
  if (method === 'POST' && path === '/api/seen') {
    const data = await json();
    const title = String(data.title || '').trim().slice(0, 120);
    const videoId = youtubeVideoId(String(data.youtubeUrl || '').trim());
    if (!title || !videoId) fail(400, '請填歌名和有效的 YouTube 連結');
    const seenId = await store.insertSeen(title, `https://www.youtube.com/watch?v=${videoId}`, videoId);
    if (data.enqueue !== false) await store.addToQueue(roomId, seenId, data.mode === 'next' ? 'next' : 'end', cleanName(data.name));
    return ok({ seenId, ...(await state()) }, 201);
  }
  if (method === 'POST' && path === '/api/queue') {
    const data = await json();
    if (!(await store.addToQueue(roomId, Number(data.seenId), data.mode === 'next' ? 'next' : 'end', cleanName(data.name)))) fail(404, '找不到這首歌');
    return ok(await state(), 201);
  }
  if (method === 'DELETE' && /^\/api\/queue\/\d+$/.test(path)) {
    if (!(await store.removeFromQueue(roomId, Number(path.split('/').pop())))) fail(404, '這首歌已不在待播清單');
    return ok(await state());
  }
  if (method === 'PATCH' && /^\/api\/queue\/\d+\/next$/.test(path)) {
    if (!(await store.moveToNext(roomId, Number(path.split('/')[3])))) fail(404, '這首歌已不在待播清單');
    return ok(await state());
  }
  if (method === 'GET' && /^\/api\/lyrics\/\d+$/.test(path)) {
    const seenId = Number(path.split('/').pop());
    const row = (await store.lyricsRow(seenId)) ?? await findLyrics(store, seenId, { duration: Number(params.get('duration')) || 0 });
    if (!row) fail(404, '找不到這首歌');
    return ok(row);
  }
  if (method === 'POST' && /^\/api\/lyrics\/\d+\/search$/.test(path)) {
    if (!isAdmin) fail(403, '只有主機可以更換歌詞');
    const data = await json();
    const row = await findLyrics(store, Number(path.split('/')[3]), {
      duration: Number(data.duration) || 0,
      query: String(data.query || '').trim().slice(0, 100),
      skipCurrent: true
    });
    if (!row) fail(404, '找不到這首歌');
    return ok(row);
  }
  if (method === 'PATCH' && /^\/api\/lyrics\/\d+$/.test(path)) {
    if (!isAdmin) fail(403, '只有主機可以調整歌詞');
    const data = await json();
    const offset = Math.max(-60_000, Math.min(60_000, Math.round(Number(data.offsetMs) || 0)));
    if (!(await store.setLyricsOffset(Number(path.split('/').pop()), offset))) fail(404, '這首歌還沒有歌詞');
    return ok({ offset_ms: offset });
  }
  if (method === 'GET' && /^\/api\/versions\/\d+$/.test(path)) {
    const info = await versions(store, Number(path.split('/').pop()));
    if (!info) fail(404, '找不到這首歌');
    return ok(info);
  }
  if (method === 'POST' && /^\/api\/versions\/\d+$/.test(path)) {
    if (!isAdmin) fail(403, '只有主機可以設定原唱／伴唱版本');
    const seenId = Number(path.split('/').pop());
    const title = await store.seenTitle(seenId);
    if (!title) fail(404, '找不到這首歌');
    const data = await json();
    const videoId = youtubeVideoId(String(data.youtubeUrl || '').trim());
    if (!videoId) fail(400, '請選擇有效的 YouTube 影片');
    let partnerId = await store.findSeenByVideo(videoId);
    if (partnerId === seenId) fail(400, '這就是目前的版本，請選另一個影片');
    partnerId ??= await store.insertSeen(partnerPlan(title).partnerTitle, `https://www.youtube.com/watch?v=${videoId}`, videoId);
    await store.savePartner(seenId, partnerId, 0);
    return ok(await versions(store, seenId), 201);
  }
  if (method === 'PATCH' && /^\/api\/versions\/\d+$/.test(path)) {
    if (!isAdmin) fail(403, '只有主機可以調整版本對齊');
    const data = await json();
    const offset = Math.max(-120_000, Math.min(120_000, Math.round(Number(data.offsetMs) || 0)));
    if (!(await store.setPartnerOffset(Number(path.split('/').pop()), offset))) fail(404, '這首歌還沒有配對版本');
    return ok({ offset_ms: offset });
  }
  if (method === 'POST' && path === '/api/playing/partner') {
    const data = await json();
    if (!(await store.setUsePartner(roomId, Number(data.queueId), data.on === true))) fail(409, '這首歌已經播完了');
    return ok(await state());
  }
  if (method === 'GET' && path === '/api/history') return ok(await store.history(roomId));
  if (method === 'POST' && path === '/api/next') {
    const data = await json();
    await store.advance(roomId, data.reason === 'finished' ? 'finished' : 'skipped');
    return ok(await state());
  }
  fail(404, '找不到功能');
}
