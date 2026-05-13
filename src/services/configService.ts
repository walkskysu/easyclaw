export interface Config {
  LLM_API_URL: string
  LLM_MODEL: string
  LLM_API_KEY: string
  MAX_TOOL_ROUNDS: number
  MAX_SKILL_READ_CALLS: number
}

interface ElectronConfigAPI {
  getConfig: () => Promise<Config>
  saveConfig: (config: Config) => Promise<{ ok: boolean; configPath: string }>
}

const defaultConfig: Config = {
  LLM_API_URL: 'https://api.openai.com/v1/chat/completions',
  LLM_MODEL: 'gpt-4o-mini',
  LLM_API_KEY: '',
  MAX_TOOL_ROUNDS: 8,
  MAX_SKILL_READ_CALLS: 3,
}

const normalizeNumber = (value: unknown, fallback: number): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    return fallback
  }
  return Math.max(0, Math.floor(n))
}

const normalizeConfig = (raw: Partial<Config> | null | undefined): Config => {
  return {
    LLM_API_URL: String(raw?.LLM_API_URL ?? defaultConfig.LLM_API_URL).trim(),
    LLM_MODEL: String(raw?.LLM_MODEL ?? defaultConfig.LLM_MODEL).trim(),
    LLM_API_KEY: String(raw?.LLM_API_KEY ?? defaultConfig.LLM_API_KEY).trim(),
    MAX_TOOL_ROUNDS: normalizeNumber(raw?.MAX_TOOL_ROUNDS, defaultConfig.MAX_TOOL_ROUNDS),
    MAX_SKILL_READ_CALLS: normalizeNumber(raw?.MAX_SKILL_READ_CALLS, defaultConfig.MAX_SKILL_READ_CALLS),
  }
}

const getElectronAPI = (): ElectronConfigAPI | null => {
  const api = (window as unknown as { electronAPI?: ElectronConfigAPI }).electronAPI
  return api ?? null
}

export const getConfig = async (): Promise<Config> => {
  const api = getElectronAPI()
  if (api) {
    const cfg = await api.getConfig()
    return normalizeConfig(cfg)
  }

  // Browser fallback for non-electron preview mode
  const stored = localStorage.getItem('llm-config')
  if (!stored) return { ...defaultConfig }

  try {
    return normalizeConfig(JSON.parse(stored) as Partial<Config>)
  } catch {
    return { ...defaultConfig }
  }
}

export const saveConfig = async (config: Config): Promise<void> => {
  const payload: Config = normalizeConfig(config)

  const api = getElectronAPI()
  if (api) {
    await api.saveConfig(payload)
    return
  }

  localStorage.setItem('llm-config', JSON.stringify(payload))
}

export const validateConfig = (config: Config): boolean => {
  return !!(
    config.LLM_API_URL?.trim() &&
    config.LLM_MODEL?.trim() &&
    config.LLM_API_KEY?.trim() &&
    Number.isFinite(config.MAX_TOOL_ROUNDS) &&
    config.MAX_TOOL_ROUNDS > 0 &&
    Number.isFinite(config.MAX_SKILL_READ_CALLS) &&
    config.MAX_SKILL_READ_CALLS >= 0
  )
}
