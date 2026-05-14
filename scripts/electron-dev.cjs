const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const serverConfPath = path.join(projectRoot, 'conf', 'server.conf')

function readDevServerPort() {
    try {
        const content = fs.readFileSync(serverConfPath, 'utf-8')
        const match = content.match(/^\s*port\s*=\s*(\d+)\s*$/m)
        if (match) {
            const port = Number(match[1])
            if (Number.isFinite(port) && port > 0) {
                return port
            }
        }
    } catch {
        // Use the fallback port when the config file is not available yet.
    }

    return 5173
}

const isWindows = process.platform === 'win32'

function isPortFree(port) {
    return new Promise((resolve) => {
        const tester = net.createServer()
        tester.once('error', () => resolve(false))
        tester.once('listening', () => {
            tester.close(() => resolve(true))
        })
        tester.listen(port, '127.0.0.1')
    })
}

async function pickDevPort(preferredPort) {
    const start = Number(preferredPort) || 5173
    const maxAttempts = 30
    for (let i = 0; i < maxAttempts; i += 1) {
        const candidate = start + i
        // eslint-disable-next-line no-await-in-loop
        if (await isPortFree(candidate)) {
            return candidate
        }
    }
    throw new Error(`no free port found from ${start} to ${start + maxAttempts - 1}`)
}

function spawnNpm(scriptName, extraEnv = {}) {
    const env = {
        ...process.env,
        ...extraEnv,
    }

    if (isWindows) {
        return spawn('cmd.exe', ['/d', '/s', '/c', `npm run ${scriptName}`], {
            cwd: projectRoot,
            stdio: 'inherit',
            shell: false,
            env,
        })
    }

    return spawn('npm', ['run', scriptName], {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: false,
        env,
    })
}

function isServerAlive(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            res.resume()
            resolve(true)
        })

        req.setTimeout(1500, () => {
            req.destroy()
            resolve(false)
        })

        req.on('error', () => resolve(false))
    })
}

async function waitForDevServer(devHost, devPort, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    const targets = [
        `http://${devHost}:${devPort}`,
    ]

    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        for (const target of targets) {
            // eslint-disable-next-line no-await-in-loop
            if (await isServerAlive(target)) {
                return
            }
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 500))
    }

    throw new Error(`Timed out waiting for dev server on port ${devPort}`)
}

function main() {
    const electronProcess = spawnNpm('electron')

    electronProcess.on('error', (error) => {
        console.error('[electron-dev] failed to start electron:', error)
        process.exit(1)
    })

    const killElectron = () => {
        if (!electronProcess.killed) {
            electronProcess.kill()
        }
    }

    process.on('SIGINT', killElectron)
    process.on('SIGTERM', killElectron)

    electronProcess.on('close', (code) => {
        process.exitCode = code ?? 0
    })
}

main()