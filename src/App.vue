<template>
  <div class="app">
    <header class="header">
      <h1>LLM Chat</h1>
      <div class="header-actions">
        <button class="config-btn" :disabled="refreshingSkills" @click="refreshSkills">
          {{ refreshingSkills ? '刷新中...' : '刷新skill' }}
        </button>
        <button class="config-btn" @click="showConfig = true">配置</button>
      </div>
    </header>

    <p v-if="skillStatus" class="skill-status">{{ skillStatus }}</p>

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
        <article class="bubble bubble-ai">思考中...</article>
      </div>
    </main>

    <footer class="composer">
      <textarea v-model="inputText" class="input" placeholder="输入消息，Enter 发送，Ctrl+Enter 换行"
        @keydown.enter.exact.prevent="sendMessage" />
      <button class="send" :disabled="loading || !inputText.trim()" @click="sendMessage">
        发送
      </button>
    </footer>

    <section v-if="showConfig" class="overlay">
      <div class="modal">
        <h2>模型配置</h2>
        <label class="field">
          <span>LLM_API_URL</span>
          <input v-model="configData.LLM_API_URL" type="text"
            placeholder="https://api.openai.com/v1/chat/completions" />
        </label>
        <label class="field">
          <span>LLM_MODEL</span>
          <input v-model="configData.LLM_MODEL" type="text" placeholder="gpt-4o-mini" />
        </label>
        <label class="field">
          <span>LLM_API_KEY</span>
          <input v-model="configData.LLM_API_KEY" type="password" placeholder="sk-..." />
        </label>
        <label class="field">
          <span>MAX_TOOL_ROUNDS</span>
          <input v-model.number="configData.MAX_TOOL_ROUNDS" type="number" min="1" max="100" />
        </label>
        <label class="field">
          <span>MAX_SKILL_READ_CALLS</span>
          <input v-model.number="configData.MAX_SKILL_READ_CALLS" type="number" min="0" max="100" />
        </label>
        <div class="actions">
          <button class="ghost" type="button" @click="showConfig = false">取消</button>
          <button class="send" type="button" :disabled="savingConfig" @click="saveAndInit">
            {{ savingConfig ? '保存中...' : '保存' }}
          </button>
        </div>
        <p v-if="configError" class="config-error">{{ configError }}</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { getConfig, saveConfig, validateConfig, type Config } from './services/configService'
import { getLLMResponse, initializeLLMService } from './services/llmService'

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
}

const messages = ref<Message[]>([])
const inputText = ref('')
const loading = ref(false)
const showConfig = ref(false)
const savingConfig = ref(false)
const configError = ref('')
const messagesContainer = ref<HTMLElement | null>(null)
const refreshingSkills = ref(false)
const skillStatus = ref('')
// WeChat: track last active user to forward web/LLM messages to
const lastWechatUserId = ref<string | null>(null)
const configData = ref<Config>({
  LLM_API_URL: '',
  LLM_MODEL: '',
  LLM_API_KEY: '',
  MAX_TOOL_ROUNDS: 8,
  MAX_SKILL_READ_CALLS: 3,
})

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

const saveAndInit = async () => {
  configError.value = ''
  if (!validateConfig(configData.value)) {
    configError.value = '请检查配置：URL/模型/API Key 必填，MAX_TOOL_ROUNDS > 0，MAX_SKILL_READ_CALLS >= 0'
    return
  }

  savingConfig.value = true
  try {
    await saveConfig(configData.value)
    await initializeLLMService()
    showConfig.value = false
    pushMessage('assistant', '配置已保存，可以开始对话。')
    await scrollToBottom()
  } catch (error) {
    configError.value = `保存失败: ${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    savingConfig.value = false
  }
}

const sendMessage = async () => {
  const content = inputText.value.trim()
  if (!content || loading.value) return

  pushMessage('user', content)
  inputText.value = ''
  loading.value = true
  await scrollToBottom()

  // (2) Forward web message to WeChat with "web端：" prefix
  if (lastWechatUserId.value) {
    forwardToWechat(lastWechatUserId.value, `web端：${content}`)
  }

  try {
    const reply = await getLLMResponse(content, async (statusText) => {
      pushMessage('assistant', statusText)
      await scrollToBottom()
    })
    pushMessage('assistant', reply)
    // (3) LLM response → WeChat
    if (lastWechatUserId.value) {
      forwardToWechat(lastWechatUserId.value, reply)
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Unknown error'
    pushMessage('assistant', `请求失败: ${text}`)
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}

onMounted(async () => {
  await runRefreshSkills(true)

  const cfg = await getConfig()
  configData.value = cfg

  if (!validateConfig(cfg)) {
    showConfig.value = true
    pushMessage('assistant', '请先点击右上角“配置”，填写接口地址、模型名和 API Key。')
  } else {
    try {
      await initializeLLMService()
      pushMessage('assistant', '你好，我已连接模型，可以开始对话。')
    } catch (error) {
      showConfig.value = true
      pushMessage('assistant', `初始化失败: ${(error as Error).message}`)
    }
  }
  // (1) Register WeChat incoming message handler
  getElectronAPI()?.onWechatMessage?.(async ({ userId, text }) => {
    lastWechatUserId.value = userId
    // Show incoming WeChat message in web UI
    pushMessage('user', `[来自微信] ${text}`)
    await scrollToBottom()

    // Send to LLM and broadcast reply to both web and WeChat
    loading.value = true
    try {
      const messageWithContext = `[此消息来自微信]\n${text}`
      const reply = await getLLMResponse(messageWithContext, async (statusText) => {
        pushMessage('assistant', statusText)
        forwardToWechat(userId, statusText)
        await scrollToBottom()
      })
      pushMessage('assistant', reply)
      forwardToWechat(userId, reply)
    } catch (error) {
      const errText = error instanceof Error ? error.message : 'Unknown error'
      pushMessage('assistant', `请求失败: ${errText}`)
      forwardToWechat(userId, `请求失败: ${errText}`)
    } finally {
      loading.value = false
      await scrollToBottom()
    }
  })
  await scrollToBottom()
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

.messages {
  overflow: auto;
  padding: 16px;
}

.skill-status {
  margin: 10px 18px 0;
  font-size: 13px;
  color: #2f6f3e;
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

.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: grid;
  place-items: center;
}

.modal {
  width: min(520px, 92vw);
  background: #fff;
  border-radius: 14px;
  padding: 16px;
}

.modal h2 {
  margin: 0 0 12px;
}

.field {
  display: block;
  margin: 10px 0;
}

.field span {
  display: block;
  font-size: 12px;
  margin-bottom: 6px;
}

.field input {
  width: 100%;
  border: 1px solid #d9d9d9;
  border-radius: 8px;
  padding: 9px;
}

.actions {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.config-error {
  margin: 12px 0 0;
  color: #c62828;
  font-size: 13px;
}

.ghost {
  border: 1px solid #d9d9d9;
  border-radius: 10px;
  padding: 0 14px;
  background: #fff;
  cursor: pointer;
}
</style>
