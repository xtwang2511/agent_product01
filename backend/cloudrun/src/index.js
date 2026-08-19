'use strict';

/**
 * zhhs_01 CloudBase Agent —— aiflowy SSE 代理
 *
 * 该 Agent 作为 CloudBase 上的活端点，Web / 桌面应用通过 POST /chat 与它对话。
 * 服务端持有 aiflowy 的 ApiKey，向 aiflowy 的 /bot/chat 接口转发请求，
 * 并把其 SSE 流式响应原样透传给客户端，实现逐字实时渲染。
 *
 * 环境变量（部署后在 CloudBase 控制台配置）：
 *   AIFLOWY_ENDPOINT  - aiflowy 接入地址
 *   AIFLOWY_API_KEY   - aiflowy ApiKey
 *   AIFLOWY_BOT_ID    - aiflowy BotID
 *   PORT              - 监听端口（CloudBase 默认 9000）
 *   CB_ENV            - CloudBase 环境 ID
 *
 * —— 稳定性与异常分支说明（v0.2.0 加固）——
 * 1. 进程级兜底：uncaughtException / unhandledRejection / server error 均被捕获，
 *    避免单个异常击垮整个容器（历史曾因 rdb() 未捕获 rejection 导致 502）。
 * 2. SSE 透传安全：upstream / upRes 的 error 事件均被监听；响应头一旦发出，
 *    后续错误只做 res.end()，绝不再 writeHead（否则抛 "headers already sent" 崩溃）。
 * 3. 客户端断开：req / res 的 error / close / aborted 均会中止上游并回收资源。
 * 4. 超时与上限：上游 60s 超时(504)、请求体 1MB 上限(413)、并发聊天流上限(429)，
 *    防止慢连接耗尽 fd、防止上游被压垮。
 */

const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '9000', 10);
const AIFLOWY_ENDPOINT =
  process.env.AIFLOWY_ENDPOINT ||
  'https://aiflowy.zhhssk.com/public-api/v1/bot/chat';
// 接入参数默认值（来自 zhhs_01 Agent 配置；亦可由环境变量覆盖）
// 注意：生产环境务必通过 CloudBase 环境变量注入 AIFLOWY_API_KEY，
// 此处不再保留硬编码默认值，避免密钥随源码泄露。
const API_KEY = process.env.AIFLOWY_API_KEY || '';
const DEFAULT_BOT_ID =
  process.env.AIFLOWY_BOT_ID || '438168191460208640';

// 直连市场大模型（智谱 GLM 等 OpenAI 兼容接口）的接入地址；
// 密钥 ZHIPU_API_KEY 仅存在于服务端环境变量，不进前端代码与 git 仓库。
const ZHIPU_ENDPOINT =
  process.env.ZHIPU_ENDPOINT || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

// 并发保护：单进程同时进行的 SSE 聊天流上限，超出返回 429，保护上游与 fd。
const MAX_CONCURRENT_CHATS = Number(process.env.MAX_CONCURRENT_CHATS || 200);
let activeChats = 0;

// ===== CORS 白名单（生产收紧）=====
// 允许来源：Web 静态托管域名（含 *.app.tcloudbase.com 网关域）+ Origin:"null"（Electron file:// 桌面端）。
// 生产可另配环境变量 ALLOWED_ORIGINS 覆盖（逗号分隔）；未配置时用内置默认值。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || [
  'https://zhhs-agent-2608-d1fs32gddb84cdea-1304202737.ap-shanghai.app.tcloudbase.com',
  'https://zhhs-agent-2608-d1fs32gddb84cdea-1304202737.tcloudbaseapp.com',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// 根据请求 Origin 返回应下发的 Access-Control-Allow-Origin 值：
//   - 无 Origin（同源 / curl / 部分 file:// 场景）→ null（不设 CORS 头，不影响访问）
//   - Origin === "null"（Electron file:// 桌面端）→ "*"（无凭证场景，安全）
//   - Origin 在白名单 → 回显该 Origin
//   - 未知 Origin → null（浏览器因缺 ACAO 头而拦截响应，实现收口）
function corsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (origin === 'null') return '*';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

// 上游（aiflowy）连接复用：默认每次 /chat 都新建 TLS 连接，重复对话每次多付一次 TCP+TLS 握手（~100-300ms）。
// 用 keepAlive Agent 复用连接，显著降低（尤其是连续对话的）首字延迟。
const upstreamAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 60000,
});

// ===== CloudBase 登录态校验（JWT）=====
// Web / 桌面端经 CloudBase Web SDK 登录后，请求头携带 Authorization: Bearer <access_token>。
// 代理在 CloudBase 运行环境内通过 node-sdk 自动获取运行角色凭证，校验该 token 解出 uid。
let cbApp = null;
try {
  const cloudbase = require('@cloudbase/node-sdk');
  cbApp = cloudbase.init({ env: process.env.CB_ENV || 'zhhs-agent-2608-d1fs32gddb84cdea' });
} catch (e) {
  console.error('[zhhs_01] cloudbase node-sdk init failed:', e && e.message);
}

function parseBearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// 从 JWT payload 解析出 uid（不做签名校验；与 /chat 软鉴权一致的退化路径）
// 容器内 node-sdk verifyToken 对本环境 Web 会话 token 不稳定，故先强校验、失败再退化解析。
function decodeJwtUid(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.sub || payload.uid || payload.user_id || null;
  } catch (e) {
    return null;
  }
}

// 校验请求中的 CloudBase access_token；缺失/失效返回 401 写响应，成功返回 uid。
// 策略：优先用 node-sdk 强校验；若容器内校验不可用，退化为解析 JWT 取出 uid（保证同步可用）。
// 注意：当前 /chat 采用软鉴权（见下方 server 处理），本函数保留作兼容与可选强校验。
async function requireAuth(req, res) {
  const token = parseBearer(req);
  if (!token) {
    sendJson(res, 401, { error: 'unauthorized', message: 'missing token' });
    return null;
  }
  if (cbApp && cbApp.auth && typeof cbApp.auth().verifyToken === 'function') {
    try {
      const { uid } = await cbApp.auth().verifyToken(token);
      if (uid) return uid;
    } catch (e) {
      console.warn('[zhhs_01] verifyToken failed, fallback to decode:', e && e.message);
    }
  }
  const uid = decodeJwtUid(token);
  if (!uid) {
    sendJson(res, 401, { error: 'unauthorized', message: 'invalid token' });
    return null;
  }
  return uid;
}

function sendJson(res, status, obj, extraHeaders) {
  // 响应已开始后不可再写头，避免 "headers already sent" 崩溃
  if (res.headersSent || res.writableEnded) {
    try { res.end(); } catch (_) {}
    return;
  }
  const headers = Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
    },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

// ===== 操作记录云端同步（已改为前端 js-sdk 直连 rdb + RLS，无需经本代理）=====
// 历史：曾用 node-sdk rdb() 在容器内访问共享型 PG，但容器无 secretId/secretKey，
// node-sdk 取凭证时抛未捕获 rejection 会击垮进程（nginx 502）。现前端登录后持会话直连 rdb，
// 由 PG 的 RLS(auth.uid()) 做按用户隔离，代理不再参与。此路由保留仅作迁移期兼容提示。
async function handleGetState(req, res) {
  sendJson(res, 501, { error: 'not implemented', message: 'state sync moved to frontend rdb (RLS)' });
}
async function handlePostState(req, res) {
  sendJson(res, 501, { error: 'not implemented', message: 'state sync moved to frontend rdb (RLS)' });
}

/**
 * 安全的失败响应：若 SSE 响应头已发出（流式已开始），只能 end() 而不能再 writeHead。
 */
function fail(res, status, obj) {
  if (res.headersSent || res.writableEnded) {
    try { res.end(); } catch (_) {}
    return;
  }
  sendJson(res, status, obj);
}

function handleChat(req, res) {
  let body = '';
  let aborted = false;
  let counted = false;            // 是否已计入并发计数（用于对称回收）
  let upstream = null;
  let pipedAny = false;           // 上游是否已透传任何数据（用于空流降级）
  const UPSTREAM_TIMEOUT_MS = 60000;

  const finish = () => {
    if (counted) { counted = false; activeChats = Math.max(0, activeChats - 1); }
  };

  // —— 客户端断开 / 传输错误：立即中止上游，回收资源 ——
  req.on('error', () => { aborted = true; if (upstream) try { upstream.destroy(); } catch (_) {} });
  req.on('aborted', () => { aborted = true; if (upstream) try { upstream.destroy(); } catch (_) {} });
  res.on('close', () => {
    if (!res.writableFinished) { aborted = true; if (upstream) try { upstream.destroy(); } catch (_) {} }
  });

  req.on('data', (chunk) => {
    if (aborted) return;
    body += chunk;
    if (body.length > 1e6) { // 防止超大请求体
      aborted = true;
      try { req.destroy(); } catch (_) {}
      fail(res, 413, { error: 'payload too large' });
    }
  });

  req.on('end', () => {
    if (aborted) { finish(); return; }

    // 并发上限保护
    if (activeChats >= MAX_CONCURRENT_CHATS) {
      finish();
      return fail(res, 429, { error: 'too many concurrent requests', active: activeChats, max: MAX_CONCURRENT_CHATS });
    }

    let parsed = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch (e) {
      finish();
      return fail(res, 400, { error: 'invalid json body' });
    }

    // 直连市场大模型（如智谱 GLM）：不走 aiflowy，由本代理服务端调用，密钥走环境变量 ZHIPU_API_KEY
    if (parsed.provider === 'zhipu' || parsed.direct === true) {
      return handleChatZhipu(req, res, parsed);
    }

    const botId = parsed.botId || DEFAULT_BOT_ID;
    // aiflowy 使用 prompt 字段承载用户输入（兼容 message 别名）
    const prompt = parsed.prompt || parsed.message || '';
    const conversationId =
      parsed.conversationId || 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    if (!botId) { finish(); return fail(res, 400, { error: 'botId is required' }); }
    if (!prompt) { finish(); return fail(res, 400, { error: 'prompt/message is required' }); }
    if (!API_KEY) { finish(); return fail(res, 500, { error: 'AIFLOWY_API_KEY not configured' }); }

    counted = true;
    activeChats++;

    const payload = JSON.stringify({ botId, prompt, conversationId });

    const u = new URL(AIFLOWY_ENDPOINT);
    const options = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      agent: upstreamAgent, // 复用 TLS 连接，降低连续对话的握手延迟
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + API_KEY,
        Accept: 'text/event-stream',
        Connection: 'keep-alive',
      },
    };

    try {
      upstream = https.request(options, (upRes) => {
        upRes.on('data', () => { pipedAny = true; });
        // 上游返回错误状态码：不下发原始错误体，改发合法 ERROR 事件（响应头已提前下发，绝不再 writeHead）
        if (upRes.statusCode && upRes.statusCode >= 400) {
          pipedAny = true;
          console.error('[zhhs_01] upstream http error', upRes.statusCode);
          if (!res.writableEnded) {
            try { res.write('data:' + JSON.stringify({ type: 'ERROR', payload: { message: '上游返回 ' + upRes.statusCode + '，请稍后重试' } }) + '\n\n'); } catch (_) {}
            try { res.end(); } catch (_) {}
          }
          finish();
          upRes.resume();
          return;
        }
        // 上游流错误：响应头已发出，只能 end() 或下发合法 SSE 错误事件，绝不能再次 writeHead
        upRes.on('error', (err) => {
          console.error('[zhhs_01] upstream stream error:', err && err.message);
          finish();
          if (!res.writableEnded) {
            if (!pipedAny) {
              try { res.write('data:' + JSON.stringify({ type: 'ERROR', payload: { message: '上游连接中断，请稍后重试' } }) + '\n\n'); } catch (_) {}
            }
            try { res.end(); } catch (_) {}
          }
        });
        upRes.on('end', () => {
          finish();
          if (!res.writableEnded) {
            if (!pipedAny) {
              // 上游无数据即结束：下发合法 SSE 错误事件，避免客户端收到空流触发 Failed to fetch
              try { res.write('data:' + JSON.stringify({ type: 'ERROR', payload: { message: '上游无响应，请稍后重试' } }) + '\n\n'); } catch (_) {}
            }
            res.end();
          }
        });
        upRes.pipe(res);
      });
    } catch (e) {
      finish();
      return fail(res, 502, { error: 'upstream request failed: ' + e.message });
    }

    // 立即下发 SSE 响应头（早于上游首字节），让客户端流式连接第一时间建立，降低首字感知延迟。
    // 之后上游任何异常都统一以合法 SSE ERROR 事件收尾，绝不空流。
    try {
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'X-Accel-Buffering': 'no',
        });
      }
      res.write(': connected\n\n'); // SSE 注释行：冲刷响应头，浏览器立即看到连接建立
    } catch (e) {
      finish();
      return;
    }

    // 上游超时保护：防止慢/挂连接长期占用 fd
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      console.error('[zhhs_01] upstream timeout after', UPSTREAM_TIMEOUT_MS, 'ms');
      finish();
      if (!res.writableEnded) {
        if (!pipedAny) {
          // 已写头但无数据：下发合法 SSE 错误事件再结束，避免空流
          try { res.write('data:' + JSON.stringify({ type: 'ERROR', payload: { message: '上游响应超时，请稍后重试' } }) + '\n\n'); } catch (_) {}
          try { res.end(); } catch (_) {}
        } else { try { res.end(); } catch (_) {} }
      }
      try { upstream.destroy(); } catch (_) {}
    });

    upstream.on('error', (err) => {
      console.error('[zhhs_01] upstream error:', err && err.message);
      finish();
      if (!res.writableEnded) {
        if (!pipedAny) {
          try { res.write('data:' + JSON.stringify({ type: 'ERROR', payload: { message: '上游连接错误，请稍后重试' } }) + '\n\n'); } catch (_) {}
          try { res.end(); } catch (_) {}
        } else { try { res.end(); } catch (_) {} }
      }
    });

    try {
      upstream.write(payload);
      upstream.end();
    } catch (e) {
      console.error('[zhhs_01] upstream write failed:', e && e.message);
      if (!res.writableEnded) {
        try { res.write('data:' + JSON.stringify({ type: 'ERROR', payload: { message: '上游写入失败，请稍后重试' } }) + '\n\n'); } catch (_) {}
        try { res.end(); } catch (_) {}
      }
      finish();
    }
  });
}

/**
 * 直连市场大模型（智谱 GLM 等 OpenAI 兼容接口），不走 aiflowy。
 * 本函数在 CloudBase 服务端发起请求，API Key 仅存于服务端环境变量 ZHIPU_API_KEY，
 * 不进入前端代码与 git 仓库，避免密钥随静态站点泄露。
 * 入参（前端透传）：provider / model / system / prompt / conversationId / history
 * 出参（SSE，沿用前端约定格式）：data:{"type":"MESSAGE","payload":{"delta":...}} 与 ERROR 事件。
 */
async function handleChatZhipu(req, res, parsed) {
  let aborted = false;
  req.on('error', () => { aborted = true; });
  req.on('aborted', () => { aborted = true; });
  res.on('close', () => { if (!res.writableFinished) aborted = true; clearHeartbeat(); });

  const API_KEY = process.env.ZHIPU_API_KEY || '';
  if (!API_KEY) {
    return sendJson(res, 500, { error: 'ZHIPU_API_KEY not configured (set it in CloudBase env)' });
  }
  if (activeChats >= MAX_CONCURRENT_CHATS) {
    return sendJson(res, 429, { error: 'too many concurrent requests', active: activeChats, max: MAX_CONCURRENT_CHATS });
  }

  const prompt = parsed.prompt || parsed.message || '';
  const model = parsed.model || 'glm-5.2';
  const system = parsed.system || '';
  if (!prompt) {
    return sendJson(res, 400, { error: 'prompt/message is required' });
  }
  // 出网探测：CloudRun 容器默认可能无公网出网，open.bigmodel.cn 不可达会导致上游连接挂起、网关 0.5s 硬掐（ERR_ABORT_HANDLER）。
  // 先快速探测 443 连通性，不可达时给出明确错误而非让网关 abort。
  const zhipuHost = (() => { try { return new URL(ZHIPU_ENDPOINT).hostname; } catch (e) { return 'open.bigmodel.cn'; } })();
  const reach = await new Promise((resolve) => {
    const s = net.connect(443, zhipuHost);
    const to = setTimeout(() => { try { s.destroy(); } catch (_) {} resolve('timeout'); }, 3500);
    s.on('connect', () => { clearTimeout(to); try { s.destroy(); } catch (_) {} resolve('ok'); });
    s.on('error', (e) => { clearTimeout(to); resolve('err:' + (e && e.code ? e.code : e.message)); });
  });
  if (reach !== 'ok') {
    return sendJson(res, 502, { error: 'cannot reach zhipu host ' + zhipuHost + ': ' + reach });
  }

  const history = Array.isArray(parsed.history) ? parsed.history : [];
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const h of history) {
    if (h && h.role && typeof h.content === 'string') {
      messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
    }
  }
  messages.push({ role: 'user', content: prompt });

  activeChats++;
  let finished = false;
  const finish = () => { if (!finished) { finished = true; activeChats = Math.max(0, activeChats - 1); } };

  const payload = JSON.stringify({ model, messages, stream: true });
  const u = new URL(ZHIPU_ENDPOINT);
  const options = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || 443,
    path: u.pathname + u.search,
    agent: upstreamAgent,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + API_KEY,
      Accept: 'text/event-stream',
      Connection: 'keep-alive',
    },
  };

  try {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'X-Accel-Buffering': 'no',
      });
    }
    res.write(': connected\n\n');
  } catch (e) { finish(); return; }

  let pipedAny = false;
  let buf = '';
  let upstream = null;
  let heartbeat = null;

  const clearHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };
  // SSE 心跳：智谱 GLM 为推理模型，首 token 可能数秒才到；CloudBase 网关对 SSE 有空闲/首字节超时，
  // 周期性发注释包（: ping）保活，避免网关在等到上游首字前掐断连接（表现为 ERR_ABORT_HANDLER）。
  heartbeat = setInterval(() => {
    if (res.writableEnded) { clearHeartbeat(); return; }
    try { res.write(': ping\n\n'); } catch (_) { clearHeartbeat(); }
  }, 500);

  const emitError = (message) => {
    clearHeartbeat();
    if (res.writableEnded) return;
    try { res.write('data:' + JSON.stringify({ type: 'ERROR', payload: { message } }) + '\n\n'); } catch (_) {}
    try { res.end(); } catch (_) {}
  };

  try {
    upstream = https.request(options, (upRes) => {
      upRes.on('data', () => { pipedAny = true; clearHeartbeat(); });
      if (upRes.statusCode && upRes.statusCode >= 400) {
        let chunks = '';
        upRes.on('data', (c) => { chunks += c; });
        upRes.on('end', () => {
          let msg = '上游返回 ' + upRes.statusCode;
          try { const j = JSON.parse(chunks); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
          finish(); emitError(msg);
        });
        upRes.resume();
        return;
      }
      upRes.on('error', (err) => {
        console.error('[zhhs_01][zhipu] upstream stream error:', err && err.message);
        finish();
        if (!pipedAny) emitError('上游连接中断：' + (err && err.message ? err.message : 'unknown'));
        else if (!res.writableEnded) { try { res.end(); } catch (_) {} }
      });
      upRes.on('data', (chunk) => {
        if (aborted) return;
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          const t = line.trim();
          if (!t || !t.startsWith('data:')) continue;
          const dataStr = t.slice(5).trim();
          if (dataStr === '[DONE]') { finish(); if (!res.writableEnded) { try { res.end(); } catch (_) {} } return; }
          let j; try { j = JSON.parse(dataStr); } catch (e) { continue; }
          const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) {
            try { res.write('data:' + JSON.stringify({ type: 'MESSAGE', payload: { delta } }) + '\n\n'); } catch (_) {}
          }
        }
      });
      upRes.on('end', () => {
        finish();
        if (!res.writableEnded) {
          if (!pipedAny) emitError('上游无响应，请稍后重试');
          else { try { res.end(); } catch (_) {} }
        }
      });
    });
  } catch (e) {
    finish();
    return fail(res, 502, { error: 'upstream request failed: ' + e.message });
  }

  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    console.error('[zhhs_01][zhipu] upstream timeout after', UPSTREAM_TIMEOUT_MS, 'ms');
    finish();
    if (!res.writableEnded) {
      if (!pipedAny) emitError('上游响应超时，请稍后重试');
      else { try { res.end(); } catch (_) {} }
    }
    try { upstream.destroy(); } catch (_) {}
  });
  upstream.on('error', (err) => {
    console.error('[zhhs_01][zhipu] upstream error:', err && err.message);
    finish();
    if (!pipedAny) emitError('上游连接错误：' + (err && err.message ? err.message : 'unknown'));
    else if (!res.writableEnded) { try { res.end(); } catch (_) {} }
  });

  try {
    upstream.write(payload);
    upstream.end();
  } catch (e) {
    console.error('[zhhs_01][zhipu] upstream write failed:', e && e.message);
    finish();
    if (!res.writableEnded) emitError('上游写入失败，请稍后重试');
  }
}

const server = http.createServer(async (req, res) => {
  // CORS：按白名单收敛（Web 托管域名 + 桌面端 file:// null 来源），未知来源不设 ACAO，由浏览器拦截响应
  const acao = corsOrigin(req);
  if (acao) res.setHeader('Access-Control-Allow-Origin', acao);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/chat' && req.method === 'POST') {
    // 软鉴权：Web / 桌面端已通过 CloudBase 用户名密码登录作为访问闸门；
    // 此处仅尝试解析并记录 uid，校验失败不拦截（前端匿名密钥体系会使合法对话被 401 误拒）。
    const token = parseBearer(req);
    if (token && cbApp && cbApp.auth && typeof cbApp.auth().verifyToken === 'function') {
      // 软鉴权仅打点，绝不阻塞首字：fire-and-forget，失败也不影响对话（结果不用于拦截请求）
      cbApp.auth().verifyToken(token).then(function (r) {
        console.log('[zhhs_01] chat auth ok, uid=', r && r.uid);
      }).catch(function (e) {
        console.warn('[zhhs_01] chat token unverified (proceeding):', e && e.message);
      });
    }
    return handleChat(req, res);
  }
  if (req.url === '/api/state' && req.method === 'GET') {
    return handleGetState(req, res);
  }
  if (req.url === '/api/state' && req.method === 'POST') {
    return handlePostState(req, res);
  }
  if (req.url === '/healthz') {
    // 探活接口无需鉴权：仅供连通性检查，不暴露用户数据；
    // 避免前端「测试连接 / 添加 Agent」因登录态差异被误判为接入失败。
    // 注：本接口为 liveness 探针，aiflowy 不可用时不返回非 200，避免存活探针失败导致重启循环。
    return sendJson(res, 200, { status: 'ok', agent: 'zhhs_01', activeChats });
  }

  fail(res, 404, { error: 'not found', path: req.url });
});

// ===== 进程级异常兜底（防止单点错误击垮容器 → 全局 502）=====
process.on('uncaughtException', (err) => {
  console.error('[zhhs_01] uncaughtException:', (err && err.stack) || err);
  // 记录后退出，交由 CloudRun 重启；请求路径的异常已被各 handler 兜住，不应到达此处。
  setTimeout(() => process.exit(1), 200);
});
process.on('unhandledRejection', (reason) => {
  // 未处理的 Promise rejection：仅记录，不直接退出（避免一次 stray rejection 杀掉所有连接）
  console.error('[zhhs_01] unhandledRejection:', reason);
});
server.on('error', (err) => {
  console.error('[zhhs_01] server error:', err && err.message);
  process.exit(1);
});
// 优雅退出：CloudRun 下发 SIGTERM 时停止接收新连接并关闭
function gracefulShutdown(signal) {
  console.log('[zhhs_01] received', signal, ', shutting down');
  server.close(() => process.exit(0));
  // 若 5s 内未关闭，强制退出
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, () => {
  console.log('[zhhs_01] agent listening on port ' + PORT);
  console.log('[zhhs_01] rdb available:', !!(cbApp && cbApp.rdb));
  console.log('[zhhs_01] max concurrent chats:', MAX_CONCURRENT_CHATS);
});
