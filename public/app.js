const token = new URLSearchParams(location.search).get('token') || '';
const $ = id => document.getElementById(id);
let role = 'client';
let currentId = null;
let player = null;
let playerReady = false;
let renderedVideoId = null;
let searchSerial = 0;
let toastTimer;
let catalogSongs = [];
let catalogLoaded = false;

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2800);
}
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '操作失敗');
  return data;
}
function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text != null) item.textContent = text;
  return item;
}
function button(text, className, click) {
  const item = el('button', className, text);
  item.type = 'button';
  item.addEventListener('click', click);
  return item;
}
async function action(path, options, success) {
  try { await api(path, options); await refresh(); if (success) toast(success); }
  catch (error) { toast(error.message); }
}
function renderNow(song) {
  const area = $('nowContent');
  area.replaceChildren();
  $('nextButton').disabled = !song;
  if (!song) {
    area.append(el('div', 'empty-now', '還沒有歌曲，點一首開始唱吧！'));
  } else {
    area.append(el('div', 'now-title', song.title), el('div', 'now-sub', `由 ${song.added_by} 點播`));
  }
  if (role === 'admin') { syncPlayer(song?.video_id || null); syncLyrics(song?.seen_id || null); }
}
function renderQueue(songs) {
  $('queueCount').textContent = `${songs.length} 首`;
  const list = $('queueList');
  list.replaceChildren();
  if (!songs.length) { list.append(el('div', 'queue-empty', '待播清單是空的，下一位歌手就是你。')); return; }
  songs.forEach((song, index) => {
    const row = el('div', 'queue-row');
    const info = el('div');
    info.append(el('div', 'queue-title', song.title), el('div', 'queue-meta', `${song.added_by} 點播`));
    const actions = el('div', 'queue-actions');
    if (index !== 0) actions.append(button('插到下一首', 'small-button', () => action(`/api/queue/${song.id}/next`, { method: 'PATCH' }, '已排到下一首')));
    actions.append(button('刪除', 'small-button danger', () => action(`/api/queue/${song.id}`, { method: 'DELETE' }, '已從歌單刪除')));
    row.append(el('div', 'queue-number', String(index + 1).padStart(2, '0')), info, actions);
    list.append(row);
  });
}
async function refresh() {
  const data = await api('/api/state');
  role = data.role;
  $('roleBadge').textContent = role === 'admin' ? '主機管理模式' : '手機點歌模式';
  $('app').hidden = false;
  $('inviteCard').hidden = role !== 'admin';
  $('catalogPanel').hidden = role !== 'client';
  renderNow(data.current);
  renderQueue(data.upcoming);
  if (role === 'client' && !catalogLoaded) loadCatalog();
  if (role === 'admin' && data.clientUrl && $('inviteUrl').value !== data.clientUrl) {
    $('inviteUrl').value = data.clientUrl;
    renderQr(data.clientUrl);
  }
}
function renderQr(url) {
  const target = $('qrCode');
  target.replaceChildren();
  if (window.QRCode) {
    new QRCode(target, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
  } else {
    const img = el('img');
    img.alt = '手機點歌 QR code';
    img.width = 220; img.height = 220;
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}`;
    target.append(img);
  }
}
function syncPlayer(videoId) {
  $('playerWrap').hidden = !videoId;
  if (!videoId) { renderedVideoId = null; if (player?.stopVideo) player.stopVideo(); return; }
  if (videoId === renderedVideoId) return;
  renderedVideoId = videoId;
  if (playerReady) player.loadVideoById(videoId);
  else if (!player) loadPlayer();
}
function loadPlayer() {
  const script = document.createElement('script');
  script.src = 'https://www.youtube.com/iframe_api';
  document.head.append(script);
}
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    videoId: renderedVideoId,
    // fs:0 hides YouTube's own fullscreen button, which would hide the lyrics overlay.
    playerVars: { autoplay: 1, rel: 0, fs: 0, iv_load_policy: 3 },
    events: {
      onReady: event => { playerReady = true; if (renderedVideoId) event.target.loadVideoById(renderedVideoId); },
      onStateChange: event => {
        loadLyrics();
        if (event.data === YT.PlayerState.ENDED) action('/api/next', { method: 'POST' });
      }
    }
  });
};

// ---- Karaoke lyrics ----
// Lyrics come from LRCLIB as line-timed LRC. Each line fills left to right over its duration,
// shown on two alternating rows like a KTV screen.
const lyrics = { seenId: null, requested: false, retryAt: 0, lines: [], offsetMs: 0, saveTimer: null };
let lyricsEnabled = localStorage.getItem('ktv-lyrics') !== 'off';
let lyricsFrame = null;
let clock = { reported: -1, at: 0, shown: 0 };
const slots = [...document.querySelectorAll('#lyricsOverlay .lyric-line')].map(line => ({
  line, base: line.querySelector('.lyric-base'), fill: line.querySelector('.lyric-fill'), text: null
}));

function parseLrc(text) {
  const stamps = [];
  for (const raw of (text || '').split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const content = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const [, min, sec] of times) stamps.push({ start: (Number(min) * 60 + Number(sec)) * 1000, text: content });
  }
  stamps.sort((a, b) => a.start - b.start);
  const lines = [];
  stamps.forEach((stamp, index) => {
    if (!stamp.text) return;
    const nextStart = stamps[index + 1]?.start ?? stamp.start + 6000;
    // Before an instrumental break the next timestamp is far away; don't stretch the fill across it.
    const sung = Math.max(2500, [...stamp.text.replace(/\s/g, '')].length * 450);
    lines.push({ start: stamp.start, end: Math.min(nextStart, stamp.start + sung), text: stamp.text });
  });
  return lines;
}

function syncLyrics(seenId) {
  $('lyricsBar').hidden = !seenId;
  if (seenId !== lyrics.seenId) {
    Object.assign(lyrics, { seenId, requested: false, retryAt: 0, lines: [], offsetMs: 0 });
    $('lyricsQuery').value = '';
    renderLyricsMeta('');
    updateLyricsVisibility();
  }
  // Also retried on every state poll until the player knows the video length.
  loadLyrics();
}
function playingDuration() {
  // Only trust the duration once the player has switched to the current video.
  return playerReady && player.getVideoData()?.video_id === renderedVideoId ? Math.round(player.getDuration() || 0) : 0;
}
async function loadLyrics() {
  if (!lyrics.seenId || lyrics.requested || Date.now() < lyrics.retryAt || !playingDuration()) return;
  lyrics.requested = true;
  const seenId = lyrics.seenId;
  renderLyricsMeta('正在尋找歌詞…');
  try {
    applyLyrics(seenId, await api(`/api/lyrics/${seenId}?duration=${playingDuration()}`));
  } catch (error) {
    if (seenId === lyrics.seenId) { lyrics.requested = false; lyrics.retryAt = Date.now() + 30_000; renderLyricsMeta(error.message); }
  }
}
async function searchLyrics(query) {
  const seenId = lyrics.seenId;
  if (!seenId) return;
  renderLyricsMeta('正在尋找歌詞…');
  try {
    applyLyrics(seenId, await api(`/api/lyrics/${seenId}/search`, { method: 'POST', body: JSON.stringify({ query, duration: playingDuration() }) }));
  } catch (error) { renderLyricsMeta(error.message); }
}
function applyLyrics(seenId, row) {
  if (seenId !== lyrics.seenId) return;
  lyrics.requested = true;
  lyrics.lines = parseLrc(row.synced);
  lyrics.offsetMs = row.offset_ms || 0;
  slots.forEach(slot => { slot.text = null; });
  renderLyricsMeta(lyrics.lines.length ? `歌詞：${row.track}（LRCLIB）` : '找不到同步歌詞，可以輸入「歌名 歌手」再搜尋。');
  updateLyricsVisibility();
}
function renderLyricsMeta(status) {
  $('lyricsStatus').textContent = status;
  $('lyricsToggle').textContent = `字幕：${lyricsEnabled ? '開' : '關'}`;
  const seconds = lyrics.offsetMs / 1000;
  $('lyricsOffset').textContent = seconds === 0 ? '±0.0s' : `${seconds > 0 ? '+' : ''}${seconds.toFixed(1)}s`;
}
function updateLyricsVisibility() {
  const show = lyricsEnabled && lyrics.lines.length > 0;
  $('lyricsOverlay').hidden = !show;
  if (show && !lyricsFrame) lyricsFrame = requestAnimationFrame(drawLyrics);
}
function nudgeOffset(deltaMs) {
  if (!lyrics.lines.length) return;
  lyrics.offsetMs += deltaMs;
  renderLyricsMeta($('lyricsStatus').textContent);
  clearTimeout(lyrics.saveTimer);
  const seenId = lyrics.seenId;
  const offsetMs = lyrics.offsetMs;
  lyrics.saveTimer = setTimeout(() => api(`/api/lyrics/${seenId}`, { method: 'PATCH', body: JSON.stringify({ offsetMs }) }).catch(error => toast(error.message)), 600);
}
function videoMs() {
  // The iframe API only reports the time a few times per second; extrapolate between reports
  // so the colour moves smoothly.
  const reported = (player.getCurrentTime() || 0) * 1000;
  const now = performance.now();
  if (reported !== clock.reported) clock = { ...clock, reported, at: now };
  let estimate = reported;
  if (player.getPlayerState() === YT.PlayerState.PLAYING) estimate += Math.min(now - clock.at, 1000);
  if (estimate < clock.shown && clock.shown - estimate < 300) estimate = clock.shown;
  clock.shown = estimate;
  return estimate;
}
function setSlot(slot, line, progress) {
  const text = line?.text ?? '';
  if (slot.text !== text) {
    slot.text = text;
    slot.base.textContent = text;
    slot.fill.textContent = text;
    slot.line.style.fontSize = '';
    const room = $('lyricsOverlay').clientWidth * 0.94;
    const width = slot.line.scrollWidth;
    if (width > room) slot.line.style.fontSize = `${parseFloat(getComputedStyle(slot.line).fontSize) * room / width}px`;
  }
  slot.fill.style.width = `${Math.round(progress * 1000) / 10}%`;
}
function drawLyrics() {
  lyricsFrame = null;
  if ($('lyricsOverlay').hidden || !playerReady) return;
  const t = videoMs() - lyrics.offsetMs;
  const lines = lyrics.lines;
  let current = -1;
  while (current + 1 < lines.length && lines[current + 1].start <= t) current += 1;
  if (current < 0) {
    setSlot(slots[0], lines[0], 0);
    setSlot(slots[1], lines[1], 0);
  } else {
    const line = lines[current];
    const next = lines[current + 1];
    const inBreak = t > line.end + 3000 && (!next || next.start - t > 5000);
    setSlot(slots[current % 2], inBreak ? null : line, Math.min(1, Math.max(0, (t - line.start) / (line.end - line.start))));
    setSlot(slots[(current + 1) % 2], next, 0);
  }
  lyricsFrame = requestAnimationFrame(drawLyrics);
}
function toggleFullscreen() {
  const wrap = $('playerWrap');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    Promise.resolve((wrap.requestFullscreen || wrap.webkitRequestFullscreen).call(wrap)).catch(() => toast('瀏覽器不允許全螢幕'));
  }
}
function onFullscreenChange() {
  slots.forEach(slot => { slot.text = null; });
  $('lyricsFullscreen').textContent = document.fullscreenElement || document.webkitFullscreenElement ? '離開全螢幕' : '全螢幕 ⛶';
}
$('lyricsToggle').addEventListener('click', () => {
  lyricsEnabled = !lyricsEnabled;
  localStorage.setItem('ktv-lyrics', lyricsEnabled ? 'on' : 'off');
  renderLyricsMeta($('lyricsStatus').textContent);
  updateLyricsVisibility();
});
$('lyricsEarlier').addEventListener('click', () => nudgeOffset(-500));
$('lyricsLater').addEventListener('click', () => nudgeOffset(500));
$('lyricsSwap').addEventListener('click', () => searchLyrics(''));
$('lyricsSearchForm').addEventListener('submit', event => { event.preventDefault(); searchLyrics($('lyricsQuery').value.trim()); });
$('lyricsFullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
async function search() {
  const query = $('searchInput').value.trim();
  const serial = ++searchSerial;
  const area = $('searchResults');
  if (!query) { area.replaceChildren(); return; }
  try {
    const { songs } = await api(`/api/seen?q=${encodeURIComponent(query)}`);
    if (serial !== searchSerial) return;
    area.replaceChildren();
    if (songs.length) area.append(el('div', 'search-section-title', '曾經收錄的歌曲'));
    for (const song of songs) {
      const result = el('div', 'result');
      const copy = el('div', 'result-copy');
      copy.append(el('div', 'result-title', song.title), el('div', 'result-link', song.youtube_url));
      const actions = el('div', 'result-actions');
      actions.append(button('點歌', '', () => queueSong(song.id, 'end')), button('插播', '', () => queueSong(song.id, 'next')));
      result.append(copy, actions); area.append(result);
    }
    if (!songs.length) await renderYouTubeResults(query, serial, area);
    if (serial === searchSerial) area.append(button(`＋ 手動貼上「${query}」的 YouTube 連結`, 'new-button', openNewSong));
  } catch (error) { toast(error.message); }
}

async function renderYouTubeResults(query, serial, area) {
  const loading = el('div', 'search-empty', `歌庫裡找不到「${query}」，正在搜尋 YouTube…`);
  area.append(loading);
  try {
    const { results } = await api(`/api/youtube-search?q=${encodeURIComponent(query)}`);
    if (serial !== searchSerial) return;
    loading.remove();
    area.append(el('div', 'search-section-title', 'YouTube 搜尋結果'));
    if (!results.length) area.append(el('div', 'search-empty', 'YouTube 也找不到相關影片，可以手動貼上連結。'));
    for (const result of results) {
      const row = el('article', 'youtube-result');
      const image = el('img', 'youtube-result-image');
      image.src = result.thumbnailUrl;
      image.alt = `${result.title} 的 YouTube 封面`;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      const content = el('div', 'youtube-result-content');
      content.append(el('div', 'youtube-result-title', result.title));
      if (result.channel) content.append(el('div', 'youtube-result-channel', result.channel));
      const actions = el('div', 'youtube-result-actions');
      actions.append(
        button('新增並點歌', 'catalog-primary', () => addYouTubeResult(result, 'end')),
        button('新增並插播', 'catalog-secondary', () => addYouTubeResult(result, 'next'))
      );
      content.append(actions);
      row.append(image, content);
      area.append(row);
    }
  } catch (error) {
    if (serial !== searchSerial) return;
    loading.textContent = `${error.message}，仍可手動貼上連結。`;
  }
}

async function addYouTubeResult(result, mode) {
  try {
    await api('/api/seen', {
      method: 'POST',
      body: JSON.stringify({ title: result.title, youtubeUrl: result.youtubeUrl, mode, name: name() })
    });
    catalogLoaded = false;
    if (role === 'client') loadCatalog(true);
    await refresh();
    toast(mode === 'next' ? '新歌已收錄並插播' : '新歌已收錄並加入歌單');
  } catch (error) { toast(error.message); }
}
function name() { return $('nameInput').value.trim() || '訪客'; }
async function queueSong(seenId, mode) {
  await action('/api/queue', { method: 'POST', body: JSON.stringify({ seenId, mode, name: name() }) }, mode === 'next' ? '已插播' : '已加入歌單');
}
function renderCatalog() {
  const query = $('catalogFilter').value.trim().toLocaleLowerCase('zh-Hant');
  const songs = query ? catalogSongs.filter(song => song.title.toLocaleLowerCase('zh-Hant').includes(query)) : catalogSongs;
  $('catalogCount').textContent = `顯示 ${songs.length} 首`;
  const grid = $('catalogGrid');
  grid.replaceChildren();
  for (const song of songs) {
    const card = el('article', 'catalog-song');
    const image = el('img', 'catalog-cover');
    image.src = `https://i.ytimg.com/vi/${song.video_id}/mqdefault.jpg`;
    image.alt = `${song.title} 的 YouTube 封面`;
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    const body = el('div', 'catalog-song-body');
    body.append(el('div', 'catalog-song-title', song.title));
    const actions = el('div', 'catalog-song-actions');
    actions.append(button('點歌', 'catalog-primary', () => queueSong(song.id, 'end')), button('插播', 'catalog-secondary', () => queueSong(song.id, 'next')));
    body.append(actions);
    card.append(image, body);
    grid.append(card);
  }
}
async function loadCatalog(force = false) {
  if (catalogLoaded && !force) return;
  $('catalogCount').textContent = '正在載入歌曲…';
  try {
    const data = await api('/api/seen?all=1');
    catalogSongs = data.songs;
    catalogLoaded = true;
    renderCatalog();
  } catch (error) {
    $('catalogCount').textContent = '歌曲載入失敗';
    toast(error.message);
  }
}
function openNewSong() {
  $('newSong').hidden = false;
  $('newTitle').value = $('searchInput').value.trim();
  $('unknownMessage').textContent = `可以新增全新的歌曲版本；同名歌曲會分開保存。`;
  $('newUrl').focus();
}
async function saveSong() {
  const title = $('newTitle').value.trim();
  const youtubeUrl = $('newUrl').value.trim();
  if (!title || !youtubeUrl) { toast('請填歌名和 YouTube 連結'); return; }
  try {
    await api('/api/seen', { method: 'POST', body: JSON.stringify({ title, youtubeUrl, name: name() }) });
    $('newSong').hidden = true;
    $('newUrl').value = '';
    $('searchInput').value = '';
    $('searchResults').replaceChildren();
    catalogLoaded = false;
    if (role === 'client') loadCatalog(true);
    await refresh();
    toast('新歌已收錄並加入歌單');
  } catch (error) { toast(error.message); }
}
// ---- Song list import ----
// Two sources: a YouTube playlist link (already videos), or pasted song names that are each
// matched to a YouTube search result. Everything is shown for review before saving.
let importItems = [];
let importSerial = 0;
let importBusy = false;

function parseSongLines(text) {
  const seen = new Set();
  const lines = [];
  let skippedLinks = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(\d+\s*[.)、:：]|[-•*·])\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!line) continue;
    if (/^https?:\/\//i.test(line)) { skippedLinks += 1; continue; }
    const key = line.toLocaleLowerCase('zh-Hant');
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return { lines: lines.slice(0, 100), skippedLinks, tooMany: lines.length > 100 };
}
function importChoice(item) { return item.results[item.choice] || null; }
// YouTube always returns something; flag results that share no word with what was typed.
function looksRelated(query, title) {
  const target = title.toLocaleLowerCase('zh-Hant');
  return query.toLocaleLowerCase('zh-Hant').split(/\s+/).some(word => word && target.includes(word));
}
function updateImportFooter() {
  const count = importItems.filter(item => item.checked && importChoice(item)).length;
  $('importFooter').hidden = !importItems.length;
  $('importSave').textContent = `匯入 ${count} 首`;
  $('importSave').disabled = importBusy || !count;
  $('importToggleAll').textContent = count ? '全不選' : '全選';
}
function renderImportRow(item) {
  const video = importChoice(item);
  item.check.checked = item.checked;
  item.check.disabled = !video;
  item.image.hidden = !video;
  if (video) item.image.src = video.thumbnailUrl;
  const area = item.videoArea;
  area.replaceChildren();
  if (item.status === 'pending') area.append(el('span', 'import-note', '等待比對…'));
  else if (!video) area.append(el('span', 'import-note warn', item.status === 'error' ? '搜尋失敗' : '找不到影片'));
  else if (item.results.length > 1) {
    if (!looksRelated(item.query, video.title)) area.append(el('span', 'import-note warn', '可能不是這首，請確認'));
    const select = el('select', 'import-select');
    item.results.forEach((result, index) => {
      const option = el('option', null, `${result.title}${result.inCatalog ? '（已在歌庫）' : ''}`);
      option.value = String(index);
      select.append(option);
    });
    select.value = String(item.choice);
    select.addEventListener('change', () => { item.choice = Number(select.value); renderImportRow(item); });
    area.append(select);
  } else {
    area.append(el('span', 'import-note', `${video.channel || 'YouTube'}${video.inCatalog ? ' · 已在歌庫' : ''}`));
  }
  updateImportFooter();
}
function buildImportList(items) {
  importItems = items;
  const list = $('importList');
  list.replaceChildren();
  for (const item of items) {
    const row = el('div', 'import-row');
    item.check = el('input');
    item.check.type = 'checkbox';
    item.check.setAttribute('aria-label', '匯入這首歌');
    item.check.addEventListener('change', () => { item.checked = item.check.checked; updateImportFooter(); });
    item.image = el('img', 'import-thumb');
    item.image.alt = '';
    item.image.loading = 'lazy';
    item.image.referrerPolicy = 'no-referrer';
    const body = el('div', 'import-body');
    const title = el('input', 'import-title');
    title.type = 'text';
    title.maxLength = 120;
    title.value = item.title;
    title.setAttribute('aria-label', '歌名');
    title.addEventListener('input', () => { item.title = title.value; });
    item.videoArea = el('div', 'import-video');
    body.append(title, item.videoArea);
    row.append(item.check, item.image, body);
    list.append(row);
    renderImportRow(item);
  }
}
async function loadImport() {
  const text = $('importInput').value.trim();
  if (!text) { toast('請貼上播放清單連結或歌名'); return; }
  const serial = ++importSerial;
  const playlistUrl = text.split(/\s+/).find(word => /youtube\.com\/.*[?&]list=/i.test(word));
  importBusy = true;
  buildImportList([]);
  try {
    if (playlistUrl) {
      $('importStatus').textContent = '正在讀取播放清單…';
      const { title, songs, truncated } = await api('/api/import/playlist', { method: 'POST', body: JSON.stringify({ url: playlistUrl }) });
      if (serial !== importSerial) return;
      buildImportList(songs.map(song => ({ title: song.title, checked: true, results: [song], choice: 0, status: 'done' })));
      $('importStatus').textContent = `「${title}」${truncated ? `太長了，只讀取前 ${songs.length} 首` : `共 ${songs.length} 首`}，可以修改歌名或取消勾選。`;
      return;
    }
    const { lines, skippedLinks, tooMany } = parseSongLines(text);
    if (!lines.length) { $('importStatus').textContent = '沒有讀到歌名。Spotify 等連結無法直接讀取，請貼上歌名。'; return; }
    const notes = [skippedLinks && `略過 ${skippedLinks} 個無法讀取的連結`, tooMany && '只處理前 100 首'].filter(Boolean).join('，');
    buildImportList(lines.map(line => ({ title: line, query: line, checked: false, results: [], choice: 0, status: 'pending' })));
    const style = $('importStyle').value;
    // One search at a time with a short pause, so a long list doesn't flood YouTube.
    for (const [index, item] of importItems.entries()) {
      $('importStatus').textContent = `正在比對 YouTube ${index + 1}/${importItems.length}…${notes ? `（${notes}）` : ''}`;
      try {
        const { results } = await api(`/api/youtube-search?q=${encodeURIComponent(item.title + style)}`);
        if (serial !== importSerial) return;
        item.results = results.slice(0, 5);
        item.status = 'done';
      } catch {
        if (serial !== importSerial) return;
        item.status = 'error';
      }
      item.checked = item.results.length > 0 && looksRelated(item.query, item.results[0].title);
      renderImportRow(item);
      await new Promise(resolve => setTimeout(resolve, 250));
      if (serial !== importSerial) return;
    }
    const missing = importItems.filter(item => !item.checked).length;
    $('importStatus').textContent = `比對完成${missing ? `，${missing} 首沒有勾選，請確認` : ''}。可以換成其他搜尋結果、修改歌名或取消勾選。${notes ? `（${notes}）` : ''}`;
  } catch (error) {
    if (serial === importSerial) $('importStatus').textContent = error.message;
  } finally {
    if (serial === importSerial) { importBusy = false; updateImportFooter(); }
  }
}
async function saveImport() {
  const songs = importItems.filter(item => item.checked && importChoice(item))
    .map(item => ({ title: item.title.trim() || importChoice(item).title, youtubeUrl: importChoice(item).youtubeUrl }));
  if (!songs.length) return;
  $('importSave').disabled = true;
  try {
    const enqueue = $('importEnqueue').checked;
    const result = await api('/api/import', { method: 'POST', body: JSON.stringify({ songs, enqueue, name: name() }) });
    const parts = [`已匯入 ${result.added} 首新歌`];
    if (result.existing) parts.push(`${result.existing} 首原本就在歌庫`);
    if (enqueue) parts.push(`${result.queued} 首加入待播清單`);
    closeImport();
    $('importInput').value = '';
    catalogLoaded = false;
    if (role === 'client') loadCatalog(true);
    await refresh();
    toast(parts.join('，'));
  } catch (error) {
    toast(error.message);
    updateImportFooter();
  }
}
function closeImport() {
  importSerial += 1;
  importBusy = false;
  $('importPanel').hidden = true;
  $('importStatus').textContent = '';
  buildImportList([]);
}

function showError(message) { $('app').hidden = true; $('errorScreen').hidden = false; $('errorText').textContent = message; }

$('nameInput').value = localStorage.getItem('ktv-name') || '';
$('nameInput').addEventListener('input', () => localStorage.setItem('ktv-name', $('nameInput').value));
$('searchInput').addEventListener('input', () => { clearTimeout(window.searchTimer); window.searchTimer = setTimeout(search, 450); });
$('catalogFilter').addEventListener('input', renderCatalog);
$('catalogAddButton').addEventListener('click', () => { $('searchInput').value = ''; openNewSong(); });
$('cancelNew').addEventListener('click', () => { $('newSong').hidden = true; });
$('saveSong').addEventListener('click', saveSong);
$('importOpen').addEventListener('click', () => { $('importPanel').hidden = false; $('importInput').focus(); });
$('importCancel').addEventListener('click', closeImport);
$('importLoad').addEventListener('click', loadImport);
$('importSave').addEventListener('click', saveImport);
$('importToggleAll').addEventListener('click', () => {
  const select = !importItems.some(item => item.checked && importChoice(item));
  for (const item of importItems) { item.checked = select && Boolean(importChoice(item)); item.check.checked = item.checked; }
  updateImportFooter();
});
$('nextButton').addEventListener('click', () => action('/api/next', { method: 'POST' }, '已切換到下一首'));
$('copyButton').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('inviteUrl').value); toast('連結已複製'); } catch { $('inviteUrl').select(); toast('請複製選取的連結'); } });
$('openQrButton').addEventListener('click', () => {
  const popup = window.open(`/qr.html?token=${encodeURIComponent(token)}`, 'ktv-qr-display', 'popup,width=760,height=900');
  if (!popup) toast('瀏覽器阻擋了新視窗，請允許彈出式視窗');
  else popup.focus();
});
if (!token) showError('請從主機畫面的 QR code 加入。');
else {
  refresh().catch(error => showError(error.message));
  setInterval(() => refresh().catch(() => toast('連線中斷，正在重試…')), 2500);
}
