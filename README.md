# KTV 點歌機

一套不需要安裝額外套件的區網 KTV 點歌系統。一台電腦作為主機播放 YouTube，其他人用手機掃描 QR Code 後即可瀏覽曲庫、點歌與管理待播清單。

## 主要功能

- 主機播放 YouTube，影片結束後自動切換下一首
- 多支手機透過同一個房間即時共享歌單
- 手機端瀏覽完整曲庫與 YouTube 封面
- 搜尋歌曲、點歌、插播、刪除及切換下一首
- 同一歌名可以保存多個版本
- 找不到曾經收錄的歌曲時，自動顯示 YouTube 前五筆搜尋結果
- 可直接收錄搜尋結果並點歌，也保留手動貼上 YouTube 連結的方式
- 獨立 QR Code 展示視窗，可放在副螢幕並全螢幕顯示
- SQLite 保存歌曲、歌單與房間資料
- 內附 155 首歌曲與 YouTube 連結，首次啟動時自動載入

## 系統需求

- Windows、macOS 或 Linux
- [Node.js 22.13 或更新版本](https://nodejs.org/)
- 主機與手機連接同一個區域網路
- 可連線到 YouTube

本專案只保存 YouTube 連結，不會下載或散布影片與音訊檔案。

## 啟動方式

### Windows

雙擊 `start-ktv.cmd`。

如果出現「node 不是內部或外部命令」，請先安裝 Node.js 22.13 或更新版本，再重新開啟 `start-ktv.cmd`。

第一次把 Windows 電腦當作區網主機時，請在專案資料夾執行：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-windows-server.ps1
```

腳本會要求系統管理員權限，並建立僅適用於私人網路的 TCP 3000 入站規則。如果目前連接的是公用網路，腳本會先詢問是否將該可信任網路改為私人網路。請勿在咖啡廳、機場等公共 Wi-Fi 上進行這項變更。

### macOS

雙擊 `start-ktv.command`。

如果 macOS 第一次執行時顯示檔案沒有執行權限，請在專案資料夾開啟「終端機」並執行一次：

```bash
chmod +x start-ktv.command
```

啟動器會自動開啟瀏覽器。如果顯示找不到 Node.js 或 SQLite 不受支援，請先安裝 Node.js 22.13 或更新版本，再重新開啟 `start-ktv.command`。macOS 第一次詢問是否允許 Node.js 接收連入連線時，請選擇「允許」，手機才能連上點歌頁面。

### 終端機

```bash
npm start
```

也可以直接執行：

```bash
node server.js
```

啟動後，在主機瀏覽器開啟：

```text
http://localhost:3000
```

本機進入時會自動取得主機管理權限。管理畫面會產生供手機使用的 QR Code。

## 副螢幕顯示 QR Code

1. 在主機管理頁找到「一起來點歌」。
2. 點擊「在副螢幕開啟 QR Code」。
3. 將新視窗拖到副螢幕。
4. 點擊「全螢幕顯示」。

展示畫面也會顯示目前播放的歌名。

## 手機連線問題

手機掃描 QR Code 後若無法開啟：

1. 確認手機與電腦連接同一台路由器。
2. 關閉手機的行動網路、VPN 或私人轉送後再測試。
3. 避免使用訪客 Wi-Fi，部分路由器會隔離無線及有線裝置。
4. Windows 防火牆詢問時，允許 Node.js 使用私人網路。
5. 嘗試直接在手機瀏覽器輸入 QR Code 下方的網址。

如果自動選到錯誤的網路介面，可指定公開網址：

```powershell
$env:PUBLIC_ORIGIN='http://192.168.1.20:3000'
node server.js
```

請將範例 IP 改成主機在區域網路中的 IPv4 位址。

## 歌曲資料

預設歌曲位於 [`seed/songs.json`](seed/songs.json)。資料庫不存在或曲庫為空時，伺服器會自動匯入這份檔案。

執行期間新增的歌曲會保存在 `data/ktv.sqlite`。資料庫包含房間權杖與當前歌單，因此已被 `.gitignore` 排除，不會提交到 GitHub。

如果要用目前資料庫內容更新公開曲庫：

```bash
npm run export:songs
```

檢查 `seed/songs.json` 後再提交即可。

## 專案結構

```text
KTV/
├─ public/                 網頁、樣式與瀏覽器端程式
├─ scripts/                曲庫匯入及匯出工具
├─ seed/songs.json         首次啟動用的歌曲與 YouTube 連結
├─ data/                   本機 SQLite 資料庫，不提交內容
├─ server.js               HTTP API、SQLite 與靜態檔案伺服器
├─ setup-windows-server.ps1 Windows 主機網路與防火牆設定
├─ start-ktv.cmd           Windows 雙擊啟動器
├─ start-ktv.command       macOS 雙擊啟動器
└─ package.json
```

## 資料備份

停止伺服器後，複製 `data/ktv.sqlite` 即可完整備份曲庫與歌單。還原時將檔案放回相同位置再啟動伺服器。
