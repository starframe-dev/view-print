import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DaemonClient } from './daemon-client.js'

const pidFilePath = path.join(os.homedir(), '.viewprint', 'daemon.pid')

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

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

export async function ensureDaemonRunning(port = getDaemonPort()): Promise<void> {
    if (await isDaemonRunning(port)) {
        return
    }

    await startDaemonProcess(port)

    // Wait for daemon to be ready
    const client = new DaemonClient({ port })
    for (let i = 0; i < 50; i++) {
        if (await client.health()) {
            return
        }
        await delay(100)
    }

    throw new Error('Daemon failed to start')
}

export async function startDaemonProcess(port: number): Promise<void> {
    fs.mkdirSync(path.dirname(pidFilePath), { recursive: true })

    const logPath = path.join(path.dirname(pidFilePath), 'daemon.log')
    const out = fs.openSync(logPath, 'a')
    const err = fs.openSync(logPath, 'a')

    const entryScript = path.resolve(path.dirname(process.argv[1]), 'daemon-entry.js')
    const child = spawn(process.execPath, [entryScript, `--port=${port}`], {
        detached: true,
        stdio: ['ignore', out, err]
    })

    child.unref()

    fs.writeFileSync(pidFilePath, String(child.pid))

    // Wait briefly for daemon to be ready
    const client = new DaemonClient({ port })
    for (let i = 0; i < 50; i++) {
        if (await client.health()) {
            return
        }
        await delay(100)
    }

    throw new Error('Daemon failed to start')
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function stopDaemonProcess(port = getDaemonPort()): Promise<void> {
    try {
        await fetch(`http://localhost:${port}/shutdown`, { method: 'POST' })
    } catch {
        // Daemon may not support shutdown
    }

    if (fs.existsSync(pidFilePath)) {
        const pid = parseInt(fs.readFileSync(pidFilePath, 'utf-8').trim(), 10)
        if (isProcessAlive(pid)) {
            try {
                process.kill(pid, 'SIGTERM')
            } catch {
                // ignore
            }
        }
        fs.rmSync(pidFilePath)
    }
}
