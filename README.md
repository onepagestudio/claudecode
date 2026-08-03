# LINE 官方帳號自動回覆機器人

Node.js + Express 建置的 LINE Messaging API webhook，收到顧客訊息後會呼叫 Anthropic Claude API
（優先參考 `knowledge-base.md` 客服知識庫）產生回覆，再透過 LINE Reply API 回傳給顧客。

## 專案結構

```
line-bot/
├── server.js            # Express app：webhook、簽章驗證、呼叫 Claude、呼叫 LINE Reply API
├── knowledge-base.md     # 客服知識庫（FAQ、產品資訊、營業時間...），機器人只會依此回答
├── package.json
├── .env.example          # 環境變數範本
├── .env                  # 實際環境變數（不會被 git 追蹤）
├── test/webhook.test.js  # 自動化測試（Claude API 為 mock，不會打正式 API）
├── render.yaml           # Render 部署設定
└── Procfile              # Railway / 其他平台部署用（web: node server.js）
```

## 1. 安裝與本機啟動

```bash
npm install
npm run dev     # 開發模式（nodemon 自動重啟）
# 或
npm start       # 正式模式
```

啟動後可用瀏覽器或 curl 檢查健康狀態：

```bash
curl http://localhost:3000/
# {"status":"ok","service":"line-bot","time":"..."}
```

## 2. 填入金鑰（`.env`）

`.env` 已從 `.env.example` 複製好，請手動編輯並填入以下 **三組必要金鑰**：

| 變數 | 從哪裡取得 |
| --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Console → 你的 Messaging API 頻道 → Messaging API 分頁 → 發行 Channel access token（建議用長期發行的 token） |
| `LINE_CHANNEL_SECRET` | LINE Developers Console → 你的頻道 → Basic settings 分頁 → Channel secret |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com → API Keys |

選填：

- `CLAUDE_MODEL`（預設 `claude-haiku-4-5`，費用較低；想換更高品質可改 `claude-opus-5`，費用約為 5 倍）
- `PORT`（預設 `3000`）

## 3. 本機測試（不需要正式 LINE 帳號）

專案內建自動化測試，會用假的（mock）Claude client 和假的 LINE reply 函式模擬整個流程：

```bash
npm test
```

測試涵蓋：
- 簽章驗證正確／錯誤／被竄改時的行為
- 收到文字訊息 → 呼叫 Claude → 呼叫 LINE Reply API 的完整流程
- Claude API 出錯時，webhook 仍回 200，並改傳送預設的安全回覆訊息
- LINE Reply API 出錯時，伺服器不會當掉、也不會拋出例外
- 非文字訊息（貼圖、加好友事件等）會被忽略，不會誤觸發

## 4. 用 ngrok 做本地端對端測試

**檢查結果：這台機器目前沒有安裝 ngrok。** 安裝方式擇一：

### 方式一：winget（Windows 10/11 內建，推薦）

```powershell
winget install ngrok.ngrok
```

### 方式二：手動下載

1. 前往 https://ngrok.com/download 下載 Windows 版
2. 解壓縮 `ngrok.exe` 到任一資料夾，並將該資料夾加入 PATH（或直接在該資料夾內執行）
3. 前往 https://dashboard.ngrok.com/get-started/your-authtoken 取得你的 authtoken
4. 設定 authtoken：`ngrok config add-authtoken <你的token>`

### 啟動通道

先啟動本機伺服器（`npm run dev`），另開一個終端機執行：

```bash
ngrok http 3000
```

會得到類似這樣的網址：`https://xxxx-xxxx.ngrok-free.app`。
你的 webhook URL 就是：`https://xxxx-xxxx.ngrok-free.app/webhook`

> ngrok 免費版每次重啟網址會變動，正式上線前建議改用第 6 節的雲端部署。

## 5. 到 LINE Developers Console 設定 Webhook

1. 登入 https://developers.line.biz/console/
2. 選擇你的 Provider → 選擇你的 Messaging API Channel
3. 進入 **Messaging API** 分頁：
   - **Webhook URL**：貼上 `https://<你的網域>/webhook`（本機測試用 ngrok 網址；正式環境用第 6 節部署後的網址）
   - 點擊 **Verify**，應顯示 Success（此時 `.env` 裡的三組金鑰都要已經正確設定，且伺服器要在執行中）
   - 開啟 **Use webhook**
4. 關閉 **Auto-reply messages**（自動回覆訊息）與 **Greeting messages**（可選），避免與本機器人衝突
5. 用手機 LINE App 掃描該頻道的 QR Code 加入好友，傳送一則文字訊息測試

## 6. 部署到 Render 或 Railway

### 先把專案推上 GitHub

```bash
cd line-bot
git init
git add .
git commit -m "Initial commit: LINE bot with Claude integration"
# 到 GitHub 建立一個新的空 repository 後：
git remote add origin https://github.com/<你的帳號>/<repo名稱>.git
git branch -M main
git push -u origin main
```

`.env` 已被 `.gitignore` 排除，不會被推上去，金鑰只會在部署平台後台設定。

### Render

1. https://dashboard.render.com → **New** → **Web Service** → 選擇你的 GitHub repo
2. Render 會偵測到 `render.yaml`，或手動設定：
   - Build Command：`npm install`
   - Start Command：`npm start`
3. 在 **Environment** 頁籤新增以下環境變數：

   | Key | Value |
   | --- | --- |
   | `LINE_CHANNEL_ACCESS_TOKEN` | 你的 token |
   | `LINE_CHANNEL_SECRET` | 你的 secret |
   | `ANTHROPIC_API_KEY` | 你的 API key |
   | `CLAUDE_MODEL` | `claude-haiku-4-5`（可選，省成本；不填則使用程式內建預設值） |

4. 部署完成後會得到一個 `https://<服務名稱>.onrender.com` 網址，webhook URL 即為
   `https://<服務名稱>.onrender.com/webhook`

### Railway

1. https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Railway 會自動偵測 `package.json` 並使用 `Procfile`（`web: node server.js`）
3. 在 **Variables** 頁籤新增同樣四個環境變數（見上表）
4. Railway 會提供一個 `https://<專案名稱>.up.railway.app` 網址，webhook URL 即為
   `https://<專案名稱>.up.railway.app/webhook`

兩個平台都會自動注入 `PORT` 環境變數，程式已相容（`process.env.PORT || 3000`）。

## 7. 客服知識庫與語氣調整

- **知識庫內容**（FAQ、產品資訊、營業時間、聯絡方式）：編輯 `knowledge-base.md`，純文字 / Markdown 格式即可，不需要改程式碼。
- **回覆語氣、原則**（例如更活潑、更正式、要不要簽名檔）：編輯 `server.js` 裡的 `buildSystemPrompt()` 函式。
- 機器人只會根據 `knowledge-base.md` 的內容回答；知識庫沒有的資訊會誠實告知顧客並提示會有真人客服跟進，不會編造答案。
- 修改後：本機開發模式（`npm run dev`）用 nodemon 會自動重啟；正式環境（Render/Railway）需要重新部署（例如 `git push`）才會生效。

## 8. 運作原理摘要

1. LINE 將使用者訊息以 POST 送到 `/webhook`
2. 用 `LINE_CHANNEL_SECRET` 驗證 `x-line-signature` 標頭（HMAC-SHA256 + timing-safe 比對）
3. 逐一處理 `events`（用 `Promise.allSettled`，單一事件失敗不影響其他事件）
4. 呼叫 Claude API（`model` 預設 `claude-haiku-4-5`，15 秒逾時），system prompt 包含知識庫內容與回覆原則
5. 呼叫 LINE Reply API 送出回覆（10 秒逾時）
6. 任何一步出錯都會被攔截並記錄 log，不會讓伺服器當掉；webhook 一律回應 200 給 LINE 避免觸發重試風暴
