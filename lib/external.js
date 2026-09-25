// Calls to outside services: YouTube (search, playlists), Spotify (playlist track lists)
// and LRCLIB (synced lyrics). No database access here.

const youtubeSearchCache = new Map();

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

const youtubeHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.7'
};

export async function searchYouTube(query) {
  const cacheKey = query.toLocaleLowerCase('zh-Hant');
  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;
  const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
    headers: youtubeHeaders,
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

export function youtubePlaylistId(input) {
  try {
    const url = new URL(input);
    if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return null;
    const id = url.searchParams.get('list') || '';
    return /^[A-Za-z0-9_-]{10,64}$/.test(id) ? id : null;
  } catch { return null; }
}

// Playlist pages list songs as lockupViewModel entries (older pages used playlistVideoRenderer).
function collectPlaylistPage(value, page) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) collectPlaylistPage(item, page); return; }
  const lockup = value.lockupViewModel;
  if (lockup) {
    const meta = lockup.metadata?.lockupMetadataViewModel;
    if (lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
      page.videos.push({
        videoId: lockup.contentId,
        title: meta?.title?.content || '',
        channel: meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || ''
      });
    }
    return;
  }
  const legacy = value.playlistVideoRenderer;
  if (legacy) {
    page.videos.push({
      videoId: legacy.videoId,
      title: legacy.title?.runs?.map(run => run.text).join('') || legacy.title?.simpleText || '',
      channel: legacy.shortBylineText?.runs?.map(run => run.text).join('') || ''
    });
    return;
  }
  if (value.continuationCommand?.token) page.continuation ??= value.continuationCommand.token;
  for (const child of Object.values(value)) collectPlaylistPage(child, page);
}

export async function fetchYouTubePlaylist(listId, limit = 300) {
  const response = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`, {
    headers: youtubeHeaders,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error('無法讀取這個 YouTube 播放清單');
  const html = await response.text();
  const initialData = jsonObjectAfter(html, 'var ytInitialData =') || jsonObjectAfter(html, 'ytInitialData =');
  const tab = initialData?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content;
  if (!tab) throw new Error('找不到播放清單，請確認它是公開或不公開（非私人）的清單');
  const page = { videos: [], continuation: null };
  collectPlaylistPage(tab, page);
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  // Each page holds 100 songs; follow the continuation for longer playlists.
  while (page.continuation && clientVersion && page.videos.length < limit) {
    const token = page.continuation;
    page.continuation = null;
    const next = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: { ...youtubeHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'zh-TW' } }, continuation: token }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!next.ok) break;
    collectPlaylistPage((await next.json()).onResponseReceivedActions, page);
  }
  const unique = new Map();
  for (const video of page.videos) {
    if (/^[A-Za-z0-9_-]{11}$/.test(video.videoId || '') && video.title && !unique.has(video.videoId)) unique.set(video.videoId, video);
  }
  const title = initialData.header?.pageHeaderRenderer?.pageTitle
    || initialData.metadata?.playlistMetadataRenderer?.title || 'YouTube 播放清單';
  return {
    title,
    truncated: unique.size > limit || Boolean(page.continuation),
    songs: [...unique.values()].slice(0, limit).map(video => ({
      ...video,
      youtubeUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`
    }))
  };
}

export function spotifyListRef(input) {
  const match = String(input).match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})/i)
    || String(input).match(/spotify:(playlist|album):([A-Za-z0-9]{22})/i);
  return match ? { type: match[1].toLowerCase(), id: match[2] } : null;
}

// Spotify's embed player page carries the track list without needing an API key.
// It lists at most 100 tracks and has no total count.
export async function fetchSpotifyList({ type, id }) {
  const response = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: youtubeHeaders,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error('無法讀取這個 Spotify 歌單');
  const html = await response.text();
  const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s)?.[1];
  let entity = null;
  try { entity = raw && JSON.parse(raw).props?.pageProps?.state?.data?.entity; } catch { entity = null; }
  if (!entity?.trackList) throw new Error('找不到這個 Spotify 歌單，請確認它是公開的');
  const tracks = entity.trackList
    .map(track => ({ title: String(track.title || '').trim(), artist: String(track.subtitle || '').trim() }))
    .filter(track => track.title);
  return { title: entity.name || 'Spotify 歌單', tracks, truncated: tracks.length >= 100 };
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

export async function lyricsCandidates(title, duration) {
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
