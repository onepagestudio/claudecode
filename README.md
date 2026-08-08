# LINE 官方帳號自動回覆機器人（DUMO／獨墨）

Node.js + Express 建置的 LINE Messaging API 整合，收到顧客訊息後會呼叫 Anthropic Claude API
（優先參考 `knowledge-base.md` 客服知識庫）產生回覆。

**這個帳號目前與 EasyStore 共存**：LINE 官方帳號的 Webhook 目前指向 `relay-server.js`，它會把原始
webhook 內容轉發給 EasyStore（維持後台可見度、之後可人工介入），並另外用 LINE Push API 送出
DUMO AI 客服的回覆給顧客（因為 EasyStore 本身不會自動回覆訊息，只有出貨時才會推播通知）。

## 專案結構

```
line-bot/
├── server.js             # 核心邏輯 + 獨立版 webhook（簽章驗證、呼叫 Claude、LINE Reply API）
├── relay-server.js       # 【正式環境使用】共存版 webhook：轉發給 EasyStore + 用 Push API 回覆顧客
├── knowledge-base.md     # 客服知識庫（DUMO 品牌資料、FAQ、售後判斷等），機器人只會依此回答
├── package.json
├── .env.example          # 環境變數範本
├── .env                  # 實際環境變數（不會被 git 追蹤）
├── test/webhook.test.js  # server.js 的自動化測試（Claude API 為 mock）
├── test/relay.test.js    # relay-server.js 的自動化測試（Claude API／EasyStore／LINE Push 皆為 mock）
├── render.yaml           # Render 部署設定（預設啟動 relay-server.js）
└── Procfile              # Railway 部署設定（預設啟動 relay-server.js）
```

### `server.js` vs `relay-server.js`，該用哪一個？

| | `server.js` | `relay-server.js` |
| --- | --- | --- |
| 使用時機 | 之後**完全migrate 離開 EasyStore**、LINE 帳號只給這支機器人用時 | **目前**：LINE 帳號同時要跟 EasyStore 共存時（正式環境預設） |
| 回覆方式 | LINE Reply API（用一次性的 replyToken） | LINE Push API（獨立訊息，不會跟 EasyStore 搶 replyToken） |
| 是否轉發給 EasyStore | 否 | 是，原始 webhook 內容原封不動轉發 |
| 啟動指令 | `npm start` / `npm run dev` | `npm run relay` / `npm run dev:relay` |

**目前 Render/Railway 的部署設定（`render.yaml`、`Procfile`）都預設啟動 `relay-server.js`**，因為
目前是共存架構。

## 1. 安裝與本機啟動

```bash
npm install
npm run dev         # server.js 開發模式（獨立版，用 Reply API）
npm run dev:relay   # relay-server.js 開發模式（共存版，用 Push API，目前正式環境用這個）
```

啟動後可用瀏覽器或 curl 檢查健康狀態：

```bash
curl http://localhost:3000/
# server.js:       {"status":"ok","service":"line-bot","time":"..."}
# relay-server.js: {"status":"ok","service":"line-bot-relay","time":"..."}
```

## 2. 填入金鑰（`.env`）

`.env` 已從 `.env.example` 複製好，請手動編輯並填入：

| 變數 | 從哪裡取得 | 必填？ |
| --- | --- | --- |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Console → 你的 Messaging API 頻道 → Messaging API 分頁 → 發行 Channel access token（建議用長期發行的 token） | 必填 |
| `LINE_CHANNEL_SECRET` | LINE Developers Console → 你的頻道 → Basic settings 分頁 → Channel secret | 必填 |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com → API Keys | 必填 |
| `EASYSTORE_WEBHOOK_URL` | 你現有 EasyStore LINE 整合設定裡的 webhook 網址（含 `channel_id`、`store_token`） | 只有用 `relay-server.js`（共存版）才需要 |

選填：

- `CLAUDE_MODEL`（預設 `claude-haiku-4-5`，費用較低；想換更高品質可改 `claude-opus-5`，費用約為 5 倍）
- `PORT`（預設 `3000`）

## 3. 本機測試（不需要正式 LINE 帳號）

專案內建自動化測試，Claude API、EasyStore 轉發、LINE Reply／Push 全部用 mock 模擬，不會打正式 API：

```bash
npm test
```

測試涵蓋（`test/webhook.test.js` + `test/relay.test.js`）：
- 簽章驗證正確／錯誤／被竄改時的行為
- 收到文字訊息 → 呼叫 Claude → 回覆顧客的完整流程（Reply API 版與 Push API 版都有）
- Claude API 出錯時，webhook 仍回 200，並改傳送預設的安全回覆訊息
- LINE API 出錯時，伺服器不會當掉、也不會拋出例外
- 非文字訊息（貼圖、加好友事件等）會被忽略，不會誤觸發
- relay 版：轉發給 EasyStore 與推送給顧客兩件事互相獨立，一邊失敗不影響另一邊

## 4. 用 ngrok 做本地端對端測試

已透過 winget 安裝好 ngrok（`winget install ngrok.ngrok`），並設定好 authtoken。

```bash
npm run dev:relay          # 先啟動本機的 relay-server.js
ngrok http 3000            # 另開一個終端機執行
```

會得到類似 `https://xxxx-xxxx.ngrok-free.app` 的網址，webhook URL 就是
`https://xxxx-xxxx.ngrok-free.app/webhook`。

> ⚠️ **這是正式帳號**：把 LINE 的 Webhook URL 改成 ngrok 網址測試時，這台電腦／ngrok 通道就是
> EasyStore 收得到訊息的唯一途徑——關掉 ngrok 或這台電腦睡眠，EasyStore 也會跟著收不到訊息。
> 測完記得換回正式部署後的網址（見第 6 節），不要長期停在 ngrok 網址上。

## 5. 到 LINE Developers Console 設定 Webhook

1. 登入 https://developers.line.biz/console/
2. 選擇你的 Provider → 選擇你的 Messaging API Channel
3. 進入 **Messaging API** 分頁：
   - **Webhook URL**：貼上 relay 的網址 + `/webhook`（本機測試用 ngrok 網址；正式環境用第 6 節部署後的網址）
   - 點擊 **Verify**，應顯示 Success
   - 開啟 **Use webhook**
4. 用手機 LINE App 傳一則文字訊息測試，應該會收到一則以「您好🤍 這是 DUMO 獨墨的 AI 客服小幫手...」開頭的回覆

## 6. 部署到 Render 或 Railway

專案已推上 GitHub：`https://github.com/onepagestudio/claudecode`

### Render

1. https://dashboard.render.com → **New** → **Web Service** → 選擇你的 GitHub repo
2. Render 會偵測到 `render.yaml`（已設定 Start Command 為 `npm run relay`，也就是共存版）
3. 在 **Environment** 頁籤新增以下環境變數：

   | Key | Value |
   | --- | --- |
   | `LINE_CHANNEL_ACCESS_TOKEN` | 你的 token |
   | `LINE_CHANNEL_SECRET` | 你的 secret |
   | `ANTHROPIC_API_KEY` | 你的 API key |
   | `EASYSTORE_WEBHOOK_URL` | 你的 EasyStore LINE webhook 網址 |
   | `CLAUDE_MODEL` | `claude-haiku-4-5`（可選，省成本） |

4. 部署完成後會得到 `https://<服務名稱>.onrender.com`，webhook URL 即為
   `https://<服務名稱>.onrender.com/webhook`

### Railway

1. https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Railway 會自動偵測 `Procfile`（已設定為 `web: node relay-server.js`）
3. 在 **Variables** 頁籤新增同樣五個環境變數（見上表）
4. Railway 會提供 `https://<專案名稱>.up.railway.app`，webhook URL 即為
   `https://<專案名稱>.up.railway.app/webhook`

兩個平台都會自動注入 `PORT` 環境變數，程式已相容（`process.env.PORT || 3000`）。

> 部署完成、Webhook 指向正式網址並 Verify 成功後，本機的 ngrok／relay 就可以關掉了——正式環境
> 24 小時運作，不再依賴這台電腦。

## 7. 客服知識庫與語氣調整

- **知識庫內容**（品牌資料、尺寸、1:1 流程、定價規則、FAQ 等）：編輯 `knowledge-base.md`，Markdown 格式即可，不需要改程式碼。內容依 A／B／C／D 分級——只有 A 會被機器人當作確定答案直接回覆，B/C/D 都會轉人工或僅供背景理解，詳見檔案開頭的說明。
- **回覆語氣、硬性規則**：編輯 `server.js` 裡的 `buildSystemPrompt()` 函式。
- **回覆前的品牌提示語**（目前是「您好🤍 這是 DUMO 獨墨的 AI 客服小幫手...」）：編輯 `relay-server.js` 裡的 `DEFAULT_BOT_LABEL` 常數。
- 機器人只會根據知識庫的 A 級內容回答；沒有把握的問題會誠實告知顧客並轉真人客服跟進，不會編造答案。
- 修改後：本機開發模式用 nodemon 會自動重啟；正式環境（Render/Railway）需要重新部署（`git push`）才會生效。

## 8. 運作原理摘要（共存版 `relay-server.js`）

1. LINE 將使用者訊息以 POST 送到 `/webhook`
2. 用 `LINE_CHANNEL_SECRET` 驗證 `x-line-signature` 標頭（HMAC-SHA256 + timing-safe 比對）
3. 把原始、未修改的 webhook 內容轉發給 `EASYSTORE_WEBHOOK_URL`（讓 EasyStore 後台照常看得到訊息）
4. 同時逐一處理 `events`（用 `Promise.allSettled`，轉發、Claude 呼叫、推播三者互不影響）
5. 對文字訊息呼叫 Claude API（`model` 預設 `claude-haiku-4-5`，system prompt 已用 prompt caching 降低成本），system prompt 包含 DUMO 品牌硬性規則與知識庫內容
6. 用 LINE **Push API**（不是 Reply API）把回覆送給顧客，避免跟 EasyStore 搶同一個 replyToken
7. 任何一步出錯都會被攔截並記錄 log，不會讓伺服器當掉；webhook 一律回應 200 給 LINE 避免觸發重試風暴

## 9. 之後若要完全脫離 EasyStore

如果之後決定不再用 EasyStore 處理這個 LINE 帳號，改成完全由這支機器人負責：

1. 把 Render/Railway 的啟動指令從 `npm run relay` 改成 `npm start`（改用 `server.js`，Reply API 版）
2. 不再需要 `EASYSTORE_WEBHOOK_URL`
3. 其餘（知識庫、system prompt、金鑰）都不用動
