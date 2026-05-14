// server.js
// Node.js 后端服务，支持 HTTPS，接收 web 和 weixin 消息，转发给大模型并同步消息

const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

// 读取 server.conf
const confPath = path.resolve(__dirname, '../../conf/server.conf');
const config = {};
fs.readFileSync(confPath, 'utf-8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^\s*([^#][^=]*)=(.*)$/);
  if (m) config[m[1].trim()] = m[2].trim();
});

const app = express();
app.use(bodyParser.json());

// 日志目录
const logDir = path.resolve(__dirname, '../../logs/server');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
function logWrite(filename, entry) {
  fs.appendFileSync(path.join(logDir, filename), entry + '\n', 'utf-8');
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
  const msg = req.body;
  logWrite('web.log', `[${new Date().toISOString()}] web: ${JSON.stringify(msg)}`);
  // TODO: 调用大模型
  // TODO: 消息同步到 weixin
  res.json({ ok: true });
});

// Weixin 消息入口
app.post('/api/weixin/message', async (req, res) => {
  const msg = req.body;
  logWrite('weixin.log', `[${new Date().toISOString()}] weixin: ${JSON.stringify(msg)}`);
  // TODO: 调用大模型
  // TODO: 消息同步到 web
  res.json({ ok: true });
});

const port = config.port || 8080;
server.listen(port, () => {
  console.log(`HTTP server running on port ${port}`);
});
