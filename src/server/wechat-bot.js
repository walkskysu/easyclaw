// wechat-bot.js
// 启动微信对话 bot，并导出 bot 实例

const { WeChatBot } = require('@wechatbot/wechatbot');
const qrcodeTerminal = require('qrcode-terminal');

const bot = new WeChatBot();
const latestMsgByUserId = new Map();
let latestMsg = null;

function getErrorText(error) {
    if (!error) return 'unknown error';
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    return String(error);
}

async function startBot(options = {}) {
    const onUserMessage = typeof options.onUserMessage === 'function' ? options.onUserMessage : null;
    const creds = await bot.login({
        callbacks: {
            onQrUrl: (url) => {
                console.log('\n============================================');
                console.log('Scan this QR code in WeChat to login:');
                console.log('============================================');
                qrcodeTerminal.generate(url, { small: true });
                console.log('QR URL fallback:');
                console.log(url);
                console.log('QR login required at startup. Waiting for scan...\n');
            },
            onScanned: () => console.log('QR scanned, please confirm in WeChat'),
            onExpired: () => console.log('QR expired, requesting new one...'),
        },
    });

    if (!creds) {
        throw new Error('WeChat login failed: empty credentials');
    }

    console.log(`Logged in as ${creds.accountId}`);
    console.log(`User: ${creds.userId}`);
    console.log(`API: ${creds.baseUrl}\n`);

    bot.onMessage(async (msg) => {
        if (msg?.userId) {
            latestMsgByUserId.set(msg.userId, msg);
        }
        latestMsg = msg || null;

        if (!msg?.userId) {
            return;
        }

        const userText = typeof msg?.text === 'string' ? msg.text : '';
        await bot.sendTyping(msg.userId);

        if (!onUserMessage) {
            await bot.reply(msg, `Echo: ${userText}`);
            return;
        }

        try {
            const replyText = await onUserMessage({ msg, text: userText });
            const finalReply = typeof replyText === 'string' && replyText.trim()
                ? replyText
                : '模型未返回有效内容';
            console.log(`[WeChat][LLM][OK] userId=${msg.userId} input=${userText}`);
            await bot.reply(msg, finalReply);
        } catch (error) {
            const errText = getErrorText(error);
            console.error(`[WeChat][LLM][Error] userId=${msg.userId} input=${userText} error=${errText}`);
            await bot.reply(msg, `大模型调用失败: ${errText}`);
        }
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
