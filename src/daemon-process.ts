import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DaemonClient } from './daemon-client.js'
import {
    getDaemonMetadataPath,
    readDaemonMetadata,
    removeDaemonMetadata
} from './daemon-metadata.js'
import {
    assertSupportedProcessPlatform,
    getProcessCommand,
    isProcessAlive,
    isViewPrintDaemonCommand,
    killProcessTree
} from './process-tree.js'

const metadataDirectory = path.join(os.homedir(), '.viewprint', 'daemons')
const DEFAULT_PORT = 7345
const START_TIMEOUT_MS = 10_000
const STOP_TIMEOUT_MS = 5_000
const LOCK_TIMEOUT_MS = 15_000
const LOCK_STALE_MS = 60_000

export interface StartDaemonOptions {
    port: number
    idleTimeoutMs?: number
}

interface DaemonIdentity {
    pid: number
    port: number
    token: string
    instanceId: string
}

export function getDaemonPort(): number {
    const envPort = process.env.VIEWPRINT_PORT
    if (envPort === undefined) {
        return DEFAULT_PORT
    }
    const port = Number(envPort)
    validatePort(port)
    return port
}

export function getPidFilePath(): string {
    return getDaemonMetadataPath(getDaemonPort())
}

export function getIdleTimeoutFromEnv(): number | undefined {
    const env = process.env.VIEWPRINT_IDLE_TIMEOUT_MS
    if (env === undefined) {
        return undefined
    }
    const value = Number(env)
    return Number.isFinite(value) ? value : undefined
}

function validatePort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('Daemon port must be an integer from 1 to 65535.')
    }
}

function ensureMetadataDirectory(): void {
    fs.mkdirSync(metadataDirectory, { recursive: true, mode: 0o700 })
    fs.chmodSync(metadataDirectory, 0o700)
}

function getLockPath(port: number): string {
    return path.join(metadataDirectory, `daemon-${port}.lock`)
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withPortLock<T>(port: number, action: () => Promise<T>): Promise<T> {
    ensureMetadataDirectory()
    const lockPath = getLockPath(port)
    const startedAt = Date.now()
    let descriptor: number | null = null

    while (descriptor === null) {
        try {
            descriptor = fs.openSync(lockPath, 'wx', 0o600)
            fs.writeFileSync(descriptor, `${process.pid}\n${Date.now()}\n`)
            fs.fsyncSync(descriptor)
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'EEXIST') {
                throw error
            }
            try {
                const stats = fs.statSync(lockPath)
                if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
                    fs.rmSync(lockPath, { force: true })
                    continue
                }
            } catch {
                continue
            }
            if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
                throw new Error(`Timed out waiting for daemon lock on port ${port}.`)
            }
            await delay(50)
        }
    }

    try {
        return await action()
    } finally {
        fs.closeSync(descriptor)
        fs.rmSync(lockPath, { force: true })
    }
}

function hasExpectedProcess(identity: DaemonIdentity): boolean {
    if (!isProcessAlive(identity.pid)) {
        return false
    }
    const command = getProcessCommand(identity.pid)
    return command !== null && isViewPrintDaemonCommand(command, identity.instanceId)
}

async function waitForExit(identity: DaemonIdentity, timeoutMs: number): Promise<boolean> {
    const endAt = Date.now() + timeoutMs
    while (Date.now() < endAt) {
        if (!hasExpectedProcess(identity)) {
            return true
        }
        await delay(100)
    }
    return !hasExpectedProcess(identity)
}

async function waitForDaemon(port: number, token: string, instanceId: string): Promise<boolean> {
    const client = new DaemonClient({ port, token })
    const endAt = Date.now() + START_TIMEOUT_MS
    while (Date.now() < endAt) {
        const health = await client.healthStatus()
        if (health.ok && health.instanceId === instanceId) {
            return true
        }
        await delay(100)
    }
    return false
}

async function isDaemonRunningUnlocked(port: number): Promise<boolean> {
    const metadata = readDaemonMetadata(port)
    if (!metadata) {
        return false
    }
    const identity: DaemonIdentity = { ...metadata }
    if (!hasExpectedProcess(identity)) {
        removeDaemonMetadata(port, metadata.instanceId)
        return false
    }
    const health = await new DaemonClient({ port, token: metadata.token }).healthStatus()
    if (!health.ok || health.instanceId !== metadata.instanceId) {
        return false
    }
    return true
}

export async function isDaemonRunning(port = getDaemonPort()): Promise<boolean> {
    validatePort(port)
    const metadata = readDaemonMetadata(port)
    if (!metadata) {
        return false
    }
    const identity: DaemonIdentity = { ...metadata }
    if (!hasExpectedProcess(identity)) {
        removeDaemonMetadata(port, metadata.instanceId)
        return false
    }
    const health = await new DaemonClient({ port, token: metadata.token }).healthStatus()
    return health.ok && health.instanceId === metadata.instanceId
}

async function startDaemonProcessUnlocked(options: StartDaemonOptions): Promise<void> {
    const { port, idleTimeoutMs } = options
    validatePort(port)

    if (await isDaemonRunningUnlocked(port)) {
        return
    }

    const existing = readDaemonMetadata(port)
    if (existing) {
        const identity: DaemonIdentity = { ...existing }
        if (hasExpectedProcess(identity)) {
            killProcessTree(existing.pid, 'SIGTERM')
            if (!(await waitForExit(identity, STOP_TIMEOUT_MS))) {
                if (hasExpectedProcess(identity)) {
                    killProcessTree(existing.pid, 'SIGKILL')
                }
                if (!(await waitForExit(identity, 2_000))) {
                    throw new Error(`Existing viewprint daemon ${existing.instanceId} would not stop.`)
                }
            }
        }
        removeDaemonMetadata(port, existing.instanceId)
    }

    const token = randomBytes(32).toString('hex')
    const instanceId = randomUUID()
    const logPath = path.join(path.dirname(getDaemonMetadataPath(port)), `daemon-${port}.log`)
    const outputDescriptor = fs.openSync(logPath, 'a', 0o600)
    const errorDescriptor = fs.openSync(logPath, 'a', 0o600)
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
    const entryScript = path.join(moduleDirectory, 'daemon-entry.js')
    if (!fs.existsSync(entryScript)) {
        fs.closeSync(outputDescriptor)
        fs.closeSync(errorDescriptor)
        throw new Error(`Daemon entry point not found at ${entryScript}; build the package before starting the daemon.`)
    }

    const args = [entryScript, `--port=${port}`, `--instance-id=${instanceId}`]
    if (idleTimeoutMs !== undefined) {
        args.push(`--idle-timeout=${idleTimeoutMs}`)
    }

    let child: ReturnType<typeof spawn>
    try {
        child = spawn(process.execPath, args, {
            detached: true,
            stdio: ['ignore', outputDescriptor, errorDescriptor],
            windowsHide: true,
            env: {
                ...process.env,
                VIEWPRINT_PORT: String(port),
                VIEWPRINT_TOKEN: token,
                VIEWPRINT_INSTANCE_ID: instanceId
            }
        })
    } finally {
        fs.closeSync(outputDescriptor)
        fs.closeSync(errorDescriptor)
    }
    child.unref()

    const identity: DaemonIdentity = { pid: child.pid ?? -1, port, token, instanceId }
    if (identity.pid <= 0 || !(await waitForDaemon(port, token, instanceId))) {
        if (identity.pid > 0 && hasExpectedProcess(identity)) {
            killProcessTree(identity.pid, 'SIGTERM')
            await waitForExit(identity, 2_000)
        }
        removeDaemonMetadata(port, instanceId)
        throw new Error(`Daemon failed to start on port ${port}. See ${logPath}.`)
    }

    const metadata = readDaemonMetadata(port)
    if (!metadata || metadata.pid !== identity.pid || metadata.instanceId !== instanceId) {
        if (hasExpectedProcess(identity)) {
            killProcessTree(identity.pid, 'SIGTERM')
        }
        throw new Error(`Daemon started without valid metadata on port ${port}.`)
    }
}

export async function ensureDaemonRunning(port = getDaemonPort()): Promise<void> {
    validatePort(port)
    assertSupportedProcessPlatform()
    await withPortLock(port, async () => {
        if (await isDaemonRunningUnlocked(port)) {
            return
        }
        await startDaemonProcessUnlocked({ port })
    })
}

export async function startDaemonProcess(options: number | StartDaemonOptions): Promise<void> {
    const opts: StartDaemonOptions = typeof options === 'number' ? { port: options } : options
    validatePort(opts.port)
    assertSupportedProcessPlatform()
    await withPortLock(opts.port, () => startDaemonProcessUnlocked(opts))
}

export async function stopDaemonProcess(port = getDaemonPort()): Promise<void> {
    validatePort(port)
    assertSupportedProcessPlatform()
    await withPortLock(port, async () => {
        const metadata = readDaemonMetadata(port)
        if (!metadata) {
            return
        }
        const identity: DaemonIdentity = { ...metadata }
        if (!hasExpectedProcess(identity)) {
            removeDaemonMetadata(port, metadata.instanceId)
            return
        }

        const client = new DaemonClient({ port, token: metadata.token })
        const health = await client.healthStatus()
        if (health.ok && health.instanceId === metadata.instanceId) {
            await client.shutdown()
        } else if (hasExpectedProcess(identity)) {
            process.kill(identity.pid, 'SIGTERM')
        }

        if (!(await waitForExit(identity, STOP_TIMEOUT_MS)) && hasExpectedProcess(identity)) {
            killProcessTree(identity.pid, 'SIGKILL')
            await waitForExit(identity, 2_000)
        }
        removeDaemonMetadata(port, metadata.instanceId)
    })
}
