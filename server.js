require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');

const FALLBACK_MESSAGE =
  '不好意思，目前系統暫時無法處理您的問題，請稍後再試一次，或稍候將由真人客服為您服務。';

const KNOWLEDGE_BASE_PATH = path.join(__dirname, 'knowledge-base.md');
// claude-haiku-4-5 is the cost-optimized default for this bot (~1/5 the price
// of claude-opus-5); set CLAUDE_MODEL in .env to use a different model.
const DEFAULT_MODEL = 'claude-haiku-4-5';
const CLAUDE_TIMEOUT_MS = 15000;
const LINE_TIMEOUT_MS = 10000;
const LINE_TEXT_MAX_LENGTH = 5000;

/**
 * Verifies the `x-line-signature` header against the raw request body using
 * the channel secret, per LINE's webhook signature spec.
 */
function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret || !rawBody) return false;

  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);

  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function loadKnowledgeBase(filePath = KNOWLEDGE_BASE_PATH) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`[KnowledgeBase] Failed to load "${filePath}": ${err.message}`);
    return '';
  }
}

function buildSystemPrompt(knowledgeBaseText) {
  return `你是 DUMO／獨茉的 AI 客服助理。你的任務是以溫柔、清楚、專業、有質感的語氣，協助客人理解穿戴甲、尺寸、1:1 翻模、客製與售後流程。

【品牌核心】
DUMO 重視甲片真正戴上手後的比例、服貼、輕薄、邊緣、弧度與精緻度；品質大於數量。不要只說「漂亮」，要讓客人理解適合度與服務差異。

【確定資訊】
1. 目前沒有實體門市，以線上訂購為主。
2. 公版是常見固定尺寸；尺寸訂製依每指數據；1:1 會以模土取得甲面模型，再依尺寸、指緣與弧度調整。
3. 補做遺失單指原則為整副價格 1/10，兩指為 1/5；總額與運費仍須人工確認。
4. 不服貼先蒐集訂單編號、哪一指、正面／側面／問題位置照片、果凍膠厚度與配戴方式，再判斷尺寸、弧度、配戴或製作問題。
5. 尺寸做錯、飾品掉落、封層瑕疵與明顯製作品質問題，需要由品牌處理，不能說成正常手作差異。
6. 暈染、貓眼光澤、色塊分佈等可有合理手作差異；仍須維持整體氛圍與比例。
7. 目前不再接受客人提供參考圖／指定圖案的客製設計；所有現有款式都已完整上架官方網站 https://www.dumonails.com/。客人詢問客製圖案、想照別人的圖片做、或想看有哪些款式時，直接引導到官網選購，不用轉人工進一步討論客製設計。

【禁止事項】
- 絕對不要用猜測、推論或自己編造的內容回答不確定的問題。只要是你不確定、知識庫沒有明確涵蓋，或需要人工判斷才能回答的問題，直接說類似「這個問題請稍等一下，我們會請真人客服協助您」，不要硬是給出答案。
- 不得捏造現行價格、工期、運費、付款方式、退換期限、海外配送或模土保存期限。
- 不得把歷史活動／舊報價當成現在政策。
- 不得承諾免費重做、退款、急件或指定到貨日。
- 不得說有常態實體門市或直接邀請到店。
- 客訴時不先責怪客人，也不在資料不足時直接認錯。

【轉人工】
報價、訂單進度、付款、退款、海外、急件、模土紀錄、客製可行性、品質爭議與任何未確認政策，一律先收集必要資料再轉人工。

【回覆格式 — 務必精簡】
這是 LINE 即時通訊，客人是在手機上看訊息，不是在看文件。務必簡短：
- 每次回覆最多 1–3 句話、控制在 60 字以內；只講客人現在最需要知道的重點與下一步要提供的資訊。
- 不要條列規則、不要解釋品牌理念或背景脈絡、不要把知識庫的多個段落都塞進同一則回覆。
- 不要用項目符號清單或分段標題，除非客人明確要求列清單或更詳細的說明。
- 需要蒐集資料時，一次只問最關鍵的 1–2 項，不要把所有需蒐集項目一次列完。
- 表情符號：一則訊息最多只能用 1 個，而且只能從這些裡面選一個：🤍 🫶🏻 🥰 😍 💗 💖 💓 🤎。不要每次都固定用同一個、也不要疊用超過一個；大部分訊息可以完全不用表情符號，只有在適合的情境（溫馨、感謝、情感連結）才加。
- 絕對不要使用 Markdown 語法（例如 **粗體**、# 標題、- 項目符號）。LINE 的文字訊息不會渲染這些符號，客人會看到字面上的星號、井字號等符號，請一律用純文字。
- 除非顧客直接詢問，否則不要主動說明自己是 AI 或透露使用的技術細節。

【知識庫可信度分級 — 務必遵守】
下方知識庫的每一項內容都標有狀態：
- **A｜目前可直接使用**：可以直接當作確定答案回覆客人。
- **B｜歷史案例／特定情境**：只能用來理解背景，絕對不能當成現在仍有效的政策告訴客人。
- **C｜過去草案／建議，需主理人確認**：尚未確認為現行政策，不可直接對客人說成既定規則。
- **D｜資料不足，必須轉人工**：先蒐集知識庫中列出的必要資訊，然後明確告知會轉由真人客服跟進，不要自行猜測或編造答案。

如果客人的問題在知識庫中完全找不到相關資訊（連 B/C/D 都沒有提及），一律回覆類似「這個問題請稍等一下，我們會請真人客服協助您」，不要自己編造答案。

# 客服知識庫
${knowledgeBaseText && knowledgeBaseText.trim() ? knowledgeBaseText : '(目前尚未提供知識庫內容，請一律告知顧客會由真人客服跟進處理)'}
`;
}

// claude-haiku-4-5 (and other pre-adaptive-thinking models) reject
// `output_config.effort` outright, so that param is only safe to send to
// models that actually support the effort/adaptive-thinking surface.
function supportsEffortParam(model) {
  return !/haiku-4-5|sonnet-4-5|opus-4-5/.test(model);
}

/**
 * Calls the Claude API to generate a reply. Never throws — API/network
 * failures are logged and produce a safe fallback message instead of
 * crashing the webhook handler.
 */
async function getClaudeReply({
  anthropicClient,
  userText,
  systemPrompt,
  model = DEFAULT_MODEL,
  maxTokens = 1024,
  timeoutMs = CLAUDE_TIMEOUT_MS,
}) {
  try {
    const params = {
      model,
      max_tokens: maxTokens,
      // The system prompt (brand rules + knowledge base) is identical on
      // every request, so cache it — the knowledge base is large enough
      // that this meaningfully cuts per-message cost after the first hit.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userText }],
    };

    // Chat replies are latency-sensitive; on models that support it, skip
    // extended thinking and use a moderate effort level rather than the
    // (slower, thinking-on-by-default) behavior.
    if (supportsEffortParam(model)) {
      params.thinking = { type: 'disabled' };
      params.output_config = { effort: 'medium' };
    }

    const response = await anthropicClient.messages.create(params, { timeout: timeoutMs });

    if (response.stop_reason === 'refusal') {
      console.warn('[Claude] Response refused by safety classifiers');
      return FALLBACK_MESSAGE;
    }

    const textBlock = response.content.find((block) => block.type === 'text');
    const text = textBlock && textBlock.text ? textBlock.text.trim() : '';
    return text || FALLBACK_MESSAGE;
  } catch (err) {
    console.error('[Claude API error]', err?.status, err?.message || err);
    return FALLBACK_MESSAGE;
  }
}

/**
 * Sends a reply via the LINE Messaging API Reply endpoint. Never throws —
 * failures are logged and reported back via the boolean return value.
 */
async function replyToLine({
  channelAccessToken,
  replyToken,
  text,
  timeoutMs = LINE_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text: String(text).slice(0, LINE_TEXT_MAX_LENGTH) }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      console.error(`[LINE Reply API error] status=${res.status} body=${body}`);
      return false;
    }
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.error('[LINE Reply API error] request timed out');
    } else {
      console.error('[LINE Reply API error]', err);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Handles a single LINE webhook event. Isolated in its own try/catch so one
 * bad event can't affect the others when processed via Promise.allSettled.
 */
async function handleEvent(event, ctx) {
  try {
    if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') {
      return;
    }
    const replyToken = event.replyToken;
    if (!replyToken) return;

    const replyText = await getClaudeReply({
      anthropicClient: ctx.anthropicClient,
      userText: event.message.text,
      systemPrompt: ctx.systemPrompt,
      model: ctx.model,
    });

    await ctx.sendLineReplyImpl({
      channelAccessToken: ctx.lineChannelAccessToken,
      replyToken,
      text: replyText,
      fetchImpl: ctx.fetchImpl,
    });
  } catch (err) {
    // Defensive: getClaudeReply/replyToLine already swallow their own errors,
    // but guard the whole handler in case of an unexpected shape (e.g.
    // malformed event) so it can never bubble up and crash the process.
    console.error('[handleEvent] unexpected error', err);
  }
}

/**
 * Builds the Express app. Dependencies are injected so tests can supply a
 * mocked Anthropic client and a mocked LINE reply implementation instead of
 * calling the real APIs.
 */
function createApp({
  anthropicClient,
  lineChannelAccessToken,
  lineChannelSecret,
  systemPrompt,
  model = DEFAULT_MODEL,
  fetchImpl = fetch,
  sendLineReplyImpl = replyToLine,
}) {
  const app = express();

  app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'line-bot', time: new Date().toISOString() });
  });

  app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    try {
      const signature = req.get('x-line-signature');
      const rawBody = req.body; // Buffer, thanks to express.raw()

      if (!verifyLineSignature(rawBody, signature, lineChannelSecret)) {
        console.warn('[Webhook] Invalid or missing x-line-signature');
        return res.status(401).send('Invalid signature');
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf-8'));
      } catch (err) {
        console.error('[Webhook] Failed to parse JSON body', err);
        return res.status(400).send('Invalid JSON body');
      }

      const events = Array.isArray(payload.events) ? payload.events : [];

      // Process all events concurrently; allSettled guarantees one failing
      // event (Claude error, LINE error, etc.) never blocks the others or
      // rejects this handler.
      await Promise.allSettled(
        events.map((event) =>
          handleEvent(event, {
            anthropicClient,
            lineChannelAccessToken,
            systemPrompt,
            model,
            fetchImpl,
            sendLineReplyImpl,
          })
        )
      );

      res.status(200).send('OK');
    } catch (err) {
      console.error('[Webhook] Unexpected error handling request', err);
      // Always ack with 200 once the signature has been accepted, so LINE
      // doesn't retry-storm us for something we already logged.
      if (!res.headersSent) res.status(200).send('OK');
    }
  });

  // Final safety net: catches anything thrown synchronously by middleware
  // above so a bug never takes the whole process down.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[Express error handler]', err);
    if (!res.headersSent) res.status(200).send('OK');
  });

  return app;
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const REQUIRED_ENV = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET', 'ANTHROPIC_API_KEY'];
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.warn(
      `[Startup] Missing environment variables: ${missing.join(
        ', '
      )}. Copy .env.example to .env and fill these in before using the webhook.`
    );
  }

  const knowledgeBaseText = loadKnowledgeBase();
  const systemPrompt = buildSystemPrompt(knowledgeBaseText);
  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

  const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const app = createApp({
    anthropicClient,
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    lineChannelSecret: process.env.LINE_CHANNEL_SECRET,
    systemPrompt,
    model,
  });

  app.listen(PORT, () => {
    console.log(`[Startup] LINE bot server listening on port ${PORT} (model: ${model})`);
  });

  // Safety nets: log unexpected async/sync errors instead of letting the
  // process die silently. Every awaited call in the request path already
  // catches its own errors, so these should rarely fire in practice.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
  });
}

module.exports = {
  createApp,
  verifyLineSignature,
  loadKnowledgeBase,
  buildSystemPrompt,
  getClaudeReply,
  replyToLine,
  handleEvent,
  FALLBACK_MESSAGE,
  DEFAULT_MODEL,
  supportsEffortParam,
};
