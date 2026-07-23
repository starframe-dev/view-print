import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DaemonClient } from './daemon-client.js'
import { isProcessAlive, killProcessTree } from './process-tree.js'

const pidFilePath = path.join(os.homedir(), '.viewprint', 'daemon.pid')

export interface StartDaemonOptions {
    port: number
    idleTimeoutMs?: number
}

export function getDaemonPort(): number {
    const envPort = process.env.VIEWPRINT_PORT
    if (envPort) {
        return parseInt(envPort, 10)
    }
    return 7345
}

export function getPidFilePath(): string {
    return pidFilePath
}

export function getIdleTimeoutFromEnv(): number | undefined {
    const env = process.env.VIEWPRINT_IDLE_TIMEOUT_MS
    if (env === undefined) {
        return undefined
    }
    const value = parseInt(env, 10)
    if (isNaN(value)) {
        return undefined
    }
    return value
}

export async function isDaemonRunning(port = getDaemonPort()): Promise<boolean> {
    const client = new DaemonClient({ port })
    const healthy = await client.health()
    if (!healthy) {
        return false
    }

    if (!fs.existsSync(pidFilePath)) {
        return false
    }

    const pid = parseInt(fs.readFileSync(pidFilePath, 'utf-8').trim(), 10)
    return isProcessAlive(pid)
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    for (let i = 0; i < Math.ceil(timeoutMs / 100); i++) {
        if (!isProcessAlive(pid)) {
            return true
        }
        await delay(100)
    }
    return !isProcessAlive(pid)
}

export async function ensureDaemonRunning(port = getDaemonPort()): Promise<void> {
    if (await isDaemonRunning(port)) {
        return
    }

    await startDaemonProcess({ port })

    const client = new DaemonClient({ port })
    for (let i = 0; i < 50; i++) {
        if (await client.health()) {
            return
        }
        await delay(100)
    }

    throw new Error('Daemon failed to start')
}

export async function startDaemonProcess(options: number | StartDaemonOptions): Promise<void> {
    const opts: StartDaemonOptions = typeof options === 'number' ? { port: options } : options
    const { port, idleTimeoutMs } = opts

    fs.mkdirSync(path.dirname(pidFilePath), { recursive: true })

    // Kill existing daemon process if alive
    if (fs.existsSync(pidFilePath)) {
        const oldPid = parseInt(fs.readFileSync(pidFilePath, 'utf-8').trim(), 10)
        if (!isNaN(oldPid) && isProcessAlive(oldPid)) {
            killProcessTree(oldPid)
            if (!(await waitForExit(oldPid, 2000))) {
                killProcessTree(oldPid, 'SIGKILL')
            }
        }
    }

    const logPath = path.join(path.dirname(pidFilePath), 'daemon.log')
    const out = fs.openSync(logPath, 'a')
    const err = fs.openSync(logPath, 'a')

    const entryArgs = [`--port=${port}`]
    if (idleTimeoutMs !== undefined) {
        entryArgs.push(`--idle-timeout=${idleTimeoutMs}`)
    }

    const entryScript = path.resolve(path.dirname(process.argv[1]), 'daemon-entry.js')
    const child = spawn(process.execPath, [entryScript, ...entryArgs], {
        detached: true,
        stdio: ['ignore', out, err]
    })

    child.unref()

    fs.writeFileSync(pidFilePath, String(child.pid))

    const client = new DaemonClient({ port })
    for (let i = 0; i < 50; i++) {
        if (await client.health()) {
            return
        }
        await delay(100)
    }

    throw new Error('Daemon failed to start')
}

export async function stopDaemonProcess(port = getDaemonPort()): Promise<void> {
    // Try graceful shutdown via HTTP
    try {
        await fetch(`http://localhost:${port}/shutdown`, { method: 'POST' })
    } catch {
        // Daemon may not support shutdown or may have already exited
    }

    // Give daemon up to 2 seconds to exit gracefully
    if (fs.existsSync(pidFilePath)) {
        const pid = parseInt(fs.readFileSync(pidFilePath, 'utf-8').trim(), 10)
        if (!isNaN(pid) && isProcessAlive(pid)) {
            if (await waitForExit(pid, 2000)) {
                fs.rmSync(pidFilePath)
                return
            }
            // Force kill tree if still alive
            killProcessTree(pid, 'SIGKILL')
            await waitForExit(pid, 2000)
        }
        if (fs.existsSync(pidFilePath)) {
            fs.rmSync(pidFilePath)
        }
    }
}
