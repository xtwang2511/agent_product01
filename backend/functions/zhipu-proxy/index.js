'use strict';
// 中海言析 —— 多供应商 OpenAI 兼容 BYOK 代理（CloudBase Web 函数 / SSE 透传）
// CloudRun 容器无公网出网，故把"真正访问大模型厂商"下沉到云函数：云函数默认带公网出网。
// 两种用法：
//   1) 平台默认：服务端持有 ZHIPU_API_KEY，前端只传 provider:"zhipu"，走智谱额度。
//   2) BYOK（自带 Key）：用户自选供应商并填自己的 API Key，函数用它转发到对应
//      OpenAI 兼容端点；Key 只用于本次请求转发，不写日志、不进响应。
// 监听 PORT（Web 函数固定 9000），浏览器经 SSE 拉流，逐字实时渲染。

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '9000', 10);
const ZHIPU_ENDPOINT =
  process.env.ZHIPU_ENDPOINT || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY || '';
// 轻量鉴权令牌：防止匿名外部调用把本函数当开放跳板（防扫描/爬虫级别，非强鉴权）。
// 仅在云端环境变量配置，部署后必须设置，否则代理返回 503 拒绝服务。
// 前端经请求体携带 appToken —— 故意不走自定义请求头，否则会触发 CloudBase 网关
// CORS 预检（direct 路径只允许 Content-Type 这一个简单头，见下方注释）。
const APP_TOKEN = process.env.APP_TOKEN || '';

// OpenAI 兼容供应商预设：provider -> { endpoint, defaultModel }
// 自定义 baseUrl（请求体传 baseUrl）可覆盖 endpoint，兼容任意 OpenAI 格式接口。
const PROVIDER_MAP = {
  zhipu: {
    endpoint: ZHIPU_ENDPOINT,
    defaultModel: 'glm-5.2',
    needServerKey: true, // 平台默认走服务端密钥
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
  },
  qwen: {
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: 'qwen-plus',
  },
  siliconflow: {
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
  },
  moonshot: {
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    defaultModel: 'moonshot-v1-8k',
  },
};

function sendJson(res, status, obj) {
  if (res.headersSent || res.writableEnded) { try { res.end(); } catch (_) {} return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  // 注意：CloudBase 网关会主动为 WEB_SCF 响应添加 CORS 头；
  // 若函数自己也写，网关会追加成 origin,origin / origin,* 等非法重复值，导致浏览器 Failed to fetch。
  // 因此这里不设置任何 CORS 头，完全交给网关处理。

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 健康检查：GET /healthz（或网关转发后的 /zhipu-proxy/healthz）返回 200，供前端连通校验
  if (req.method === 'GET') {
    const p = (req.url || '').split('?')[0];
    if (p === '/' || p === '/healthz' || p.endsWith('/healthz') || p.endsWith('/zhipu-proxy')) {
      sendJson(res, 200, { ok: true, providers: Object.keys(PROVIDER_MAP), upstream: ZHIPU_ENDPOINT });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }

  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 2e6) { try { req.destroy(); } catch (_) {} }
  });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = {}; }

    const prompt = parsed.prompt || parsed.message || '';
    const system = parsed.system || '';
    const history = Array.isArray(parsed.history) ? parsed.history : [];
    const provider = typeof parsed.provider === 'string' ? parsed.provider.toLowerCase() : 'zhipu';
    const preset = PROVIDER_MAP[provider] || null;
    // 用户自带 Key（BYOK）：存在则优先，覆盖平台默认密钥
    const userKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    // 自定义 baseUrl：覆盖预设端点，兼容任意 OpenAI 格式接口
    const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim() : '';

    if (!APP_TOKEN) { sendJson(res, 503, { error: 'APP_TOKEN not configured' }); return; }
    if (parsed.appToken !== APP_TOKEN) { sendJson(res, 403, { error: 'forbidden' }); return; }
    if (!prompt) { sendJson(res, 400, { error: 'prompt required' }); return; }

    // 确定上游端点：自定义 baseUrl > 供应商预设 > 智谱默认
    const endpoint = baseUrl || (preset && preset.endpoint) || ZHIPU_ENDPOINT;
    // 确定鉴权密钥：用户 Key > 供应商预设需服务端 Key（仅 zhipu）> 空
    const apiKey = userKey || (preset && preset.needServerKey ? ZHIPU_API_KEY : '') || ZHIPU_API_KEY;
    const model = parsed.model || (preset && preset.defaultModel) || 'glm-5.2';

    if (!apiKey) {
      const msg = preset && preset.needServerKey
        ? 'ZHIPU_API_KEY not configured'
        : ('缺少 API Key：请为 ' + provider + ' 填写你自己的 Key');
      sendJson(res, 400, { error: msg });
      return;
    }

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const h of history) {
      if (h && h.role && typeof h.content === 'string') {
        messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
      }
    }
    messages.push({ role: 'user', content: prompt });

    const payload = JSON.stringify({ model, messages, stream: true });
    const u = new URL(endpoint);

    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    res.write(': connected\n\n');

    let buf = '';
    let piped = false;
    const finish = (obj) => {
      if (res.writableEnded) return;
      if (obj) res.write('data:' + JSON.stringify(obj) + '\n\n');
      res.end();
    };

    const up = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
          Accept: 'text/event-stream',
        },
        timeout: 110000,
      },
      (upRes) => {
        if (upRes.statusCode && upRes.statusCode >= 400) {
          let chunks = '';
          upRes.on('data', (c) => { chunks += c; });
          upRes.on('end', () => {
            let msg = '上游返回 ' + upRes.statusCode;
            try { const j = JSON.parse(chunks); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
            finish({ type: 'ERROR', payload: { message: msg } });
          });
          upRes.resume();
          return;
        }
        upRes.on('data', (chunk) => {
          piped = true;
          buf += chunk.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            const t = line.trim();
            if (!t || !t.startsWith('data:')) continue;
            const dataStr = t.slice(5).trim();
            if (dataStr === '[DONE]') { finish({ type: 'MESSAGE', payload: { done: true } }); return; }
            let j;
            try { j = JSON.parse(dataStr); } catch (e) { continue; }
            const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (delta) res.write('data:' + JSON.stringify({ type: 'MESSAGE', payload: { delta } }) + '\n\n');
          }
        });
        upRes.on('end', () => { if (!piped) finish({ type: 'ERROR', payload: { message: '上游无响应' } }); else finish(); });
        upRes.on('error', (e) => finish({ type: 'ERROR', payload: { message: '上游错误：' + e.message } }));
      }
    );
    up.on('error', (e) => finish({ type: 'ERROR', payload: { message: '请求错误：' + e.message } }));
    up.setTimeout(110000, () => { try { up.destroy(); } catch (_) {} finish({ type: 'ERROR', payload: { message: '上游超时' } }); });
    up.write(payload);
    up.end();
  });
});

server.listen(PORT, () => {
  console.log('[zhipu-proxy] listening on', PORT);
});
