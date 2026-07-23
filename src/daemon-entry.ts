import { startDaemon } from './daemon.js'
import { getIdleTimeoutFromEnv } from './daemon-process.js'

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
    ? parseInt(idleArg, 10)
    : getIdleTimeoutFromEnv()

async function main(): Promise<void> {
    const daemon = await startDaemon({ port, idleTimeoutMs })

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
        // Synchronous only — daemon.stop() cannot be awaited here
        // daemon.stop() handles its own timeouts; if it didn't finish, chromium
        // tree is still tracked and will be killed by SIGKILL fallback in browser.close()
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
