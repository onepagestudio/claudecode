const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const {
  createApp,
  verifyLineSignature,
  buildSystemPrompt,
  getClaudeReply,
  supportsEffortParam,
  FALLBACK_MESSAGE,
} = require('../server');

const CHANNEL_SECRET = 'test-channel-secret';
const CHANNEL_ACCESS_TOKEN = 'test-channel-access-token';

function sign(bodyString, secret = CHANNEL_SECRET) {
  return crypto.createHmac('sha256', secret).update(bodyString).digest('base64');
}

function lineTextEvent(text, replyToken = 'reply-token-123') {
  return {
    destination: 'xxxxxxxxxx',
    events: [
      {
        type: 'message',
        replyToken,
        message: { type: 'text', id: '1', text },
        source: { type: 'user', userId: 'U1234567890' },
        timestamp: Date.now(),
      },
    ],
  };
}

/** Builds a fake Anthropic client whose messages.create() is fully controllable. */
function fakeAnthropicClient({ text = 'mock reply', stopReason = 'end_turn', shouldThrow = false } = {}) {
  return {
    messages: {
      create: async (_params, _opts) => {
        if (shouldThrow) throw Object.assign(new Error('simulated Claude API failure'), { status: 500 });
        return {
          stop_reason: stopReason,
          content: [{ type: 'text', text }],
        };
      },
    },
  };
}

/** Records every call instead of hitting the real LINE Reply API. */
function fakeLineReplySpy({ shouldThrow = false } = {}) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    if (shouldThrow) throw new Error('simulated LINE API failure');
    return true;
  };
  return { impl, calls };
}

function buildTestApp(overrides = {}) {
  const anthropicClient = overrides.anthropicClient || fakeAnthropicClient();
  const lineSpy = overrides.lineSpy || fakeLineReplySpy();
  const app = createApp({
    anthropicClient,
    lineChannelAccessToken: CHANNEL_ACCESS_TOKEN,
    lineChannelSecret: CHANNEL_SECRET,
    systemPrompt: buildSystemPrompt('(test knowledge base)'),
    model: 'claude-opus-5',
    sendLineReplyImpl: lineSpy.impl,
  });
  return { app, lineSpy };
}

test('GET / returns a healthy status', async () => {
  const { app } = buildTestApp();
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('verifyLineSignature accepts a correctly signed body', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const signature = sign(body);
  assert.equal(verifyLineSignature(body, signature, CHANNEL_SECRET), true);
});

test('verifyLineSignature rejects a tampered body', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const signature = sign(body);
  const tampered = Buffer.from(JSON.stringify({ hello: 'tampered' }));
  assert.equal(verifyLineSignature(tampered, signature, CHANNEL_SECRET), false);
});

test('verifyLineSignature rejects a signature from the wrong secret', () => {
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const signature = sign(body, 'wrong-secret');
  assert.equal(verifyLineSignature(body, signature, CHANNEL_SECRET), false);
});

test('POST /webhook rejects requests with a missing/invalid signature', async () => {
  const { app } = buildTestApp();
  const payload = lineTextEvent('哈囉');
  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));
  // supertest without an explicit x-line-signature header -> verification fails
  assert.equal(res.status, 401);
});

test('POST /webhook with a valid signature calls Claude then replies via LINE', async () => {
  const anthropicClient = fakeAnthropicClient({ text: '您好，這是測試回覆內容。' });
  const { app, lineSpy } = buildTestApp({ anthropicClient });

  const payload = lineTextEvent('請問營業時間？', 'reply-token-abc');
  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString);

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-line-signature', signature)
    .send(bodyString);

  assert.equal(res.status, 200);
  assert.equal(lineSpy.calls.length, 1);
  assert.equal(lineSpy.calls[0].replyToken, 'reply-token-abc');
  assert.equal(lineSpy.calls[0].text, '您好，這是測試回覆內容。');
  assert.equal(lineSpy.calls[0].channelAccessToken, CHANNEL_ACCESS_TOKEN);
});

test('POST /webhook falls back gracefully when the Claude API errors', async () => {
  const anthropicClient = fakeAnthropicClient({ shouldThrow: true });
  const { app, lineSpy } = buildTestApp({ anthropicClient });

  const payload = lineTextEvent('這則訊息會觸發 Claude 端錯誤');
  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString);

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-line-signature', signature)
    .send(bodyString);

  assert.equal(res.status, 200, 'webhook must still ack 200 even when Claude fails');
  assert.equal(lineSpy.calls.length, 1);
  assert.equal(lineSpy.calls[0].text, FALLBACK_MESSAGE);
});

test('POST /webhook does not crash the server when the LINE reply call fails', async () => {
  const lineSpy = fakeLineReplySpy({ shouldThrow: true });
  const { app } = buildTestApp({ lineSpy });

  const payload = lineTextEvent('這則訊息會觸發 LINE 端錯誤');
  const bodyString = JSON.stringify(payload);
  const signature = sign(bodyString);

  const res = await request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-line-signature', signature)
    .send(bodyString);

  assert.equal(res.status, 200, 'webhook must still ack 200 even when the LINE API fails');
});

test('POST /webhook ignores non-text / non-message events without erroring', async () => {
  const { app, lineSpy } = buildTestApp();
  const payload = {
    events: [
      { type: 'follow', replyToken: 'rt-1', source: { type: 'user', userId: 'U1' }, timestamp: Date.now() },
      { type: 'message', replyToken: 'rt-2', message: { type: 'sticker', id: '1' }, source: { type: 'user', userId: 'U1' }, timestamp: Date.now() },
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
  assert.equal(lineSpy.calls.length, 0, 'non-text events should not trigger a Claude call or a reply');
});

test('getClaudeReply omits output_config.effort for claude-haiku-4-5 (unsupported param)', async () => {
  let capturedParams;
  const anthropicClient = {
    messages: {
      create: async (params) => {
        capturedParams = params;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    },
  };

  await getClaudeReply({
    anthropicClient,
    userText: '哈囉',
    systemPrompt: 'system',
    model: 'claude-haiku-4-5',
  });

  assert.equal(supportsEffortParam('claude-haiku-4-5'), false);
  assert.equal('output_config' in capturedParams, false);
  assert.equal('thinking' in capturedParams, false);
});

test('getClaudeReply includes output_config.effort for claude-opus-5', async () => {
  let capturedParams;
  const anthropicClient = {
    messages: {
      create: async (params) => {
        capturedParams = params;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    },
  };

  await getClaudeReply({
    anthropicClient,
    userText: '哈囉',
    systemPrompt: 'system',
    model: 'claude-opus-5',
  });

  assert.equal(supportsEffortParam('claude-opus-5'), true);
  assert.equal(capturedParams.output_config.effort, 'medium');
  assert.equal(capturedParams.thinking.type, 'disabled');
});

test('getClaudeReply sends the system prompt as a cached content block', async () => {
  let capturedParams;
  const anthropicClient = {
    messages: {
      create: async (params) => {
        capturedParams = params;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    },
  };

  await getClaudeReply({
    anthropicClient,
    userText: '哈囉',
    systemPrompt: 'system prompt text',
    model: 'claude-haiku-4-5',
  });

  assert.ok(Array.isArray(capturedParams.system));
  assert.equal(capturedParams.system[0].text, 'system prompt text');
  assert.deepEqual(capturedParams.system[0].cache_control, { type: 'ephemeral' });
});

test('buildSystemPrompt embeds the knowledge base content', () => {
  const prompt = buildSystemPrompt('營業時間：週一至週五 9:00-18:00');
  assert.match(prompt, /營業時間：週一至週五 9:00-18:00/);
  assert.match(prompt, /真人客服/);
});
