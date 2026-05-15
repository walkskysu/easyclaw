<template>
  <div class="app">
    <header class="header">
      <h1>LLM Chat</h1>
      <div class="header-actions">
        <span class="conn-status" :class="connected ? 'conn-ok' : 'conn-err'">
          {{ connected ? '已连接服务器' : (connecting ? '连接中...' : '未连接') }}
        </span>
        <button class="config-btn" :disabled="configLoading || savingConfig" @click="openConfigDialog">
          {{ configLoading ? '读取中...' : '配置' }}
        </button>
        <button class="config-btn" :disabled="refreshingSkills" @click="refreshSkills">
          {{ refreshingSkills ? '刷新中...' : '刷新skill' }}
        </button>
      </div>
    </header>

    <p v-if="skillStatus" class="skill-status">{{ skillStatus }}</p>

    <div v-if="showConfigDialog" class="dialog-mask" @click.self="closeConfigDialog">
      <section class="dialog-card">
        <div class="dialog-header">
          <h2>客户端配置</h2>
          <button class="dialog-close" :disabled="savingConfig" @click="closeConfigDialog">关闭</button>
        </div>

        <label class="form-field">
          <span>Server 地址</span>
          <input v-model.trim="configForm.SERVER_URL" class="form-input" placeholder="http://localhost:8080" />
        </label>
        <label class="form-field">
          <span>LLM API URL</span>
          <input v-model.trim="configForm.LLM_API_URL" class="form-input" placeholder="https://api.openai.com/v1/chat/completions" />
        </label>
        <label class="form-field">
          <span>模型名称</span>
          <input v-model.trim="configForm.LLM_MODEL" class="form-input" placeholder="gpt-4o-mini" />
        </label>
        <label class="form-field">
          <span>API Key</span>
          <input v-model.trim="configForm.LLM_API_KEY" type="password" class="form-input" placeholder="your-api-key" />
        </label>
        <label class="form-field">
          <span>最大工具调用轮次</span>
          <input v-model.number="configForm.MAX_TOOL_ROUNDS" type="number" min="1" class="form-input" />
        </label>
        <label class="form-field">
          <span>最大 Skill 读取次数</span>
          <input v-model.number="configForm.MAX_SKILL_READ_CALLS" type="number" min="0" class="form-input" />
        </label>

        <p v-if="configStatus" class="config-status">{{ configStatus }}</p>

        <div class="dialog-actions">
          <button class="ghost-btn" :disabled="savingConfig" @click="closeConfigDialog">取消</button>
          <button class="save-btn" :disabled="savingConfig" @click="submitConfig">
            {{ savingConfig ? '保存中...' : '保存配置' }}
          </button>
        </div>
      </section>
    </div>

    <main ref="messagesContainer" class="messages">
      <div v-for="(msg, index) in messages" :key="index" class="row"
        :class="msg.role === 'user' ? 'row-user' : 'row-ai'">
        <div class="message-block" :class="msg.role === 'user' ? 'message-block-user' : 'message-block-ai'">
          <article class="bubble" :class="msg.role === 'user' ? 'bubble-user' : 'bubble-ai'">
            <div class="md" v-html="renderMarkdown(msg.content)"></div>
          </article>
          <div class="bubble-time">{{ msg.timestamp }}</div>
        </div>
      </div>
      <div v-if="loading" class="row row-ai">
        <article class="bubble bubble-ai">{{ statusText || '思考中...' }}</article>
      </div>
    </main>

    <footer class="composer">
      <textarea v-model="inputText" class="input" placeholder="输入消息，Enter 发送，Ctrl+Enter 换行"
        :disabled="!connected || loading"
        @keydown.enter.exact.prevent="sendMessage" />
      <button class="send" :disabled="!connected || loading || !inputText.trim()" @click="sendMessage">
        发送
      </button>
    </footer>

  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { createDefaultConfig, getConfig, getServerUrl, saveConfig, validateConfig, type Config } from './services/configService'

interface Message {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

interface RefreshSkillsResult {
  ok: boolean
  count: number
  path: string
}

interface AppElectronAPI {
  refreshAvailableSkills?: () => Promise<RefreshSkillsResult>
  onWechatMessage?: (callback: (data: { userId: string; text: string }) => void) => void
  sendToWechat?: (userId: string, text: string) => Promise<{ ok: boolean; error?: string }>
  getServerUrl?: () => Promise<string>
}

const messages = ref<Message[]>([])
const inputText = ref('')
const loading = ref(false)
const statusText = ref('')
const connected = ref(false)
const connecting = ref(false)
const messagesContainer = ref<HTMLElement | null>(null)
const refreshingSkills = ref(false)
const skillStatus = ref('')
const lastWechatUserId = ref<string | null>(null)
const showConfigDialog = ref(false)
const configLoading = ref(false)
const savingConfig = ref(false)
const configStatus = ref('')
const configForm = ref<Config>(createDefaultConfig())

let ws: WebSocket | null = null

marked.setOptions({ breaks: true, gfm: true })

const renderMarkdown = (content: string) => DOMPurify.sanitize(marked.parse(content) as string)

const formatTimestamp = (): string => {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

const pushMessage = (role: 'user' | 'assistant', content: string) => {
  messages.value.push({
    role,
    content,
    timestamp: formatTimestamp(),
  })
}

const getElectronAPI = () =>
  (window as unknown as { electronAPI?: AppElectronAPI }).electronAPI

const forwardToWechat = (userId: string, text: string) => {
  getElectronAPI()?.sendToWechat?.(userId, text)
}

const runRefreshSkills = async (silent = false) => {
  if (refreshingSkills.value) return

  const api = getElectronAPI()
  if (!api?.refreshAvailableSkills) {
    skillStatus.value = '当前环境不支持刷新skill。'
    return
  }

  refreshingSkills.value = true
  skillStatus.value = ''

  try {
    const result = await api.refreshAvailableSkills()
    if (!silent) {
      skillStatus.value = `已刷新 ${result.count} 个skill。`
    }
  } catch (error) {
    skillStatus.value = `刷新失败: ${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    refreshingSkills.value = false
  }
}

const refreshSkills = async () => {
  await runRefreshSkills(false)
}

const scrollToBottom = async () => {
  await nextTick()
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

const closeCurrentSocket = () => {
  if (ws) {
    ws.close()
    ws = null
  }
  connected.value = false
  connecting.value = false
  loading.value = false
  statusText.value = ''
}

const closeConfigDialog = () => {
  if (savingConfig.value) return
  showConfigDialog.value = false
  configStatus.value = ''
}

const openConfigDialog = async () => {
  if (configLoading.value) return

  configLoading.value = true
  configStatus.value = ''
  showConfigDialog.value = true

  try {
    configForm.value = await getConfig()
  } catch (error) {
    configStatus.value = `读取配置失败: ${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    configLoading.value = false
  }
}

const submitConfig = async () => {
  if (savingConfig.value) return

  if (!validateConfig(configForm.value)) {
    configStatus.value = '配置不完整，请检查 Server 地址、模型地址、模型名、API Key 和次数限制。'
    return
  }

  savingConfig.value = true
  configStatus.value = ''

  try {
    await saveConfig(configForm.value)
    closeCurrentSocket()
    connectWebSocket(configForm.value.SERVER_URL)
    showConfigDialog.value = false
    skillStatus.value = '配置已保存。'
    pushMessage('assistant', `配置已保存，已切换到服务器 ${configForm.value.SERVER_URL}。如模型配置已变更，请确认 server 端已加载最新配置。`)
    await scrollToBottom()
  } catch (error) {
    configStatus.value = `保存失败: ${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    savingConfig.value = false
  }
}

// ─── WebSocket 连接 ────────────────────────────────────────────────────────────

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
}

function connectWebSocket(serverUrl: string) {
  connecting.value = true
  connected.value = false
  statusText.value = ''

  const wsUrl = toWsUrl(serverUrl)
  const socket = new WebSocket(wsUrl)
  ws = socket

  socket.onopen = () => {
    connected.value = true
    connecting.value = false
    pushMessage('assistant', `已连接服务器 ${serverUrl}，可以开始对话。`)
    scrollToBottom()
  }

  socket.onerror = () => {
    if (ws === socket) {
      connected.value = false
      connecting.value = false
      pushMessage('assistant', `无法连接服务器 ${serverUrl}，请确认服务器已启动并检查 conf/client.conf 配置。`)
      scrollToBottom()
    }
  }

  socket.onclose = () => {
    if (ws === socket) {
      connected.value = false
      connecting.value = false
      loading.value = false
    }
  }

  socket.onmessage = async (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string) as { type: string; text: string }
      if (msg.type === 'status') {
        statusText.value = msg.text
      } else if (msg.type === 'reply') {
        loading.value = false
        statusText.value = ''
        pushMessage('assistant', msg.text)
        if (lastWechatUserId.value) {
          forwardToWechat(lastWechatUserId.value, msg.text)
        }
        await scrollToBottom()
      } else if (msg.type === 'error') {
        loading.value = false
        statusText.value = ''
        pushMessage('assistant', `请求失败: ${msg.text}`)
        await scrollToBottom()
      }
    } catch {
      // ignore malformed messages
    }
  }
}

const sendMessage = async () => {
  const content = inputText.value.trim()
  if (!content || loading.value || !connected.value || !ws) return

  pushMessage('user', content)
  inputText.value = ''
  loading.value = true
  statusText.value = ''
  await scrollToBottom()

  // Forward web message to WeChat with "web端：" prefix
  if (lastWechatUserId.value) {
    forwardToWechat(lastWechatUserId.value, `web端：${content}`)
  }

  ws.send(JSON.stringify({ type: 'chat', message: content }))
}

onMounted(async () => {
  await runRefreshSkills(true)

  // 读取 client.conf 中的服务器地址并建立 WebSocket 连接
  try {
    const serverUrl = await getServerUrl()
    connectWebSocket(serverUrl)
  } catch (error) {
    pushMessage('assistant', `无法读取服务器配置: ${(error as Error).message}`)
  }

  // Register WeChat incoming message handler
  getElectronAPI()?.onWechatMessage?.(async ({ userId, text }) => {
    lastWechatUserId.value = userId
    pushMessage('user', `[来自微信] ${text}`)
    await scrollToBottom()

    if (connected.value && ws) {
      loading.value = true
      statusText.value = ''
      ws.send(JSON.stringify({ type: 'chat', message: `[此消息来自微信]\n${text}` }))
    } else {
      pushMessage('assistant', '服务器未连接，无法处理微信消息。')
      await scrollToBottom()
    }
  })
  await scrollToBottom()
})

onUnmounted(() => {
  closeCurrentSocket()
})
</script>

<style scoped>
.app {
  height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background: #fff;
  color: #202020;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid #ececec;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.header h1 {
  margin: 0;
  font-size: 18px;
}

.config-btn {
  border: 1px solid #d0d0d0;
  background: #fff;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
}

.config-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.conn-status {
  font-size: 13px;
  padding: 6px 10px;
  border-radius: 8px;
}

.conn-ok {
  background: #e6f7ec;
  color: #1a7a38;
}

.conn-err {
  background: #fdecea;
  color: #c62828;
}

.messages {
  overflow: auto;
  padding: 16px;
}

.skill-status {
  margin: 10px 18px 0;
  font-size: 13px;
  color: #2f6f3e;
}

.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 10;
}

.dialog-card {
  width: min(560px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  background: #fff;
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.18);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.dialog-header h2 {
  margin: 0;
  font-size: 18px;
}

.dialog-close,
.ghost-btn {
  border: 1px solid #d0d0d0;
  background: #fff;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
}

.form-field {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 14px;
}

.form-input {
  border: 1px solid #d9d9d9;
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
}

.config-status {
  margin: 6px 0 0;
  font-size: 13px;
  color: #c62828;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

.save-btn {
  border: 0;
  border-radius: 8px;
  padding: 8px 14px;
  background: #2ca34a;
  color: #fff;
  cursor: pointer;
}

.save-btn:disabled,
.dialog-close:disabled,
.ghost-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.row {
  display: flex;
  margin-bottom: 10px;
}

.row-user {
  justify-content: flex-end;
}

.row-ai {
  justify-content: flex-start;
}

.message-block {
  display: flex;
  flex-direction: column;
}

.message-block-user {
  align-items: flex-end;
}

.message-block-ai {
  align-items: flex-start;
}

.bubble {
  max-width: min(75%, 760px);
  border-radius: 14px;
  padding: 10px 12px;
  line-height: 1.55;
  word-break: break-word;
}

.bubble-ai {
  background: #d9d9d9;
  color: #111;
}

.bubble-user {
  background: #2ca34a;
  color: #fff;
}

.bubble-time {
  margin-top: 4px;
  font-size: 11px;
  color: #999;
}

.md :deep(p) {
  margin: 0 0 8px;
}

.md :deep(p:last-child) {
  margin-bottom: 0;
}

.md :deep(pre) {
  background: rgba(0, 0, 0, 0.18);
  border-radius: 8px;
  padding: 10px;
  overflow: auto;
}

.md :deep(code) {
  font-family: Consolas, 'Courier New', monospace;
}

.composer {
  border-top: 1px solid #ececec;
  padding: 12px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
}

.input {
  min-height: 72px;
  max-height: 180px;
  resize: vertical;
  border: 1px solid #d9d9d9;
  border-radius: 10px;
  padding: 10px;
  font: inherit;
}

.send {
  align-self: end;
  height: 42px;
  border: 0;
  border-radius: 10px;
  background: #2ca34a;
  color: #fff;
  padding: 0 16px;
  cursor: pointer;
}

.send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

</style>
