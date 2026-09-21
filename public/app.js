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
  if (role === 'admin') syncPlayer(song?.video_id || null);
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
    playerVars: { autoplay: 1, rel: 0 },
    events: {
      onReady: event => { playerReady = true; if (renderedVideoId) event.target.loadVideoById(renderedVideoId); },
      onStateChange: event => { if (event.data === YT.PlayerState.ENDED) action('/api/next', { method: 'POST' }); }
    }
  });
};
async function search() {
  const query = $('searchInput').value.trim();
  const serial = ++searchSerial;
  const area = $('searchResults');
  if (!query) { area.replaceChildren(); return; }
  try {
    const { songs } = await api(`/api/seen?q=${encodeURIComponent(query)}`);
    if (serial !== searchSerial) return;
    area.replaceChildren();
    if (!songs.length) area.append(el('div', 'search-empty', `找不到「${query}」，可以新增這首歌的連結。`));
    for (const song of songs) {
      const result = el('div', 'result');
      const copy = el('div', 'result-copy');
      copy.append(el('div', 'result-title', song.title), el('div', 'result-link', song.youtube_url));
      const actions = el('div', 'result-actions');
      actions.append(button('點歌', '', () => queueSong(song.id, 'end')), button('插播', '', () => queueSong(song.id, 'next')));
      result.append(copy, actions); area.append(result);
    }
    area.append(button(`＋ 新增「${query}」的 YouTube 連結`, 'new-button', openNewSong));
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
function showError(message) { $('app').hidden = true; $('errorScreen').hidden = false; $('errorText').textContent = message; }

$('nameInput').value = localStorage.getItem('ktv-name') || '';
$('nameInput').addEventListener('input', () => localStorage.setItem('ktv-name', $('nameInput').value));
$('searchInput').addEventListener('input', () => { clearTimeout(window.searchTimer); window.searchTimer = setTimeout(search, 180); });
$('catalogFilter').addEventListener('input', renderCatalog);
$('catalogAddButton').addEventListener('click', () => { $('searchInput').value = ''; openNewSong(); });
$('cancelNew').addEventListener('click', () => { $('newSong').hidden = true; });
$('saveSong').addEventListener('click', saveSong);
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
