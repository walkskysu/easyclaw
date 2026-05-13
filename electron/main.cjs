const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const util = require('node:util')
const axios = require('axios')

const execAsync = util.promisify(childProcess.exec)

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(rendererDevUrl)
let mainWindow = null

// WeChat bot state
let wechatBot = null
// Map<userId, msg> — keep the latest msg object per user for targeted replies
const wechatUserMap = new Map()
// Track the most recent WeChat sender for file replies
let lastWechatUserId = null

async function startWeChatBot() {
    try {
        const { WeChatBot } = await import('@wechatbot/wechatbot')
        wechatBot = new WeChatBot()
        await wechatBot.login()

        wechatBot.onMessage(async (msg) => {
            wechatUserMap.set(msg.userId, msg)
            lastWechatUserId = msg.userId
            if (mainWindow) {
                mainWindow.webContents.send('wechat:incoming', {
                    userId: msg.userId,
                    text: msg.text,
                })
            }
        })

        await wechatBot.start()
        console.log('[WeChatBot] Started successfully')
    } catch (err) {
        console.error('[WeChatBot] Failed to start:', err.message ?? err)
    }
}

ipcMain.handle('wechat:send', async (_event, payload) => {
    if (!wechatBot) return { ok: false, error: 'bot not running' }
    const { userId, text } = payload ?? {}
    if (!userId || typeof text !== 'string') return { ok: false, error: 'invalid payload' }
    try {
        await wechatBot.send(userId, text)
        return { ok: true }
    } catch (err) {
        return { ok: false, error: String(err) }
    }
})

// Some Windows environments crash the GPU process; force software rendering for stability.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-software-rasterizer')

function getConfigPath() {
    return path.join(app.getPath('userData'), 'llm.config.json')
}

function getAppRootPath() {
    return path.resolve(__dirname, '..')
}

function getAgentDirPath() {
    return path.join(getAppRootPath(), 'agent')
}

function getSkillsDirPath() {
    return path.join(getAppRootPath(), 'skills')
}

function xmlEscape(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;')
}

function stripWrappingQuotes(value) {
    const text = String(value ?? '').trim()
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1).trim()
    }
    return text
}

function parseSkillMetadata(skillContent, fallbackName) {
    const normalized = String(skillContent ?? '').replace(/\r\n/g, '\n')
    const frontmatterMatch = normalized.match(/(?:^|\n)---\n([\s\S]*?)\n---(?:\n|$)/)

    let name = ''
    let description = ''

    if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1]
        const nameMatch = frontmatter.match(/^\s*name\s*:\s*(.+)$/m)
        const descriptionMatch = frontmatter.match(/^\s*description\s*:\s*(.+)$/m)
        if (nameMatch) {
            name = stripWrappingQuotes(nameMatch[1])
        }
        if (descriptionMatch) {
            description = stripWrappingQuotes(descriptionMatch[1])
        }
    }

    if (!name) {
        const headingMatch = normalized.match(/^#\s+(.+)$/m)
        if (headingMatch) {
            name = headingMatch[1].trim()
        }
    }

    if (!description) {
        const lines = normalized.split('\n')
        for (const rawLine of lines) {
            const line = rawLine.trim()
            if (!line || line.startsWith('---') || line.startsWith('#') || line.startsWith('```')) {
                continue
            }
            description = line
            break
        }
    }

    if (!name) {
        name = fallbackName
    }

    if (!description) {
        description = `${name} skill`
    }

    return { name, description }
}

function buildAvailableSkillsXml() {
    const skillsDir = getSkillsDirPath()
    if (!fs.existsSync(skillsDir)) {
        return {
            xml: '<available_skills>\n</available_skills>\n',
            count: 0,
        }
    }

    const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b))

    const skills = []
    for (const dirName of skillDirs) {
        const skillMdPath = path.join(skillsDir, dirName, 'SKILL.md')
        if (!fs.existsSync(skillMdPath)) {
            continue
        }

        const content = fs.readFileSync(skillMdPath, 'utf-8')
        const { name, description } = parseSkillMetadata(content, dirName)
        skills.push({
            name,
            description,
            location: skillMdPath,
        })
    }

    const lines = ['<available_skills>']
    for (const skill of skills) {
        lines.push('  <skill>')
        lines.push(`    <name>${xmlEscape(skill.name)}</name>`)
        lines.push(`    <description>${xmlEscape(skill.description)}</description>`)
        lines.push(`    <location>${xmlEscape(skill.location)}</location>`)
        lines.push('  </skill>')
    }
    lines.push('</available_skills>')

    return {
        xml: `${lines.join('\n')}\n`,
        count: skills.length,
    }
}

function resolveToolPath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
        throw new Error('path is required')
    }

    const appRoot = getAppRootPath()
    const candidate = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(appRoot, inputPath)

    const relative = path.relative(appRoot, candidate)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('path is outside workspace root')
    }

    return candidate
}

function applyTextEdits(content, edits) {
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error('edits must be a non-empty array')
    }

    const ranges = edits.map((edit, index) => {
        if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
            throw new Error(`edits[${index}] is invalid`)
        }

        const first = content.indexOf(edit.oldText)
        if (first < 0) {
            throw new Error(`edits[${index}].oldText not found`)
        }

        const last = content.lastIndexOf(edit.oldText)
        if (first !== last) {
            throw new Error(`edits[${index}].oldText must match exactly once`)
        }

        return {
            start: first,
            end: first + edit.oldText.length,
            oldText: edit.oldText,
            newText: edit.newText,
        }
    })

    const sortedByStart = [...ranges].sort((a, b) => a.start - b.start)
    for (let i = 1; i < sortedByStart.length; i += 1) {
        if (sortedByStart[i].start < sortedByStart[i - 1].end) {
            throw new Error('edits contain overlapping ranges')
        }
    }

    let updated = content
    const sortedByReverse = [...ranges].sort((a, b) => b.start - a.start)
    for (const range of sortedByReverse) {
        updated = `${updated.slice(0, range.start)}${range.newText}${updated.slice(range.end)}`
    }

    return updated
}

function buildListEntries(targetPath, includeHidden, longFormat) {
    const stat = fs.statSync(targetPath)
    const basename = path.basename(targetPath)

    if (!stat.isDirectory()) {
        if (longFormat) {
            return [{
                name: basename,
                path: targetPath,
                type: 'file',
                size: stat.size,
                mtime: stat.mtime.toISOString(),
            }]
        }

        return [basename]
    }

    const dirents = fs.readdirSync(targetPath, { withFileTypes: true })
    const filtered = dirents.filter((entry) => includeHidden || !entry.name.startsWith('.'))

    if (!longFormat) {
        return filtered.map((entry) => entry.name)
    }

    return filtered.map((entry) => {
        const fullPath = path.join(targetPath, entry.name)
        const entryStat = fs.statSync(fullPath)
        return {
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: entryStat.size,
            mtime: entryStat.mtime.toISOString(),
        }
    })
}

const MAX_READ_BYTES = 50 * 1024 // 50KB
const MAX_READ_LINES = 2000

function readTextRange(filePath, offset, limit) {
    const fullText = fs.readFileSync(filePath, 'utf-8')
    const lines = fullText.split(/\r?\n/)
    const start = Math.max(0, Number(offset ?? 1) - 1)
    const maxLines = Math.max(1, Number(limit ?? MAX_READ_LINES))

    const selected = []
    let byteCount = 0
    let truncatedBySize = false
    for (let i = start; i < lines.length && selected.length < maxLines; i++) {
        const lineBytes = Buffer.byteLength(lines[i], 'utf-8') + 1 // +1 for newline
        if (byteCount + lineBytes > MAX_READ_BYTES) {
            truncatedBySize = true
            break
        }
        selected.push(lines[i])
        byteCount += lineBytes
    }

    return {
        path: filePath,
        offset: start + 1,
        lines: selected.length,
        content: selected.join('\n'),
        truncated: truncatedBySize || start + selected.length < lines.length,
    }
}

async function invokeTool(name, args) {
    const safeArgs = args && typeof args === 'object' ? args : {}

    if (name === 'read') {
        const filePath = resolveToolPath(safeArgs.path)
        const ext = path.extname(filePath).toLowerCase()
        const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
        if (imageExts.has(ext)) {
            const binary = fs.readFileSync(filePath)
            return {
                path: filePath,
                mimeType: `image/${ext === '.jpg' ? 'jpeg' : ext.slice(1)}`,
                base64: binary.toString('base64'),
            }
        }
        return readTextRange(filePath, safeArgs.offset, safeArgs.limit)
    }

    if (name === 'list') {
        const inputPath = safeArgs.path ? String(safeArgs.path) : '.'
        const targetPath = resolveToolPath(inputPath)
        const includeHidden = safeArgs.all !== false
        const longFormat = safeArgs.long !== false
        return {
            path: targetPath,
            entries: buildListEntries(targetPath, includeHidden, longFormat),
        }
    }

    if (name === 'write') {
        const filePath = resolveToolPath(safeArgs.path)
        if (typeof safeArgs.content !== 'string') {
            throw new Error('content is required')
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, safeArgs.content, 'utf-8')
        return { ok: true, path: filePath }
    }

    if (name === 'edit') {
        const filePath = resolveToolPath(safeArgs.path)
        const original = fs.readFileSync(filePath, 'utf-8')
        const updated = applyTextEdits(original, safeArgs.edits)
        fs.writeFileSync(filePath, updated, 'utf-8')
        return { ok: true, path: filePath }
    }

    if (name === 'exec') {
        if (typeof safeArgs.command !== 'string' || !safeArgs.command.trim()) {
            throw new Error('command is required')
        }

        const cwd = safeArgs.workdir
            ? resolveToolPath(String(safeArgs.workdir))
            : getAppRootPath()
        const AGENT_BROWSER_MAX_TIMEOUT_MS = 20000
        const isAgentBrowserCommand = /(?:^|\s|[;&|])agent-browser(?:\s|$)/.test(safeArgs.command)
        const requestedTimeoutMs = safeArgs.timeout ? Number(safeArgs.timeout) * 1000 : 0
        const timeoutMs = isAgentBrowserCommand
            ? (requestedTimeoutMs > 0 ? Math.min(requestedTimeoutMs, AGENT_BROWSER_MAX_TIMEOUT_MS) : AGENT_BROWSER_MAX_TIMEOUT_MS)
            : requestedTimeoutMs
        const env = {
            ...process.env,
            ...(safeArgs.env && typeof safeArgs.env === 'object' ? safeArgs.env : {}),
        }
        const usePty = safeArgs.pty === true
        const spawnOpts = {
            cwd,
            env,
            shell: true, // enables basic TTY-like behaviour for pty mode
            windowsHide: true,
        }

        // background: fire-and-forget, return pid immediately
        if (safeArgs.background === true) {
            const spawned = childProcess.spawn(safeArgs.command, [], {
                ...spawnOpts,
                detached: true,
                stdio: 'ignore',
            })
            spawned.unref()
            return { background: true, pid: spawned.pid ?? null }
        }

        // yieldMs: wait up to N ms, then background the process and return partial output
        const yieldMs = safeArgs.yieldMs != null ? Number(safeArgs.yieldMs) : null
        if (yieldMs !== null && yieldMs > 0) {
            return new Promise((resolve) => {
                let stdoutBuf = ''
                let stderrBuf = ''
                const spawned = childProcess.spawn(safeArgs.command, [], spawnOpts)
                spawned.stdout?.on('data', (d) => { stdoutBuf += d.toString() })
                spawned.stderr?.on('data', (d) => { stderrBuf += d.toString() })

                let settled = false
                const settle = (exitCode, backgrounded) => {
                    if (settled) return
                    settled = true
                    resolve({
                        exitCode: exitCode ?? null,
                        stdout: stdoutBuf,
                        stderr: stderrBuf,
                        backgrounded: backgrounded ?? false,
                    })
                }

                spawned.on('close', (code) => settle(code, false))
                spawned.on('error', (err) => {
                    stderrBuf += err.message
                    settle(1, false)
                })

                setTimeout(() => {
                    if (!settled) {
                        spawned.unref() // let it keep running in background
                        settle(null, true)
                    }
                }, yieldMs)
            })
        }

        // default: wait for completion
        try {
            const result = await execAsync(safeArgs.command, {
                cwd,
                env,
                timeout: timeoutMs > 0 ? timeoutMs : undefined,
                windowsHide: true,
                maxBuffer: 2 * 1024 * 1024,
                ...(usePty ? { shell: true } : {}),
            })

            return {
                exitCode: 0,
                stdout: result.stdout ?? '',
                stderr: result.stderr ?? '',
            }
        } catch (error) {
            return {
                exitCode: typeof error.code === 'number' ? error.code : 1,
                stdout: error.stdout ?? '',
                stderr: error.stderr ?? error.message ?? 'exec failed',
            }
        }
    }

    if (name === 'send_file_to_wechat') {
        if (typeof safeArgs.path !== 'string' || !safeArgs.path.trim()) {
            throw new Error('path is required')
        }

        const filePath = resolveToolPath(safeArgs.path)
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`)
        }

        if (!wechatBot) {
            throw new Error('WeChat bot is not running')
        }

        const resolvedUserId = (typeof safeArgs.userId === 'string' && safeArgs.userId.trim())
            ? safeArgs.userId.trim()
            : lastWechatUserId
        if (!resolvedUserId) {
            throw new Error('No WeChat user context available')
        }

        const msg = wechatUserMap.get(resolvedUserId)
        if (!msg) {
            throw new Error(`No message context found for userId: ${resolvedUserId}`)
        }

        const ext = path.extname(filePath).toLowerCase()
        const fileData = fs.readFileSync(filePath)
        const fileName = path.basename(filePath)

        // Detect file type and send accordingly
        const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
        const videoExts = new Set(['.mp4', '.mov', '.webm'])

        try {
            await wechatBot.reply(msg, { file: fileData, fileName })
            return {
                ok: true,
                userId: resolvedUserId,
                filePath,
                fileName,
                type: imageExts.has(ext) ? 'image' : videoExts.has(ext) ? 'video' : 'file',
            }
        } catch (err) {
            throw new Error(`Failed to send file: ${err.message ?? err}`)
        }
    }

    if (name === 'web_search') {
        if (typeof safeArgs.query !== 'string' || !safeArgs.query.trim()) {
            throw new Error('query is required')
        }

        const count = Number(safeArgs.count ?? 5)
        const moonshotApiKey = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY
        if (moonshotApiKey) {
            const moonshotResponse = await axios.post(
                'https://api.moonshot.cn/v1/chat/completions',
                {
                    model: process.env.MOONSHOT_MODEL || 'kimi-k2-latest',
                    messages: [
                        {
                            role: 'user',
                            content: `Use web search to answer this query and include concise citations. Query: ${safeArgs.query}`,
                        },
                    ],
                    temperature: 0.2,
                },
                {
                    headers: {
                        Authorization: `Bearer ${moonshotApiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 20000,
                },
            )

            return {
                query: safeArgs.query,
                source: 'moonshot',
                content: moonshotResponse.data?.choices?.[0]?.message?.content || '',
            }
        }

        const response = await axios.get('https://api.duckduckgo.com/', {
            params: {
                q: safeArgs.query,
                format: 'json',
                no_html: 1,
                no_redirect: 1,
            },
            timeout: 15000,
        })

        const data = response.data || {}
        return {
            query: safeArgs.query,
            source: 'duckduckgo',
            abstract: data.AbstractText || '',
            answer: data.Answer || '',
            relatedTopics: Array.isArray(data.RelatedTopics)
                ? data.RelatedTopics.slice(0, count).map((item) => ({
                    text: item.Text,
                    firstURL: item.FirstURL,
                }))
                : [],
        }
    }

    throw new Error(`Unsupported tool: ${name}`)
}

function ensureConfig() {
    const configPath = getConfigPath()
    if (!fs.existsSync(configPath)) {
        const defaults = {
            LLM_API_URL: 'https://api.openai.com/v1/chat/completions',
            LLM_MODEL: 'gpt-4o-mini',
            LLM_API_KEY: '',
            MAX_TOOL_ROUNDS: 8,
            MAX_SKILL_READ_CALLS: 3,
        }
        fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), 'utf-8')
    }
    return configPath
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 760,
        backgroundColor: '#ffffff',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    })

    if (isDev) {
        mainWindow.loadURL(rendererDevUrl)
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
    }

    mainWindow.on('closed', () => {
        mainWindow = null
    })
}

ipcMain.handle('config:get', async () => {
    const configPath = ensureConfig()
    const raw = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(raw)
})

ipcMain.handle('config:save', async (_event, config) => {
    const configPath = ensureConfig()
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return { ok: true, configPath }
})

ipcMain.handle('config:path', async () => {
    return ensureConfig()
})

function getLogsDirPath() {
    return path.join(getAppRootPath(), 'logs')
}

ipcMain.handle('log:write', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') return
    const { filename, entry } = payload
    if (typeof filename !== 'string' || typeof entry !== 'string') return
    const logsDir = getLogsDirPath()
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true })
    }
    const logPath = path.join(logsDir, filename)
    fs.appendFileSync(logPath, entry, 'utf-8')
})

ipcMain.handle('tools:getConfiguration', async () => {
    const agentDir = getAgentDirPath()
    const agentMdPath = path.join(agentDir, 'agent.md')
    const toolsMdPath = path.join(agentDir, 'tools.md')
    const skillsMdPath = path.join(agentDir, 'skills.md')
    const availableSkillsPath = path.join(agentDir, 'available_skills.xml')
    const agentContent = fs.readFileSync(agentMdPath, 'utf-8')
    const toolsContent = fs.readFileSync(toolsMdPath, 'utf-8')
    const skillsContent = fs.existsSync(skillsMdPath)
        ? fs.readFileSync(skillsMdPath, 'utf-8')
        : ''
    const availableSkillsContent = fs.existsSync(availableSkillsPath)
        ? fs.readFileSync(availableSkillsPath, 'utf-8')
        : ''

    return [
        agentContent.trim(),
        toolsContent.trim(),
        skillsContent.trim(),
        availableSkillsContent.trim(),
    ].filter(Boolean).join('\n\n')
})

ipcMain.handle('skills:refresh', async () => {
    const availableSkillsPath = path.join(getAgentDirPath(), 'available_skills.xml')
    const { xml, count } = buildAvailableSkillsXml()
    fs.writeFileSync(availableSkillsPath, xml, 'utf-8')
    return {
        ok: true,
        count,
        path: availableSkillsPath,
    }
})

ipcMain.handle('tools:getDefinitions', async () => {
    const toolsJsonPath = path.join(getAgentDirPath(), 'tools.json')
    const raw = fs.readFileSync(toolsJsonPath, 'utf-8')
    return JSON.parse(raw)
})

ipcMain.handle('tools:invoke', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
        throw new Error('payload is required')
    }
    const name = payload.name
    if (typeof name !== 'string' || !name) {
        throw new Error('tool name is required')
    }

    const result = await invokeTool(name, payload.arguments)
    return result
})

app.whenReady().then(async () => {
    ensureConfig()
    createWindow()
    // Start WeChat bot in background; app works even if bot login is pending/fails
    startWeChatBot()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
