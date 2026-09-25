const token = new URLSearchParams(location.search).get('token') || '';
const qrTarget = document.getElementById('displayQr');
let renderedUrl = '';

async function loadDisplay() {
  try {
    const response = await fetch('/api/state', { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok || data.role !== 'admin') throw new Error(data.error || '只有主機可以開啟展示畫面');
    document.getElementById('displayError').hidden = true;
    document.getElementById('displayNow').textContent = data.current?.title || '準備開始';
    if (data.clientUrl && data.clientUrl !== renderedUrl) {
      renderedUrl = data.clientUrl;
      document.getElementById('displayUrl').textContent = data.clientUrl;
      qrTarget.replaceChildren();
      new QRCode(qrTarget, { text: data.clientUrl, width: 420, height: 420, correctLevel: QRCode.CorrectLevel.L });
    }
  } catch (error) {
    const message = document.getElementById('displayError');
    message.textContent = error.message;
    message.hidden = false;
  }
}

document.getElementById('fullscreenButton').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch {}
});
document.addEventListener('fullscreenchange', () => {
  document.getElementById('fullscreenButton').textContent = document.fullscreenElement ? '離開全螢幕' : '全螢幕顯示';
});

if (!token) {
  document.getElementById('displayError').textContent = '請從主機管理畫面開啟此視窗';
  document.getElementById('displayError').hidden = false;
} else {
  loadDisplay();
  setInterval(() => { if (!document.hidden) loadDisplay(); }, 5000);
}
