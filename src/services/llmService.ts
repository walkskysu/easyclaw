import axios from 'axios'
import { getConfig, validateConfig, type Config } from './configService'

let config: Config | null = null

type Role = 'system' | 'user' | 'assistant' | 'tool'

interface ChatMessage {
  role: Role
  content?: string | null
  tool_call_id?: string
  name?: string
  tool_calls?: ToolCall[]
  reasoning_content?: string | null
  [key: string]: unknown
}

interface ToolCall {
  id: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

interface ModelChoice {
  message?: ChatMessage
  finishReason?: string
  finish_reason?: string
}

interface ElectronToolAPI {
  getToolConfiguration: () => Promise<string>
  getToolDefinitions: () => Promise<unknown[]>
  invokeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  logWrite: (filename: string, entry: string) => Promise<void>
}

const getElectronToolAPI = (): ElectronToolAPI | null => {
  const api = (window as unknown as { electronAPI?: Partial<ElectronToolAPI> }).electronAPI
  if (!api?.getToolConfiguration || !api.getToolDefinitions || !api.invokeTool) {
    return null
  }
  return api as ElectronToolAPI
}

const makeLogFilename = (): string => {
  const now = new Date()
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  const yyyy = now.getFullYear()
  const MM = pad(now.getMonth() + 1)
  const dd = pad(now.getDate())
  const HH = pad(now.getHours())
  const mm = pad(now.getMinutes())
  const ss = pad(now.getSeconds())
  return `${yyyy}${MM}${dd}_${HH}${mm}${ss}.log`
}

const appendLog = (api: ElectronToolAPI, filename: string, tag: string, data: unknown): void => {
  const timestamp = new Date().toISOString()
  const body = JSON.stringify(data, null, 2)
  const entry = `\n[${ timestamp }] [${ tag }]\n${ body }\n${ '-'.repeat(80) }\n`
  api.logWrite(filename, entry).catch(() => undefined)
}

const toMessageText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value == null) return ''
  return JSON.stringify(value)
}

const parseToolArguments = (raw: string): Record<string, unknown> => {
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const normalizeLimit = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.floor(n)))
}

const isSkillReadCall = (toolName: string, args: Record<string, unknown>): boolean => {
  if (toolName !== 'read') {
    return false
  }

  const rawPath = typeof args.path === 'string' ? args.path : ''
  const normalizedPath = rawPath.replaceAll('\\', '/').toLowerCase()
  return normalizedPath.includes('/skills/') && normalizedPath.endsWith('/skill.md')
}

const formatToolStatus = (toolName: string, args: Record<string, unknown>): string => {
  if (isSkillReadCall(toolName, args)) {
    const path = typeof args.path === 'string' ? args.path : ''
    return `调用skill: ${path || 'SKILL.md'}`
  }

  return `调用tool: ${toolName}`
}

const invokeModel = async (
  messages: ChatMessage[],
  tools: unknown[],
  logAPI: ElectronToolAPI | null,
  logFilename: string,
): Promise<{ message: ChatMessage; finishReason: string | undefined }> => {
  if (!config || !validateConfig(config)) {
    throw new Error('LLM 未正确配置')
  }

  const requestBody = {
    model: config.LLM_MODEL,
    messages,
    tools,
    tool_choice: 'auto',
    thinking: { type: 'disabled' },
  }

  if (logAPI) appendLog(logAPI, logFilename, 'REQUEST', requestBody)

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
  )

  if (logAPI) appendLog(logAPI, logFilename, 'RESPONSE', response.data)

  const choice = response.data?.choices?.[0] as ModelChoice | undefined
  const message = choice?.message
  if (!message) {
    throw new Error('LLM API 返回格式不兼容')
  }

  return { message, finishReason: choice?.finishReason ?? choice?.finish_reason }
}

export const initializeLLMService = async (): Promise<void> => {
  const loaded = await getConfig()
  if (!validateConfig(loaded)) {
    throw new Error('LLM 配置不完整')
  }
  config = loaded
}

export const getLLMResponse = async (
  userMessage: string,
  onStatus?: (statusText: string) => void,
): Promise<string> => {
  if (!config) {
    await initializeLLMService()
  }

  if (!config || !validateConfig(config)) {
    throw new Error('LLM 未正确配置')
  }

  const toolAPI = getElectronToolAPI()
  if (!toolAPI) {
    throw new Error('工具调用接口不可用')
  }

  const logFilename = makeLogFilename()

  try {
    const [configuration, rawTools] = await Promise.all([
      toolAPI.getToolConfiguration(),
      toolAPI.getToolDefinitions(),
    ])

    // Replace custom web_search with Moonshot builtin $web_search (same pattern as example)
    const tools = [
      ...(rawTools as Array<{ type?: string; function?: { name?: string } }>).filter(
        (t) => t?.function?.name !== 'web_search',
      ),
      { type: 'builtin_function', function: { name: '$web_search' } },
    ]

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: configuration,
      },
      {
        role: 'user',
        content: userMessage,
      },
    ]

    // 两个计数器均在整个任务（一次 getLLMResponse 调用）生命周期内累计，不重置
    const maxToolCalls = normalizeLimit(config.MAX_TOOL_ROUNDS, 8, 1, 200)
    const maxSkillReadCalls = normalizeLimit(config.MAX_SKILL_READ_CALLS, 3, 0, 200)
    const hardRoundLimit = 200
    let toolCallsUsed = 0
    let skillReadCallsUsed = 0

    for (let round = 0; round < hardRoundLimit; round += 1) {
      const { message, finishReason } = await invokeModel(messages, tools, toolAPI, logFilename)
      messages.push(message)

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (toolCalls.length === 0) {
        const finalContent = toMessageText(message.content).trim()
        if (finalContent) {
          return finalContent
        }
        throw new Error('LLM 未返回有效文本')
      }

      const hasWebSearchTool = toolCalls.some(
        (toolCall) => toolCall.function?.name === '$web_search',
      )
      if (finishReason === 'tool_calls' && hasWebSearchTool) {
        onStatus?.('正在调用web search工具...')
      }

      if (toolCallsUsed >= maxToolCalls) {
        throw new Error(`工具调用总次数已达上限(${maxToolCalls})，如需继续请在配置中提高 MAX_TOOL_ROUNDS`)
      }

      const remaining = maxToolCalls - toolCallsUsed
      const callsThisRound = toolCalls.slice(0, remaining)
      if (toolCalls.length > remaining) {
        onStatus?.(`工具调用总次数剩余 ${remaining}，本轮仅执行 ${remaining} 个（共 ${toolCalls.length} 个）`)
      }

      for (const toolCall of callsThisRound) {
        const toolName = toolCall.function?.name
        if (!toolName) {
          continue
        }

        const args = parseToolArguments(toolCall.function.arguments)
        toolCallsUsed += 1
        onStatus?.(formatToolStatus(toolName, args))

        try {
          if (isSkillReadCall(toolName, args)) {
            if (skillReadCallsUsed >= maxSkillReadCalls) {
              onStatus?.(`skill读取超过上限(${maxSkillReadCalls})，本轮剩余skill调用将跳过`)
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolName,
                content: JSON.stringify({
                  error: `skill读取次数超过上限(${maxSkillReadCalls})，请减少skill读取次数或在配置中提高 MAX_SKILL_READ_CALLS`,
                }),
              })
              continue
            }
            skillReadCallsUsed += 1
          }

          let result: unknown
          if (toolName === '$web_search') {
            // Builtin function: Moonshot handles the actual search internally.
            // We just echo the arguments back as the tool result, same as search_impl(args) in the example.
            result = args
          } else {
            result = await toolAPI.invokeTool(toolName, args)
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: JSON.stringify(result),
          })
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error)
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: JSON.stringify({ error: messageText }),
          })
          onStatus?.(`${toolName} 调用失败: ${messageText}`)
        }
      }

    }

    throw new Error('工具调用总轮次超过安全上限，请调整提示词或减少循环工具调用')
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(error.response?.data?.error?.message || error.message)
    }
    throw error
  }
}
