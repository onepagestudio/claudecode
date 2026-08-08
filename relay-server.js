// Permanent coexistence relay: runs this bot alongside the existing
// EasyStore LINE integration on the SAME LINE Official Account webhook,
// without disrupting EasyStore's flow.
//
// LINE only allows one Webhook URL per channel, and each event's replyToken
// can only be consumed once. EasyStore uses this channel's webhook only to
// surface incoming customer messages in its own back office (for optional
// manual staff reply) and does not auto-reply to them; order-shipped
// notifications are sent separately via the Push API and are unaffected by
// any of this. So this relay:
//   1. Verifies the LINE signature once.
//   2. Forwards the raw, unmodified webhook body to EasyStore immediately,
//      so their back-office visibility and manual-reply option keep working.
//   3. Independently asks Claude for a reply and sends it via the LINE
//      Push API (a separate message, not tied to the reply token) so it
//      never competes with EasyStore for the same reply token — this is
//      the customer-facing reply, since EasyStore doesn't send one itself.
//
// This is the intended PRODUCTION entry point for as long as this channel
// coexists with EasyStore. Deploy this file (not server.js) to Render/
// Railway. server.js remains available for a future full migration off
// EasyStore, where LINE's Webhook URL would point at server.js's /webhook
// (using the Reply API directly) instead.

require('dotenv').config();

const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const {
  verifyLineSignature,
  loadKnowledgeBase,
  buildSystemPrompt,
  getClaudeReply,
  DEFAULT_MODEL,
} = require('./server');

const FORWARD_TIMEOUT_MS = 8000;
const PUSH_TIMEOUT_MS = 10000;
const LINE_TEXT_MAX_LENGTH = 5000;
// No emoji here on purpose — the system prompt caps Claude's own reply at
// one emoji per message, and this label is prepended to that reply, so
// giving the label its own emoji too would push the combined message over
// the limit.
const DEFAULT_BOT_LABEL =
  '您好，這是 DUMO 獨茉的 AI 客服小幫手，為您優先解答常見問題；如需真人客服協助，隨時告訴我們即可。\n\n';

/**
 * Forwards the exact raw webhook body to EasyStore's LINE webhook endpoint,
 * unchanged, so EasyStore's own signature verification and flow keep
 * working as if this relay didn't exist. Never throws.
 */
async function forwardToEasyStore({
  easyStoreWebhookUrl,
  rawBody,
  signature,
  timeoutMs = FORWARD_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  if (!easyStoreWebhookUrl) {
    console.error('[Relay] EASYSTORE_WEBHOOK_URL is not set; skipping forward');
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(easyStoreWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      console.error(`[Relay] EasyStore forward failed: status=${res.status} body=${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Relay] EasyStore forward error', err?.name === 'AbortError' ? 'timed out' : err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends a reply via LINE's Push API (independent of any reply token, unlike
 * the Reply API) so it never collides with EasyStore's use of the same
 * event's reply token. Never throws.
 */
async function pushToLine({
  channelAccessToken,
  userId,
  text,
  timeoutMs = PUSH_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: String(text).slice(0, LINE_TEXT_MAX_LENGTH) }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      console.error(`[Relay] LINE push failed: status=${res.status} body=${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[Relay] LINE push error', err?.name === 'AbortError' ? 'timed out' : err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function handleEventViaPush(event, ctx) {
  try {
    if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') {
      return;
    }
    const userId = event.source && event.source.userId;
    if (!userId) return; // group/room events without a resolvable user are skipped by this relay

    const replyText = await getClaudeReply({
      anthropicClient: ctx.anthropicClient,
      userText: event.message.text,
      systemPrompt: ctx.systemPrompt,
      model: ctx.model,
    });

    await ctx.pushImpl({
      channelAccessToken: ctx.lineChannelAccessToken,
      userId,
      text: ctx.botLabel + replyText,
      fetchImpl: ctx.fetchImpl,
    });
  } catch (err) {
    console.error('[Relay] handleEventViaPush unexpected error', err);
  }
}

function createRelayApp({
  anthropicClient,
  lineChannelAccessToken,
  lineChannelSecret,
  easyStoreWebhookUrl,
  systemPrompt,
  model = DEFAULT_MODEL,
  botLabel = DEFAULT_BOT_LABEL,
  fetchImpl = fetch,
  forwardImpl = forwardToEasyStore,
  pushImpl = pushToLine,
}) {
  const app = express();

  app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'line-bot-relay', time: new Date().toISOString() });
  });

  app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    try {
      const signature = req.get('x-line-signature');
      const rawBody = req.body;

      if (!verifyLineSignature(rawBody, signature, lineChannelSecret)) {
        console.warn('[Relay] Invalid or missing x-line-signature');
        return res.status(401).send('Invalid signature');
      }

      // Forward to EasyStore first and independently of our own bot logic —
      // this must keep working even if our Claude call or push fails.
      const forwardPromise = forwardImpl({ easyStoreWebhookUrl, rawBody, signature, fetchImpl });

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf-8'));
      } catch (err) {
        console.error('[Relay] Failed to parse JSON body', err);
        await forwardPromise;
        return res.status(400).send('Invalid JSON body');
      }

      const events = Array.isArray(payload.events) ? payload.events : [];

      await Promise.allSettled([
        forwardPromise,
        ...events.map((event) =>
          handleEventViaPush(event, {
            anthropicClient,
            lineChannelAccessToken,
            systemPrompt,
            model,
            botLabel,
            fetchImpl,
            pushImpl,
          })
        ),
      ]);

      res.status(200).send('OK');
    } catch (err) {
      console.error('[Relay] Unexpected error handling request', err);
      if (!res.headersSent) res.status(200).send('OK');
    }
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[Relay] Express error handler', err);
    if (!res.headersSent) res.status(200).send('OK');
  });

  return app;
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const REQUIRED_ENV = [
    'LINE_CHANNEL_ACCESS_TOKEN',
    'LINE_CHANNEL_SECRET',
    'ANTHROPIC_API_KEY',
    'EASYSTORE_WEBHOOK_URL',
  ];
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.warn(`[Relay Startup] Missing environment variables: ${missing.join(', ')}.`);
  }

  const knowledgeBaseText = loadKnowledgeBase();
  const systemPrompt = buildSystemPrompt(knowledgeBaseText);
  const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;

  const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const app = createRelayApp({
    anthropicClient,
    lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    lineChannelSecret: process.env.LINE_CHANNEL_SECRET,
    easyStoreWebhookUrl: process.env.EASYSTORE_WEBHOOK_URL,
    systemPrompt,
    model,
  });

  app.listen(PORT, () => {
    console.log(
      `[Relay Startup] Coexistence relay listening on port ${PORT} (model: ${model}) — forwarding to EasyStore + pushing test replies`
    );
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Relay unhandledRejection]', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[Relay uncaughtException]', err);
  });
}

module.exports = {
  createRelayApp,
  forwardToEasyStore,
  pushToLine,
  handleEventViaPush,
  DEFAULT_BOT_LABEL,
};
