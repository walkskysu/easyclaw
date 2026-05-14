// server.js
// Node.js 后端服务，接收 web 和 weixin 消息，转发给大模型并同步消息

const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');

const confPath = path.resolve(__dirname, '../../conf/server.conf');

function readServerConf() {
  const conf = {};
  const content = fs.readFileSync(confPath, 'utf-8');
  content.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([^#][^=]*)=(.*)$/);
    if (match) {
      conf[match[1].trim()] = match[2].trim();
    }
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

// 日志目录
const logDir = path.resolve(__dirname, '../../logs/server');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
function logWrite(filename, entry) {
  fs.appendFileSync(path.join(logDir, filename), entry + '\n', 'utf-8');
}

async function callLLM(messageText) {
  const requestBody = {
    model: config.LLM_MODEL,
    messages: [
      { role: 'user', content: String(messageText || '') },
    ],
  };

  const response = await axios.post(
    config.LLM_API_URL,
    requestBody,
    {
      headers: {
        Authorization: `Bearer ${config.LLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 180000,
    },
  );

  const text = response.data?.choices?.[0]?.message?.content;
  return typeof text === 'string' ? text : '';
}

function broadcastToWeb(payload) {
  const message = JSON.stringify(payload);
  webClients = webClients.filter((client) => client && client.readyState === 1);
  webClients.forEach((client) => {
    client.send(message);
  });
}

// 消息同步（简单内存广播，生产环境建议用消息队列）
let webClients = [];
let weixinClients = [];

// WebSocket for web client
const wsServer = require('ws').Server;
const wss = new wsServer({ noServer: true });
wss.on('connection', ws => {
  webClients.push(ws);
  ws.on('close', () => {
    webClients = webClients.filter(c => c !== ws);
  });
});


// HTTP server
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req);
  });
});

// Web 消息入口
app.post('/api/web/message', async (req, res) => {
  try {
    const msg = req.body;
    const userText = typeof msg?.text === 'string' ? msg.text : JSON.stringify(msg || {});
    logWrite('web.log', `[${new Date().toISOString()}] web: ${JSON.stringify(msg)}`);

    const llmReply = await callLLM(userText);
    const payload = {
      source: 'web',
      input: userText,
      reply: llmReply,
      ts: new Date().toISOString(),
    };

    broadcastToWeb(payload);
    logWrite('web.log', `[${new Date().toISOString()}] llm: ${JSON.stringify(payload)}`);
    // TODO: 同步到 weixin 通道
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

    const llmReply = await callLLM(userText);
    const payload = {
      source: 'weixin',
      input: userText,
      reply: llmReply,
      ts: new Date().toISOString(),
    };

    broadcastToWeb(payload);
    logWrite('weixin.log', `[${new Date().toISOString()}] llm: ${JSON.stringify(payload)}`);
    // TODO: 同步到 weixin 实际发送器
    res.json({ ok: true, reply: llmReply });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWrite('weixin.log', `[${new Date().toISOString()}] error: ${message}`);
    res.status(500).json({ ok: false, error: message });
  }
});

const port = config.port || 8080;
server.listen(port, () => {
  console.log(`HTTP server running on port ${port}`);
  console.log(`LLM config source: ${confPath}`);
  console.log(`LLM_API_URL=${config.LLM_API_URL}`);
  console.log(`LLM_MODEL=${config.LLM_MODEL}`);
});
