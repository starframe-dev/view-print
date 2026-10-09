import { randomBytes, randomUUID } from 'node:crypto'
import { startDaemon } from './daemon.js'
import { writeDaemonMetadata, removeDaemonMetadata } from './daemon-metadata.js'
import { getIdleTimeoutFromEnv } from './daemon-process.js'
import { getProcessTreePids } from './process-tree.js'

const CLEANUP_TIMEOUT_MS = 5000

function parseArg(name: string): string | undefined {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
    if (arg) {
        return arg.slice(name.length + 3)
    }
    const idx = process.argv.indexOf(`--${name}`)
    if (idx !== -1 && idx + 1 < process.argv.length) {
        return process.argv[idx + 1]
    }
    return undefined
}

const portArg = parseArg('port')
const port = portArg ? parseInt(portArg, 10) : parseInt(process.env.VIEWPRINT_PORT || '7345', 10)

const idleArg = parseArg('idle-timeout')
const idleTimeoutMs = idleArg !== undefined
    ? Number(idleArg)
    : getIdleTimeoutFromEnv()
const instanceId = parseArg('instance-id') ?? process.env.VIEWPRINT_INSTANCE_ID ?? randomUUID()
const token = process.env.VIEWPRINT_TOKEN ?? randomBytes(32).toString('hex')

async function main(): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('Daemon port must be an integer from 1 to 65535.')
    }
    if (!Number.isFinite(idleTimeoutMs ?? 0)) {
        throw new Error('Invalid idle timeout.')
    }

    const daemon = await startDaemon({ port, idleTimeoutMs, token, instanceId })
    try {
        writeDaemonMetadata({
            pid: process.pid,
            port: daemon.getPort(),
            startedAt: new Date().toISOString(),
            token,
            instanceId
        })
    } catch (error) {
        await daemon.stop()
        throw error
    }

    let cleaningUp = false
    const cleanup = async (exitCode: number): Promise<void> => {
        if (cleaningUp) {
            return
        }
        cleaningUp = true
        const cleanupPromise = daemon.stop().catch((error) => {
            console.error('Cleanup error:', error)
        })
        const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS))
        await Promise.race([cleanupPromise, timeoutPromise])
        process.exit(exitCode)
    }

    // Best-effort sync cleanup if event loop is exiting
    process.on('exit', () => {
        const pids = getProcessTreePids(process.pid)
        for (const pid of pids) {
            try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
        }
        removeDaemonMetadata(daemon.getPort(), instanceId)
    })

    process.on('SIGTERM', () => { void cleanup(0) })
    process.on('SIGINT', () => { void cleanup(0) })
    process.on('uncaughtException', (error) => {
        console.error('Uncaught exception:', error)
        void cleanup(1)
    })
    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled rejection:', reason)
        void cleanup(1)
    })
}

main().catch((error) => {
    console.error('Daemon failed:', error)
    process.exit(1)
})
