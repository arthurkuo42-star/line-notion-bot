# 泓品收發：LINE 檔案自動歸檔 設定手冊

客戶在 LINE 群組傳的圖片／影片／語音／檔案，幾秒內自動下載並永久保存到
`Dropbox\泓品法律事務所\00_LINE收發室\{群組名}\`，檔名含日期、時間、傳送者。
群組改名檔案不分家；Railway 重啟對照表不遺失（存在 Dropbox 的 `.group-map.json`）。

與原本的記帳／待辦 bot 共用同一個 Railway 部署，但走**獨立的官方帳號與獨立路由**
（`/archive/webhook`），互不干擾。環境變數沒設定前，歸檔模組不會啟動。

---

## 一、建立 LINE 官方帳號（約 10 分鐘）

1. 到 [LINE Official Account Manager](https://manager.line.biz/) → 建立新帳號
   - 帳號名稱：`泓品法律事務所`（客戶在群組裡會看到這個名字）
   - 免費方案（輕用量）即可——歸檔只「接收」訊息，不吃訊息額度
2. 建好後進該帳號的「設定 → Messaging API」→ 啟用 Messaging API
   （會連到 [LINE Developers](https://developers.line.biz/) 建立 channel）
3. 在 LINE Developers 的該 channel：
   - **Basic settings** 頁 → 記下 **Channel secret**
   - **Messaging API** 頁 → 發行 **Channel access token**（long-lived）→ 記下
   - **Messaging API** 頁 → Webhook URL 填：
     `https://<你的Railway網域>/archive/webhook`（跟現有 bot 同網域，只差路徑）
   - 開啟「**Use webhook**」
4. 回 Official Account Manager「設定 → 回應設定」：
   - 回應模式：**聊天機器人（Bot）**
   - 關閉「自動回應訊息」與「加入好友的歡迎訊息」（避免打擾客戶）
5. 「設定 → 帳號設定 → 功能切換」：**允許加入群組・多人聊天室** → 開啟

## 二、建立 Dropbox App 並取得金鑰（約 10 分鐘）

1. 到 [Dropbox App Console](https://www.dropbox.com/developers/apps) → Create app
   - **Scoped access** → **Full Dropbox**（要寫入既有的泓品資料夾，App folder 模式做不到）
   - App 名稱例：`hongpin-line-archive`
2. App 的 **Permissions** 頁：勾 `files.content.write` 和 `files.content.read` → Submit
3. 在本機 repo 目錄執行：
   ```
   node scripts/get-dropbox-refresh-token.js
   ```
   跟著提示操作（貼 App key/secret → 開授權網址按允許 → 貼授權碼），
   最後會印出三個環境變數值。

## 三、Railway 填環境變數

到 Railway dashboard → line-notion-bot service → Variables，新增：

| 變數 | 值 |
| :--- | :--- |
| `ARCHIVE_CHANNEL_SECRET` | LINE Developers 的 Channel secret |
| `ARCHIVE_CHANNEL_ACCESS_TOKEN` | LINE Developers 的 Channel access token |
| `DROPBOX_APP_KEY` | 工具印出的值 |
| `DROPBOX_APP_SECRET` | 工具印出的值 |
| `DROPBOX_REFRESH_TOKEN` | 工具印出的值 |
| `ARCHIVE_ALERT_USER_ID` | （選填）歸檔失敗時要通知的 LINE userId，可先不填 |
| `ARCHIVE_ROOT` | （選填）預設 `/泓品法律事務所/00_LINE收發室`，路徑不同才需要改 |

存檔後 Railway 會自動重新部署。部署 log 出現 `🗂 歸檔模組已啟用` 即成功。

> 注意：`ARCHIVE_ROOT` 是 **Dropbox 帳號根目錄起算**的路徑。如果你的 Dropbox 裡
> 泓品資料夾不是放在最上層，請照實際層級填（例如 `/工作/泓品法律事務所/00_LINE收發室`）。

## 四、驗收測試

1. 用手機把「泓品法律事務所」官方帳號加為好友
2. 開一個測試群組，把官方帳號拉進去 → 應收到「檔案保存服務已啟用」訊息
3. 在群組傳一張照片 + 一個 PDF
4. 到 `Dropbox\泓品法律事務所\00_LINE收發室\{測試群組名}\` 確認兩個檔案都在，
   檔名格式：`2026-07-12_1430_你的名字_圖片_xxx.jpg`
5. 把群組改名，再傳一個檔 → 確認資料夾跟著改名、舊檔案還在同一夾

## 五、日常 SOP

- **每開一個新客戶群組 → 把「泓品法律事務所」拉進群**，之後全自動
- 抓不到的東西（LINE 硬限制）：個人 LINE 對話、bot 加入前的訊息、已過期的舊檔案
- 對外分享這套系統時，截圖須先匿名化（群組名、當事人姓名）

## 六、已做的資安基本功

- Webhook 簽章驗證（`X-Line-Signature`，偽造請求直接拒絕）
- 所有金鑰只存在 Railway 環境變數，不進版本庫
- 檔名／資料夾名消毒（路徑穿越、保留字元、控制字元）
- Dropbox 用 refresh token 短效換發，不用永久 access token
- 同名檔案自動改名，不覆蓋既有檔案
