// wechat-bot.js
// 启动微信对话 bot，并导出 bot 实例

const { WeChatBot } = require('@wechatbot/wechatbot');

const bot = new WeChatBot();
const latestMsgByUserId = new Map();
let latestMsg = null;

async function startBot() {
    await bot.login();
    bot.onMessage(async (msg) => {
        if (msg?.userId) {
            latestMsgByUserId.set(msg.userId, msg);
        }
        latestMsg = msg || null;
        await bot.sendTyping(msg.userId);
        await bot.reply(msg, `Echo: ${msg.text}`);
    });
    await bot.start();
    console.log('WeChatBot started');
}

function getLatestWechatMessage(userId) {
    if (userId) {
        return latestMsgByUserId.get(String(userId)) || null;
    }
    return latestMsg;
}

module.exports = { bot, startBot, getLatestWechatMessage };
