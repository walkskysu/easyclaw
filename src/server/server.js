// server.js
// Node.js 后端服务：接收 web/weixin 消息，通过 WebSocket 与客户端通信，调用大模型

const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const childProcess = require('child_process');
const util = require('util');

const execAsync = util.promisify(childProcess.exec);

const confPath = path.resolve(__dirname, '../../conf/server.conf');
const appRoot = path.resolve(__dirname, '../..');

// ─── 配置读取 ────────────────────────────────────────────────────────────────

function readServerConf() {
  const conf = {};
  const content = fs.readFileSync(confPath, 'utf-8');
  content.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([^#][^=]*)=(.*)$/);
    if (match) conf[match[1].trim()] = match[2].trim();
  });
  return conf;
}

function requireConfig(conf, keys) {
  const missing = keys.filter((key) => !String(conf[key] || '').trim());
  if (missing.length > 0) {
    throw new Error(`server.conf 缺少必填配置: ${missing.join(', ')}`);
  }
}

const config = readServerConf();
requireConfig(config, ['LLM_API_URL', 'LLM_MODEL', 'LLM_API_KEY']);

const app = express();
app.use(bodyParser.json());

// ─── 日志 ────────────────────────────────────────────────────────────────────

const logDir = path.resolve(appRoot, 'logs/server');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function logWrite(filename, entry) {
  fs.appendFileSync(path.join(logDir, filename), entry + '\n', 'utf-8');
}

// ─── 工具路径解析 ─────────────────────────────────────────────────────────────

function resolveToolPath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('path is required');
  }
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(appRoot, inputPath);
  const relative = path.relative(appRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('path is outside workspace root');
  }
  return candidate;
}

// ─── 文件读取工具 ─────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_LINES = 2000;

function readTextRange(filePath, offset, limit) {
  const fullText = fs.readFileSync(filePath, 'utf-8');
  const lines = fullText.split(/\r?\n/);
  const start = Math.max(0, Number(offset ?? 1) - 1);
  const maxLines = Math.max(1, Number(limit ?? MAX_READ_LINES));
  const selected = [];
  let byteCount = 0;
  let truncatedBySize = false;
  for (let i = start; i < lines.length && selected.length < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1;
    if (byteCount + lineBytes > MAX_READ_BYTES) { truncatedBySize = true; break; }
    selected.push(lines[i]);
    byteCount += lineBytes;
  }
  return {
    path: filePath,
    offset: start + 1,
    lines: selected.length,
    content: selected.join('\n'),
    truncated: truncatedBySize || start + selected.length < lines.length,
  };
}

function buildListEntries(targetPath, includeHidden, longFormat) {
  const stat = fs.statSync(targetPath);
  const basename = path.basename(targetPath);
  if (!stat.isDirectory()) {
    if (longFormat) return [{ name: basename, path: targetPath, type: 'file', size: stat.size, mtime: stat.mtime.toISOString() }];
    return [basename];
  }
  const dirents = fs.readdirSync(targetPath, { withFileTypes: true });
  const filtered = dirents.filter((e) => includeHidden || !e.name.startsWith('.'));
  if (!longFormat) return filtered.map((e) => e.name);
  return filtered.map((e) => {
    const fullPath = path.join(targetPath, e.name);
    const s = fs.statSync(fullPath);
    return { name: e.name, path: fullPath, type: e.isDirectory() ? 'directory' : 'file', size: s.size, mtime: s.mtime.toISOString() };
  });
}

function applyTextEdits(content, edits) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits must be a non-empty array');
  const ranges = edits.map((edit, i) => {
    if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') throw new Error(`edits[${i}] is invalid`);
    const first = content.indexOf(edit.oldText);
    if (first < 0) throw new Error(`edits[${i}].oldText not found`);
    if (first !== content.lastIndexOf(edit.oldText)) throw new Error(`edits[${i}].oldText must match exactly once`);
    return { start: first, end: first + edit.oldText.length, newText: edit.newText };
  });
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  let updated = content;
  for (const r of sorted) updated = `${updated.slice(0, r.start)}${r.newText}${updated.slice(r.end)}`;
  return updated;
}

// ─── 工具调用 ─────────────────────────────────────────────────────────────────

async function invokeTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};

  if (name === 'read') {
    const filePath = resolveToolPath(a.path);
    const ext = path.extname(filePath).toLowerCase();
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
    if (imageExts.has(ext)) {
      const binary = fs.readFileSync(filePath);
      return { path: filePath, mimeType: `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`, base64: binary.toString('base64') };
    }
    return readTextRange(filePath, a.offset, a.limit);
  }

  if (name === 'list') {
    const inputPath = a.path ? String(a.path) : '.';
    const targetPath = resolveToolPath(inputPath);
    return { path: targetPath, entries: buildListEntries(targetPath, a.all !== false, a.long !== false) };
  }

  if (name === 'write') {
    const filePath = resolveToolPath(a.path);
    if (typeof a.content !== 'string') throw new Error('content is required');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, a.content, 'utf-8');
    return { ok: true, path: filePath };
  }

  if (name === 'edit') {
    const filePath = resolveToolPath(a.path);
    const original = fs.readFileSync(filePath, 'utf-8');
    const updated = applyTextEdits(original, a.edits);
    fs.writeFileSync(filePath, updated, 'utf-8');
    return { ok: true, path: filePath };
  }

  if (name === 'exec') {
    if (typeof a.command !== 'string' || !a.command.trim()) throw new Error('command is required');
    const cwd = a.workdir ? resolveToolPath(String(a.workdir)) : appRoot;
    const env = { ...process.env, ...(a.env && typeof a.env === 'object' ? a.env : {}) };
    const timeoutMs = a.timeout ? Number(a.timeout) * 1000 : 0;
    if (a.background === true) {
      const spawned = childProcess.spawn(a.command, [], { cwd, env, shell: true, windowsHide: true, detached: true, stdio: 'ignore' });
      spawned.unref();
      return { background: true, pid: spawned.pid ?? null };
    }
    try {
      const result = await execAsync(a.command, { cwd, env, timeout: timeoutMs > 0 ? timeoutMs : undefined, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      return { exitCode: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    } catch (error) {
      return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message ?? 'exec failed' };
    }
  }

  if (name === 'web_search') {
    if (typeof a.query !== 'string' || !a.query.trim()) throw new Error('query is required');
    const count = Number(a.count ?? 5);
    try {
      const response = await axios.get('https://api.duckduckgo.com/', {
        params: { q: a.query, format: 'json', no_html: 1, no_redirect: 1 },
        timeout: 15000,
      });
      const data = response.data || {};
      return {
        query: a.query,
        abstract: data.AbstractText || '',
        answer: data.Answer || '',
        relatedTopics: Array.isArray(data.RelatedTopics)
          ? data.RelatedTopics.slice(0, count).map((item) => ({ text: item.Text, firstURL: item.FirstURL }))
          : [],
      };
    } catch {
      return { query: a.query, abstract: '', answer: '', relatedTopics: [] };
    }
  }

  throw new Error(`Unsupported tool: ${name}`);
}

// ─── Agent 配置 ───────────────────────────────────────────────────────────────

function getConfiguration() {
  const agentDir = path.resolve(appRoot, 'agent');
  const read = (file) => {
    const p = path.join(agentDir, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim() : '';
  };
  return [read('agent.md'), read('tools.md'), read('skills.md'), read('available_skills.xml')]
    .filter(Boolean).join('\n\n');
}

function getToolDefinitions() {
  const toolsJsonPath = path.resolve(appRoot, 'agent/tools.json');
  if (!fs.existsSync(toolsJsonPath)) return [];
  return JSON.parse(fs.readFileSync(toolsJsonPath, 'utf-8'));
}

// ─── LLM 调用（带工具调用循环）──────────────────────────────────────────────

function parseToolArguments(raw) {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function isSkillReadCall(toolName, args) {
  if (toolName !== 'read') return false;
  const rawPath = typeof args.path === 'string' ? args.path : '';
  const normalized = rawPath.replaceAll('\\', '/').toLowerCase();
  return normalized.includes('/skills/') && normalized.endsWith('/skill.md');
}

function formatToolStatus(toolName, args) {
  if (isSkillReadCall(toolName, args)) {
    return `调用skill: ${args.path || 'SKILL.md'}`;
  }
  return `调用tool: ${toolName}`;
}

async function callLLMWithTools(messages, tools, disableThinking = false) {
  const requestBody = {
    model: config.LLM_MODEL,
    messages,
    tools,
    tool_choice: 'auto',
    ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
  };
  const response = await axios.post(config.LLM_API_URL, requestBody, {
    headers: { Authorization: `Bearer ${config.LLM_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 180000,
  });
  const choice = response.data?.choices?.[0];
  const message = choice?.message;
  if (!message) throw new Error('LLM API 返回格式不兼容');
  return { message, finishReason: choice?.finish_reason };
}

function wsSend(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

async function generateChatReply(userMessage, onEvent = () => { }) {
  const rawTools = getToolDefinitions();
  // Replace web_search with $web_search builtin if using Moonshot API
  const isMoonshot = config.LLM_API_URL.includes('moonshot') || config.LLM_API_URL.includes('kimi');
  const tools = isMoonshot
    ? [
      ...rawTools.filter((t) => t?.function?.name !== 'web_search'),
      { type: 'builtin_function', function: { name: '$web_search' } },
    ]
    : rawTools;

  const configuration = getConfiguration();
  const messages = [
    { role: 'system', content: configuration },
    { role: 'user', content: userMessage },
  ];

  const maxToolCalls = Math.max(1, parseInt(config.MAX_TOOL_ROUNDS || '8', 10));
  const maxSkillReadCalls = Math.max(0, parseInt(config.MAX_SKILL_READ_CALLS || '3', 10));
  let toolCallsUsed = 0;
  let skillReadCallsUsed = 0;

  for (let round = 0; round < 200; round++) {
    const { message, finishReason } = await callLLMWithTools(messages, tools, isMoonshot);
    messages.push(message);

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      if (text) {
        return text;
      }
      throw new Error('LLM 未返回有效文本');
    }

    if (finishReason === 'tool_calls' && toolCalls.some((tc) => tc.function?.name === '$web_search')) {
      onEvent({ type: 'status', text: '正在调用web search工具...' });
    }

    if (toolCallsUsed >= maxToolCalls) {
      throw new Error(`工具调用总次数已达上限(${maxToolCalls})，如需继续请在 server.conf 中提高 MAX_TOOL_ROUNDS`);
    }

    const remaining = maxToolCalls - toolCallsUsed;
    const callsThisRound = toolCalls.slice(0, remaining);

    for (const toolCall of callsThisRound) {
      const toolName = toolCall.function?.name;
      if (!toolName) continue;

      const args = parseToolArguments(toolCall.function.arguments);
      toolCallsUsed++;
      onEvent({ type: 'status', text: formatToolStatus(toolName, args) });

      try {
        let result;
        if (toolName === '$web_search') {
          // Moonshot builtin: echo args back
          result = args;
        } else {
          if (isSkillReadCall(toolName, args)) {
            if (skillReadCallsUsed >= maxSkillReadCalls) {
              onEvent({ type: 'status', text: `skill读取超过上限(${maxSkillReadCalls})，跳过` });
              messages.push({
                role: 'tool', tool_call_id: toolCall.id, name: toolName,
                content: JSON.stringify({ error: `skill读取次数超过上限(${maxSkillReadCalls})` }),
              });
              continue;
            }
            skillReadCallsUsed++;
          }
          result = await invokeTool(toolName, args);
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: JSON.stringify(result) });
      } catch (error) {
        const errText = error instanceof Error ? error.message : String(error);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: JSON.stringify({ error: errText }) });
        onEvent({ type: 'status', text: `${toolName} 调用失败: ${errText}` });
      }
    }
  }

  throw new Error('工具调用总轮次超过安全上限');
}

async function handleChatMessage(ws, userMessage) {
  const text = await generateChatReply(userMessage, (payload) => wsSend(ws, payload));
  wsSend(ws, { type: 'reply', text });
}

// ─── WebSocket 广播 ───────────────────────────────────────────────────────────

let webClients = [];

function broadcastToWeb(payload) {
  const message = JSON.stringify(payload);
  webClients = webClients.filter((c) => c && c.readyState === 1);
  webClients.forEach((c) => c.send(message));
}

// ─── WebSocket 服务器 ─────────────────────────────────────────────────────────

const wsServer = require('ws').Server;
const wss = new wsServer({ noServer: true });

wss.on('connection', (ws) => {
  webClients.push(ws);

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      wsSend(ws, { type: 'error', text: '消息格式错误' });
      return;
    }

    if (msg.type === 'chat' && typeof msg.message === 'string' && msg.message.trim()) {
      try {
        await handleChatMessage(ws, msg.message.trim());
      } catch (error) {
        const errText = axios.isAxiosError(error)
          ? (error.response?.data?.error?.message || error.message)
          : (error instanceof Error ? error.message : String(error));
        wsSend(ws, { type: 'error', text: errText });
      }
    }
  });

  ws.on('close', () => {
    webClients = webClients.filter((c) => c !== ws);
  });
});

// ─── HTTP 服务器 ──────────────────────────────────────────────────────────────

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Web 消息入口（保留 HTTP 兼容接口）
app.post('/api/web/message', async (req, res) => {
  try {
    const msg = req.body;
    const userText = typeof msg?.text === 'string' ? msg.text : JSON.stringify(msg || {});
    logWrite('web.log', `[${new Date().toISOString()}] web: ${JSON.stringify(msg)}`);
    const llmReply = await generateChatReply(userText);
    const payload = { source: 'web', input: userText, reply: llmReply, ts: new Date().toISOString() };
    broadcastToWeb(payload);
    logWrite('web.log', `[${new Date().toISOString()}] llm: ${JSON.stringify(payload)}`);
    res.json({ ok: true, reply: llmReply });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWrite('web.log', `[${new Date().toISOString()}] error: ${message}`);
    res.status(500).json({ ok: false, error: message });
  }
});

// Weixin 消息入口
app.post('/api/weixin/message', async (req, res) => {
  try {
    const msg = req.body;
    const userText = typeof msg?.text === 'string' ? msg.text : JSON.stringify(msg || {});
    logWrite('weixin.log', `[${new Date().toISOString()}] weixin: ${JSON.stringify(msg)}`);
    const llmReply = await generateChatReply(userText);
    const payload = { source: 'weixin', input: userText, reply: llmReply, ts: new Date().toISOString() };
    broadcastToWeb(payload);
    logWrite('weixin.log', `[${new Date().toISOString()}] llm: ${JSON.stringify(payload)}`);
    res.json({ ok: true, reply: llmReply });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWrite('weixin.log', `[${new Date().toISOString()}] error: ${message}`);
    res.status(500).json({ ok: false, error: message });
  }
});

const port = config.port || 8080;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`LLM_API_URL=${config.LLM_API_URL}`);
  console.log(`LLM_MODEL=${config.LLM_MODEL}`);
});
