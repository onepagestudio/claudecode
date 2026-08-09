const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { createRelayApp, createMuteState, DEFAULT_BOT_LABEL } = require('../relay-server');
const { buildSystemPrompt } = require('../server');

const CHANNEL_SECRET = 'test-channel-secret';
const CHANNEL_ACCESS_TOKEN = 'test-channel-access-token';
const EASYSTORE_URL = 'https://api.easystore.co/admin/v2/line/webhook?channel_id=123&store_token=abc';
const ADMIN_SECRET = 'test-admin-secret';

function sign(bodyString, secret = CHANNEL_SECRET) {
  return crypto.createHmac('sha256', secret).update(bodyString).digest('base64');
}

function lineTextEvent(text, userId = 'U1234567890') {
  return {
    destination: 'xxxxxxxxxx',
    events: [
      {
        type: 'message',
        replyToken: 'reply-token-123',
        message: { type: 'text', id: '1', text },
        source: { type: 'user', userId },
        timestamp: Date.now(),
      },
    ],
  };
}

function fakeAnthropicClient(text = 'mock reply') {
  return {
    messages: {
      create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }),
    },
  };
}

function fakeForwardSpy({ shouldFail = false } = {}) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    if (shouldFail) throw new Error('simulated EasyStore forward failure');
    return true;
  };
  return { impl, calls };
}

function fakePushSpy({ shouldFail = false } = {}) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    if (shouldFail) throw new Error('simulated LINE push failure');
    return true;
  };
  return { impl, calls };
}

function buildTestApp(overrides = {}) {
  const anthropicClient = overrides.anthropicClient || fakeAnthropicClient();
  const forwardSpy = overrides.forwardSpy || fakeForwardSpy();
  const pushSpy = overrides.pushSpy || fakePushSpy();
  const muteState = overrides.muteState || createMuteState();
  const app = createRelayApp({
    anthropicClient,
    lineChannelAccessToken: CHANNEL_ACCESS_TOKEN,
    lineChannelSecret: CHANNEL_SECRET,
    easyStoreWebhookUrl: EASYSTORE_URL,
    adminSecret: Object.prototype.hasOwnProperty.call(overrides, 'adminSecret')
      ? overrides.adminSecret
      : ADMIN_SECRET,
    systemPrompt: buildSystemPrompt('(test knowledge base)'),
    forwardImpl: forwardSpy.impl,
    pushImpl: pushSpy.impl,
    muteState,
  });
  return { app, forwardSpy, pushSpy, muteState };
}

test('GET / returns a healthy relay status', async () => {
  const { app } = buildTestApp();
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.service, 'line-bot-relay');
});

test('POST /webhook rejects an invalid signature and never forwards', async () => {
  const { app, forwardSpy, pushSpy } = buildTestApp();
  const payload = lineTextEvent('哈囉');
  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));

  assert.equal(res.status, 401);
  assert.equal(forwardSpy.calls.length, 0);
  assert.equal(pushSpy.calls.length, 0);
});

test('POST /webhook forwards the raw body to EasyStore and pushes a labeled Claude reply', async () => {
  const anthropicClient = fakeAnthropicClient('您好，這是測試回覆。');
  const { app, forwardSpy, pushSpy } = buildTestApp({ anthropicClient });

  const payload = lineTextEvent('請問營業時間？', 'U_real_user');
  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString);

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-line-signature', signature)
    .send(bodyString);

  assert.equal(res.status, 200);

  assert.equal(forwardSpy.calls.length, 1);
  assert.equal(forwardSpy.calls[0].easyStoreWebhookUrl, EASYSTORE_URL);
  assert.equal(forwardSpy.calls[0].rawBody.toString('utf-8'), bodyString);
  assert.equal(forwardSpy.calls[0].signature, signature);

  assert.equal(pushSpy.calls.length, 1);
  assert.equal(pushSpy.calls[0].userId, 'U_real_user');
  assert.equal(pushSpy.calls[0].channelAccessToken, CHANNEL_ACCESS_TOKEN);
  assert.equal(pushSpy.calls[0].text, DEFAULT_BOT_LABEL + '您好，這是測試回覆。');
});

test('POST /webhook still forwards non-text events to EasyStore but does not push', async () => {
  const { app, forwardSpy, pushSpy } = buildTestApp();
  const payload = {
    events: [
      { type: 'follow', replyToken: 'rt-1', source: { type: 'user', userId: 'U1' }, timestamp: Date.now() },
    ],
  };
  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString);

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-line-signature', signature)
    .send(bodyString);

  assert.equal(res.status, 200);
  assert.equal(forwardSpy.calls.length, 1, 'EasyStore must still receive every event unmodified');
  assert.equal(pushSpy.calls.length, 0);
});

test('POST /webhook still forwards to EasyStore even if our own push fails', async () => {
  const pushSpy = fakePushSpy({ shouldFail: true });
  const { app, forwardSpy } = buildTestApp({ pushSpy });

  const payload = lineTextEvent('這則會讓 push 失敗');
  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString);

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-line-signature', signature)
    .send(bodyString);

  assert.equal(res.status, 200, 'relay must not crash or fail the whole request when the push fails');
  assert.equal(forwardSpy.calls.length, 1, 'EasyStore forward is independent of our push outcome');
});

test('POST /webhook still pushes our reply even if the EasyStore forward fails', async () => {
  const forwardSpy = fakeForwardSpy({ shouldFail: true });
  const { app, pushSpy } = buildTestApp({ forwardSpy });

  const payload = lineTextEvent('這則會讓轉發失敗');
  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString);

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-line-signature', signature)
    .send(bodyString);

  assert.equal(res.status, 200, 'relay must not crash or fail the whole request when the forward fails');
  assert.equal(pushSpy.calls.length, 1, 'our push is independent of the EasyStore forward outcome');
});

test('createMuteState: isMuted reflects muteFor/resume', () => {
  const muteState = createMuteState();
  assert.equal(muteState.isMuted(), false);

  muteState.muteFor(60_000);
  assert.equal(muteState.isMuted(), true);

  muteState.resume();
  assert.equal(muteState.isMuted(), false);
});

test('GET /admin without credentials is rejected', async () => {
  const { app } = buildTestApp();
  const res = await request(app).get('/admin');
  assert.equal(res.status, 401);
});

test('GET /admin with the wrong password is rejected', async () => {
  const { app } = buildTestApp();
  const res = await request(app).get('/admin').auth('anything', 'wrong-password');
  assert.equal(res.status, 401);
});

test('GET /admin returns 503 when ADMIN_SECRET is not configured', async () => {
  const { app } = buildTestApp({ adminSecret: undefined });
  const res = await request(app).get('/admin').auth('anything', 'whatever');
  assert.equal(res.status, 503);
});

test('GET /admin with the correct password shows current status', async () => {
  const { app } = buildTestApp();
  const res = await request(app).get('/admin').auth('admin', ADMIN_SECRET);
  assert.equal(res.status, 200);
  assert.match(res.text, /目前正常自動回覆中/);
});

test('GET /admin includes bookmarkable quick-pause/quick-resume links with the secret embedded', async () => {
  const { app } = buildTestApp();
  const res = await request(app).get('/admin').auth('admin', ADMIN_SECRET);
  assert.match(res.text, /\/admin\/quick-pause\?key=test-admin-secret&minutes=15/);
  assert.match(res.text, /\/admin\/quick-resume\?key=test-admin-secret/);
});

test('GET /admin/quick-pause with the correct key mutes without needing Basic Auth', async () => {
  const { app, muteState } = buildTestApp();
  const res = await request(app).get('/admin/quick-pause').query({ key: ADMIN_SECRET, minutes: 15 });
  assert.equal(res.status, 200);
  assert.equal(muteState.isMuted(), true);
});

test('GET /admin/quick-pause with the wrong key is rejected and does not mute', async () => {
  const { app, muteState } = buildTestApp();
  const res = await request(app).get('/admin/quick-pause').query({ key: 'wrong', minutes: 15 });
  assert.equal(res.status, 401);
  assert.equal(muteState.isMuted(), false);
});

test('GET /admin/quick-resume with the correct key resumes', async () => {
  const muteState = createMuteState();
  muteState.muteFor(60_000);
  const { app } = buildTestApp({ muteState });

  const res = await request(app).get('/admin/quick-resume').query({ key: ADMIN_SECRET });
  assert.equal(res.status, 200);
  assert.equal(muteState.isMuted(), false);
});

test('POST /admin/pause stops the bot from pushing replies, but EasyStore still gets forwarded', async () => {
  const { app, forwardSpy, pushSpy, muteState } = buildTestApp();

  const pauseRes = await request(app)
    .post('/admin/pause')
    .auth('admin', ADMIN_SECRET)
    .type('form')
    .send({ minutes: '30' });
  assert.equal(pauseRes.status, 302);
  assert.equal(muteState.isMuted(), true);

  const payload = lineTextEvent('店主正在親自回覆，這則不該被 AI 搶答');
  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString);

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-line-signature', signature)
    .send(bodyString);

  assert.equal(res.status, 200);
  assert.equal(pushSpy.calls.length, 0, 'AI must not push a reply while paused');
  assert.equal(forwardSpy.calls.length, 1, 'EasyStore must still receive the message while paused');
});

test('POST /admin/resume re-enables pushing replies', async () => {
  const muteState = createMuteState();
  muteState.muteFor(60_000);
  const { app, pushSpy } = buildTestApp({ muteState });

  const resumeRes = await request(app).post('/admin/resume').auth('admin', ADMIN_SECRET);
  assert.equal(resumeRes.status, 302);
  assert.equal(muteState.isMuted(), false);

  const payload = lineTextEvent('暫停解除後這則應該正常回覆');
  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString);

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-line-signature', signature)
    .send(bodyString);

  assert.equal(res.status, 200);
  assert.equal(pushSpy.calls.length, 1, 'AI should push replies again after resume');
});
