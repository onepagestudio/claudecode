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
//
// A password-protected /admin panel (HTTP Basic Auth via ADMIN_SECRET) lets
// the shop owner pause the bot's own push replies while they're personally
// handling a conversation, since LINE has no "a human already replied"
// webhook event to detect that automatically. EasyStore forwarding keeps
// running even while paused.
//
// Separately, a customer's own message CAN be inspected — if it contains a
// keyword like "客服" (asking for customer service), the bot auto-mutes itself for
// just that customer for an hour and sends one fixed handoff line instead
// of a Claude-generated reply. See HUMAN_REQUEST_KEYWORDS below to edit.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
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
// This label already spends the message's one allowed emoji (see the
// system prompt's emoji rule), so Claude's own reply that follows should
// not add another one on top of it.
const DEFAULT_BOT_LABEL = '此為自動回覆，如需真人客服協助，請傳送「客服」\n\n';

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
/**
 * Sends one or more LINE message objects via the Push API. Accepts either
 * `messages` (an array of raw LINE message objects — text, image, etc., max
 * 5) or the older `text` shorthand (wrapped into a single text message) for
 * backward compatibility.
 */
async function pushToLine({
  channelAccessToken,
  userId,
  text,
  messages,
  timeoutMs = PUSH_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const resolvedMessages =
    messages || [{ type: 'text', text: String(text).slice(0, LINE_TEXT_MAX_LENGTH) }];

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
        messages: resolvedMessages,
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

/**
 * Tracks a single global "human is handling replies right now" switch.
 * In-memory only (resets on redeploy/restart) — deliberately simple since
 * this is a one-person-shop manual override, not a durable setting.
 */
function createMuteState() {
  let mutedUntil = 0;
  return {
    isMuted: () => Date.now() < mutedUntil,
    muteFor: (ms) => {
      mutedUntil = Date.now() + ms;
      return mutedUntil;
    },
    resume: () => {
      mutedUntil = 0;
    },
    getMutedUntil: () => mutedUntil,
  };
}

function renderAdminPage(muteState, quickLinks) {
  const muted = muteState.isMuted();
  const mutedUntilText = muted
    ? new Date(muteState.getMutedUntil()).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' })
    : '';
  const statusText = muted
    ? `目前暫停中，將於 ${mutedUntilText}（台灣時間）自動恢復`
    : '目前正常自動回覆中';

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DUMO 客服機器人控制台</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", sans-serif; max-width: 480px; margin: 40px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 20px; }
  .status { padding: 16px; border-radius: 8px; margin: 16px 0; font-weight: 600; }
  .status.on { background: #e6f4ea; color: #1e7e34; }
  .status.off { background: #fdecea; color: #b3261e; }
  form { display: inline-block; margin: 4px 8px 4px 0; }
  button { padding: 10px 16px; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; font-size: 14px; }
  button.primary { background: #111; color: #fff; border-color: #111; }
  button.resume { background: #fff; color: #b3261e; border-color: #b3261e; }
  .hint { color: #666; font-size: 13px; margin-top: 24px; line-height: 1.6; }
</style>
</head>
<body>
<h1>DUMO 客服機器人控制台</h1>
<div class="status ${muted ? 'off' : 'on'}">${muted ? '🔴' : '🟢'} ${statusText}</div>
<form method="POST" action="/admin/pause"><input type="hidden" name="minutes" value="15" /><button class="primary">暫停 15 分鐘（預設）</button></form>
<form method="POST" action="/admin/pause"><input type="hidden" name="minutes" value="30" /><button>暫停 30 分鐘</button></form>
<form method="POST" action="/admin/pause"><input type="hidden" name="minutes" value="60" /><button>暫停 60 分鐘</button></form>
<form method="POST" action="/admin/resume"><button class="resume">立即恢復 AI 回覆</button></form>
<p class="hint">要親自回覆客人時，先點「暫停 15 分鐘」再開始回覆；回完可以點「立即恢復」提早解除。暫停期間，客人的訊息仍會照常轉發到 EasyStore 後台，只是 AI 不會另外推送回覆。</p>

<h2 style="font-size:16px;margin-top:32px;">一鍵網址（存成手機主畫面捷徑用）</h2>
<p class="hint">把下面兩個網址加到手機主畫面（iPhone：分享 → 加入主畫面；Android：選單 → 加到主畫面），
之後點圖示就會直接執行，不用再登入或按按鈕。網址裡帶有你的密碼，請不要分享給別人。</p>
<p style="font-size:13px;word-break:break-all;background:#f5f5f5;padding:8px;border-radius:6px;">暫停 15 分鐘：<br /><a href="${quickLinks.pauseUrl}">${quickLinks.pauseUrl}</a></p>
<p style="font-size:13px;word-break:break-all;background:#f5f5f5;padding:8px;border-radius:6px;">立即恢復：<br /><a href="${quickLinks.resumeUrl}">${quickLinks.resumeUrl}</a></p>
</body>
</html>`;
}

/** Tiny confirmation page for the one-tap quick-pause/quick-resume links. */
function renderQuickActionPage(message) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DUMO 客服機器人控制台</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", sans-serif; text-align: center; padding-top: 96px; font-size: 20px; color: #222; }
</style>
</head>
<body>${message}</body>
</html>`;
}

/** Minimal HTTP Basic Auth gate for the admin panel. Not timing-safe on
 * purpose — this protects a low-stakes internal toggle for a single owner,
 * not a system with real attackers in its threat model. */
function requireAdminAuth(adminSecret) {
  return (req, res, next) => {
    if (!adminSecret) {
      return res.status(503).send('Admin panel not configured (set ADMIN_SECRET).');
    }
    const authHeader = req.get('authorization') || '';
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
      const password = decoded.slice(decoded.indexOf(':') + 1);
      if (password === adminSecret) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="DUMO Bot Admin"');
    return res.status(401).send('Authentication required');
  };
}

// If a customer's own message contains one of these, treat it as them
// asking for a human — auto-mute AI replies to just that customer instead
// of relying on the shop owner to notice and hit the global pause in time.
// Edit this list any time; it's a plain substring match, case-sensitive.
const HUMAN_REQUEST_KEYWORDS = ['客服'];
const HUMAN_REQUEST_MUTE_MS = 60 * 60 * 1000; // 1 hour
const HUMAN_HANDOFF_MESSAGE = '請稍後，我們的團隊會盡快回覆您！';

// When a customer asks how the 1:1 ordering process works, send the
// official step-by-step graphic instead of trying to describe it in text.
// The file is served statically from /assets — see ASSETS_DIR below. Until
// the file actually exists there, this feature silently no-ops (falls
// through to the normal Claude reply).
const ONE_TO_ONE_PROCESS_IMAGE_FILENAME = '1to1-process.jpg';
const ASSETS_DIR = path.join(__dirname, 'assets');
const ONE_TO_ONE_PROCESS_CAPTION = '這是 1:1 訂購的流程，給您參考。';
function mentionsOneToOneProcess(text) {
  const mentionsOneToOne = /1[:：]?1|一比一/.test(text);
  const mentionsProcess = /流程|步驟|怎麼(訂|買|下單|客製)|訂購方式|教學/.test(text);
  return mentionsOneToOne && mentionsProcess;
}

/**
 * Tracks per-customer "a human should take this one" holds, separate from
 * the global admin-panel pause. In-memory only, same trade-off as
 * createMuteState — fine for a single-shop deployment, resets on restart.
 */
function createHumanRequestedMuteState() {
  const mutedUntilByUser = new Map();
  return {
    isMuted: (userId) => {
      const until = mutedUntilByUser.get(userId);
      return typeof until === 'number' && Date.now() < until;
    },
    muteUserFor: (userId, ms) => {
      mutedUntilByUser.set(userId, Date.now() + ms);
    },
    // Lets the admin "resume" action override every per-customer hold at
    // once, since there's no per-customer picker in the admin UI (yet).
    clearAll: () => {
      mutedUntilByUser.clear();
    },
  };
}

async function handleEventViaPush(event, ctx) {
  try {
    if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') {
      return;
    }
    const userId = event.source && event.source.userId;
    if (!userId) return; // group/room events without a resolvable user are skipped by this relay

    if (ctx.muteState && ctx.muteState.isMuted()) {
      return; // a human is handling replies right now — still forwarded to EasyStore separately
    }

    const text = event.message.text;

    if (ctx.humanRequestedMuteState && ctx.humanRequestedMuteState.isMuted(userId)) {
      return; // this customer already asked for a human recently — stay quiet
    }

    if (HUMAN_REQUEST_KEYWORDS.some((keyword) => text.includes(keyword))) {
      if (ctx.humanRequestedMuteState) {
        ctx.humanRequestedMuteState.muteUserFor(userId, HUMAN_REQUEST_MUTE_MS);
      }
      await ctx.pushImpl({
        channelAccessToken: ctx.lineChannelAccessToken,
        userId,
        text: HUMAN_HANDOFF_MESSAGE,
        fetchImpl: ctx.fetchImpl,
      });
      return;
    }

    if (ctx.oneToOneProcessImageUrl && mentionsOneToOneProcess(text)) {
      await ctx.pushImpl({
        channelAccessToken: ctx.lineChannelAccessToken,
        userId,
        messages: [
          {
            type: 'image',
            originalContentUrl: ctx.oneToOneProcessImageUrl,
            previewImageUrl: ctx.oneToOneProcessImageUrl,
          },
          { type: 'text', text: ONE_TO_ONE_PROCESS_CAPTION },
        ],
        fetchImpl: ctx.fetchImpl,
      });
      return;
    }

    const replyText = await getClaudeReply({
      anthropicClient: ctx.anthropicClient,
      userText: text,
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
  adminSecret,
  fetchImpl = fetch,
  forwardImpl = forwardToEasyStore,
  pushImpl = pushToLine,
  muteState = createMuteState(),
  humanRequestedMuteState = createHumanRequestedMuteState(),
  oneToOneProcessImageUrl,
}) {
  const app = express();

  // Serves images referenced in bot replies (e.g. the 1:1 process graphic)
  // at a public HTTPS URL, which LINE's image message type requires.
  app.use('/assets', express.static(ASSETS_DIR));

  app.get('/', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'line-bot-relay',
      aiPaused: muteState.isMuted(),
      time: new Date().toISOString(),
    });
  });

  app.get('/admin', requireAdminAuth(adminSecret), (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const quickLinks = {
      pauseUrl: `${baseUrl}/admin/quick-pause?key=${encodeURIComponent(adminSecret)}&minutes=15`,
      resumeUrl: `${baseUrl}/admin/quick-resume?key=${encodeURIComponent(adminSecret)}`,
    };
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderAdminPage(muteState, quickLinks));
  });

  app.post(
    '/admin/pause',
    requireAdminAuth(adminSecret),
    express.urlencoded({ extended: false }),
    (req, res) => {
      const minutes = parseInt(req.body?.minutes, 10) || 30;
      muteState.muteFor(minutes * 60 * 1000);
      res.redirect('/admin');
    }
  );

  app.post('/admin/resume', requireAdminAuth(adminSecret), (req, res) => {
    muteState.resume();
    humanRequestedMuteState.clearAll();
    res.redirect('/admin');
  });

  // One-tap links meant to be saved as a home-screen shortcut/bookmark on a
  // phone — auth is a ?key= query param instead of a Basic Auth prompt, so
  // tapping the icon acts immediately with no login step. The secret riding
  // in the URL (browser history, server access logs) is an accepted
  // trade-off for a single-owner convenience toggle, not a hardened system.
  app.get('/admin/quick-pause', (req, res) => {
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).send('Unauthorized');
    }
    const minutes = parseInt(req.query.minutes, 10) || 15;
    muteState.muteFor(minutes * 60 * 1000);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderQuickActionPage(`✅ AI 已暫停 ${minutes} 分鐘`));
  });

  app.get('/admin/quick-resume', (req, res) => {
    if (!adminSecret || req.query.key !== adminSecret) {
      return res.status(401).send('Unauthorized');
    }
    muteState.resume();
    humanRequestedMuteState.clearAll();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderQuickActionPage('✅ AI 已恢復自動回覆'));
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

      const imagePath = path.join(ASSETS_DIR, ONE_TO_ONE_PROCESS_IMAGE_FILENAME);
      const resolvedImageUrl =
        oneToOneProcessImageUrl ||
        (fs.existsSync(imagePath)
          ? `${req.protocol}://${req.get('host')}/assets/${ONE_TO_ONE_PROCESS_IMAGE_FILENAME}`
          : undefined);

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
            muteState,
            humanRequestedMuteState,
            oneToOneProcessImageUrl: resolvedImageUrl,
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
  if (!process.env.ADMIN_SECRET) {
    console.warn('[Relay Startup] ADMIN_SECRET not set — the /admin pause panel will be disabled.');
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
    adminSecret: process.env.ADMIN_SECRET,
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
  createMuteState,
  createHumanRequestedMuteState,
  mentionsOneToOneProcess,
  HUMAN_HANDOFF_MESSAGE,
  ONE_TO_ONE_PROCESS_CAPTION,
  ONE_TO_ONE_PROCESS_IMAGE_FILENAME,
  DEFAULT_BOT_LABEL,
};
