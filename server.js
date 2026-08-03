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
  return `你是一個 LINE 官方帳號的客服助理，代表本公司回覆顧客的訊息。

# 回覆原則
1. 優先且僅根據下方「客服知識庫」的內容回答問題，不要編造知識庫中沒有的資訊（例如價格、規格、優惠活動、營業時間等）。
2. 如果顧客的問題在知識庫中找不到明確答案，請誠實告知顧客「這個問題目前無法直接為您確認」，並說明將由真人客服人員盡快跟進處理，絕對不要用猜測或編造的內容回答。
3. 語氣親切、簡潔、有禮貌，直接回答重點，避免不必要的長篇說明。
4. 除非顧客直接詢問，否則不要主動說明自己是 AI 或透露使用的技術細節。
5. 若訊息包含緊急客訴、投訴或明顯需要人工處理的複雜狀況，也請告知會轉由真人客服協助處理。

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
      system: systemPrompt,
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
