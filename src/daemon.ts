import http from 'node:http'
import { URL } from 'node:url'
import { BrowserSession } from './browser.js'
import type { WaitCondition } from './browser.js'
import type { NetworkRoute } from './types.js'

export interface DaemonOptions {
    port: number
    /**
     * Auto-shutdown the daemon after this many ms without any request.
     * Default: 600000 (10 minutes). Set to 0 or negative to disable.
     */
    idleTimeoutMs?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 30 * 1000
const STOP_TIMEOUT_MS = 5000

export class ViewPrintDaemon {
    private server: http.Server | null = null
    private sessions = new Map<string, BrowserSession>()
    private port: number
    private idleTimeoutMs: number
    private idleCheckIntervalMs: number
    private lastActivityAt = Date.now()
    private idleCheckInterval: NodeJS.Timeout | null = null
    private stopping = false

    constructor(options: DaemonOptions) {
        this.port = options.port
        const requested = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
        this.idleTimeoutMs = requested > 0 ? requested : 0
        const envInterval = process.env.VIEWPRINT_IDLE_CHECK_INTERVAL_MS
        this.idleCheckIntervalMs = envInterval
            ? Math.max(100, parseInt(envInterval, 10))
            : DEFAULT_IDLE_CHECK_INTERVAL_MS
    }

    async start(): Promise<void> {
        this.lastActivityAt = Date.now()
        this.server = http.createServer((req, res) => this.handleRequest(req, res))

        if (this.idleTimeoutMs > 0) {
            this.idleCheckInterval = setInterval(() => this.checkIdle(), this.idleCheckIntervalMs)
            this.idleCheckInterval.unref()
        }

        return new Promise((resolve, reject) => {
            this.server?.listen(this.port, () => {
                console.error(`viewprint daemon listening on port ${this.port}`)
                if (this.idleTimeoutMs > 0) {
                    console.error(`viewprint daemon idle timeout: ${this.idleTimeoutMs}ms`)
                }
                resolve()
            })

            this.server?.on('error', reject)
        })
    }

    async stop(): Promise<void> {
        if (this.stopping) {
            return
        }
        this.stopping = true

        if (this.idleCheckInterval) {
            clearInterval(this.idleCheckInterval)
            this.idleCheckInterval = null
        }

        const stopPromise = (async () => {
            const sessionCloses = Array.from(this.sessions.values()).map((session) =>
                session.close().catch((error) => {
                    console.error('Session close error:', error)
                })
            )
            await Promise.allSettled(sessionCloses)
            this.sessions.clear()

            if (this.server) {
                await new Promise<void>((resolve) => {
                    this.server!.close(() => resolve())
                })
            }
        })()

        const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS))
        await Promise.race([stopPromise, timeoutPromise])
    }

    /**
     * Returns true if idle timeout is enabled and configured.
     */
    isIdleTimeoutEnabled(): boolean {
        return this.idleTimeoutMs > 0
    }

    /**
     * Returns the last activity timestamp (ms epoch). Useful for tests.
     */
    getLastActivityAt(): number {
        return this.lastActivityAt
    }

    private checkIdle(): void {
        if (this.stopping || this.idleTimeoutMs <= 0) {
            return
        }
        const idleFor = Date.now() - this.lastActivityAt
        if (idleFor >= this.idleTimeoutMs) {
            console.error(`viewprint daemon idle for ${idleFor}ms, shutting down`)
            // Use setImmediate to break out of the interval callback
            setImmediate(() => {
                void this.stop().finally(() => process.exit(0))
            })
        }
    }

    private markActivity(): void {
        this.lastActivityAt = Date.now()
    }

    getPort(): number {
        if (this.port === 0) {
            const address = this.server?.address()
            if (address && typeof address !== 'string') {
                return address.port
            }
        }
        return this.port
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url || '/', `http://localhost:${this.port}`)
        const pathParts = url.pathname.split('/').filter(Boolean)

        this.markActivity()

        try {
            if (req.method === 'GET' && url.pathname === '/health') {
                this.sendJson(res, 200, { ok: true })
                return
            }

            if (req.method === 'POST' && url.pathname === '/shutdown') {
                this.sendJson(res, 200, { shuttingDown: true })
                // Exit after response is flushed; daemon.stop() closes sessions
                setImmediate(() => {
                    void this.stop().finally(() => process.exit(0))
                })
                return
            }

            if (pathParts[0] !== 'sessions' || pathParts.length < 2) {
                this.sendJson(res, 404, { error: 'Not found' })
                return
            }

            const sessionName = pathParts[1]
            const action = pathParts[2]
            const subAction = pathParts[3]
            const subAction2 = pathParts[4]

            if (req.method === 'POST' && action === 'capture') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const graph = await session.capture(body.url, body.viewport)
                this.sendJson(res, 200, graph)
                return
            }

            if (req.method === 'POST' && action === 'snapshot') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const snapshot = await session.snapshot(body.url, body.viewport)
                this.sendJson(res, 200, snapshot)
                return
            }

            if (req.method === 'POST' && action === 'inspect') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const element = await session.inspect(body.elementId)
                this.sendJson(res, 200, element)
                return
            }

            if (req.method === 'POST' && action === 'click') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.click(body.elementId)
                this.sendJson(res, 200, { clicked: true })
                return
            }

            if (req.method === 'POST' && action === 'fill') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.fill(body.elementId, body.text)
                this.sendJson(res, 200, { filled: true })
                return
            }

            if (req.method === 'POST' && action === 'type') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.type(body.elementId, body.text)
                this.sendJson(res, 200, { typed: true })
                return
            }

            if (req.method === 'POST' && action === 'hover') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.hover(body.elementId)
                this.sendJson(res, 200, { hovered: true })
                return
            }

            if (req.method === 'POST' && action === 'focus') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.focus(body.elementId)
                this.sendJson(res, 200, { focused: true })
                return
            }

            if (req.method === 'POST' && action === 'press') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.press(body.key)
                this.sendJson(res, 200, { pressed: true })
                return
            }

            if (req.method === 'POST' && action === 'scroll') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.scroll(body.direction, body.px, body.elementId)
                this.sendJson(res, 200, { scrolled: true })
                return
            }

            if (req.method === 'POST' && action === 'scrollintoview') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.scrollIntoView(body.elementId)
                this.sendJson(res, 200, { scrolledIntoView: true })
                return
            }

            if (req.method === 'POST' && action === 'wait') {
                const body = await this.readJson(req) as WaitCondition
                const session = await this.getOrCreateSession(sessionName)
                await session.wait(body)
                this.sendJson(res, 200, { waited: true })
                return
            }

            if (req.method === 'POST' && action === 'eval') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const result = await session.eval(body.script)
                this.sendJson(res, 200, { result })
                return
            }

            if (req.method === 'POST' && action === 'batch') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const results = await this.executeBatch(session, body.commands)
                this.sendJson(res, 200, { results })
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'requests') {
                const session = this.getExistingSession(sessionName)
                this.sendJson(res, 200, { requests: session.getNetworkRequests() })
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'track' && subAction2 === 'start') {
                const session = await this.getOrCreateSession(sessionName)
                await session.startNetworkTracking()
                this.sendJson(res, 200, { tracking: true })
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'track' && subAction2 === 'stop') {
                const session = this.getExistingSession(sessionName)
                await session.stopNetworkTracking()
                this.sendJson(res, 200, { tracking: false })
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'har' && subAction2 === 'start') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const result = await session.startHar(body.path)
                this.sendJson(res, 200, result)
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'har' && subAction2 === 'stop') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const result = await session.stopHar(body.path)
                this.sendJson(res, 200, result)
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'route') {
                const body = await this.readJson(req) as NetworkRoute
                if (!body.url) {
                    this.sendJson(res, 400, { error: 'URL required for route' })
                    return
                }
                const session = await this.getOrCreateSession(sessionName)
                await session.route(body.url, body)
                this.sendJson(res, 200, { routed: true })
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'unroute') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                await session.unroute(body.url)
                this.sendJson(res, 200, { unrouted: true })
                return
            }

            if (req.method === 'GET' && action === 'cookies') {
                const session = this.getExistingSession(sessionName)
                const cookies = await session.getCookies()
                this.sendJson(res, 200, { cookies })
                return
            }

            if (req.method === 'POST' && action === 'cookies' && subAction === 'set') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.setCookie(body.name, body.value, body.domain, body.path)
                this.sendJson(res, 200, { set: true })
                return
            }

            if (req.method === 'POST' && action === 'cookies' && subAction === 'clear') {
                const session = await this.getOrCreateSession(sessionName)
                await session.clearCookies()
                this.sendJson(res, 200, { cleared: true })
                return
            }

            if (req.method === 'GET' && action === 'storage' && subAction === 'local') {
                const session = this.getExistingSession(sessionName)
                const data = await session.getLocalStorage()
                this.sendJson(res, 200, { data })
                return
            }

            if (req.method === 'POST' && action === 'storage' && subAction === 'local' && subAction2 === 'set') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.setLocalStorage(body.key, body.value)
                this.sendJson(res, 200, { set: true })
                return
            }

            if (req.method === 'POST' && action === 'storage' && subAction === 'local' && subAction2 === 'clear') {
                const session = await this.getOrCreateSession(sessionName)
                await session.clearLocalStorage()
                this.sendJson(res, 200, { cleared: true })
                return
            }

            if (req.method === 'GET' && action === 'storage' && subAction === 'session') {
                const session = this.getExistingSession(sessionName)
                const data = await session.getSessionStorage()
                this.sendJson(res, 200, { data })
                return
            }

            if (req.method === 'POST' && action === 'storage' && subAction === 'session' && subAction2 === 'set') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.setSessionStorage(body.key, body.value)
                this.sendJson(res, 200, { set: true })
                return
            }

            if (req.method === 'POST' && action === 'storage' && subAction === 'session' && subAction2 === 'clear') {
                const session = await this.getOrCreateSession(sessionName)
                await session.clearSessionStorage()
                this.sendJson(res, 200, { cleared: true })
                return
            }

            if (req.method === 'POST' && action === 'tabs' && subAction === 'new') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.newTab(body.url)
                this.sendJson(res, 200, { tabCreated: true })
                return
            }

            if (req.method === 'POST' && action === 'tabs' && subAction === 'switch') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                await session.switchTab(body.index)
                this.sendJson(res, 200, { switched: true })
                return
            }

            if (req.method === 'POST' && action === 'tabs' && subAction === 'close') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                await session.closeTab(body.index)
                this.sendJson(res, 200, { closed: true })
                return
            }

            if (req.method === 'GET' && action === 'tabs') {
                const session = this.getExistingSession(sessionName)
                const tabs = await session.listTabs()
                this.sendJson(res, 200, { tabs })
                return
            }

            if (req.method === 'POST' && action === 'frames' && subAction === 'switch') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                await session.switchFrame(body.selector)
                this.sendJson(res, 200, { switched: true })
                return
            }

            if (req.method === 'POST' && action === 'frames' && subAction === 'main') {
                const session = this.getExistingSession(sessionName)
                await session.switchFrameMain()
                this.sendJson(res, 200, { switched: true })
                return
            }

            if (req.method === 'GET' && action === 'frames') {
                const session = this.getExistingSession(sessionName)
                const frames = await session.listFrames()
                this.sendJson(res, 200, { frames })
                return
            }

            if (req.method === 'POST' && action === 'screenshot' && subAction === 'page') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const outputPath = await session.screenshotPage(body.path)
                this.sendJson(res, 200, { path: outputPath })
                return
            }

            if (req.method === 'POST' && action === 'screenshot' && subAction === 'element') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const outputPath = await session.screenshotElement(body.elementId, body.path)
                this.sendJson(res, 200, { path: outputPath })
                return
            }

            if (req.method === 'POST' && action === 'read') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const content = await session.read(body.format ?? 'text')
                this.sendJson(res, 200, { content })
                return
            }

            if (req.method === 'POST' && action === 'dialog') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                await session.setDialogHandler(async () => {
                    return body.handler as { accept: boolean; promptText?: string }
                })
                this.sendJson(res, 200, { handlerSet: true })
                return
            }

            if (req.method === 'GET' && action === 'diff' && subAction === 'last') {
                const session = this.getExistingSession(sessionName)
                const currentGraph = await session.capture()
                const lastGraph = session.getLastGraph()
                if (!lastGraph) {
                    this.sendJson(res, 200, { diff: null, message: 'No previous graph to compare' })
                    return
                }
                const { diffGraphs } = await import('./diff.js')
                this.sendJson(res, 200, { diff: diffGraphs(lastGraph, currentGraph) })
                return
            }

            if (req.method === 'GET' && action === undefined) {
                const session = this.sessions.get(sessionName)
                if (!session) {
                    this.sendJson(res, 404, { error: 'Session not found' })
                    return
                }
                const status = await session.status()
                this.sendJson(res, 200, status)
                return
            }

            if (req.method === 'DELETE' && action === undefined) {
                const session = this.sessions.get(sessionName)
                if (session) {
                    await session.close()
                    this.sessions.delete(sessionName)
                }
                this.sendJson(res, 200, { closed: true })
                return
            }

            this.sendJson(res, 404, { error: 'Not found' })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            this.sendJson(res, 500, { error: message })
        }
    }

    private async getOrCreateSession(name: string): Promise<BrowserSession> {
        const existing = this.sessions.get(name)
        if (existing) {
            return existing
        }

        const session = new BrowserSession(name)
        await session.start()
        this.sessions.set(name, session)
        return session
    }

    private getExistingSession(name: string): BrowserSession {
        const session = this.sessions.get(name)
        if (!session) {
            throw new Error('Session not found')
        }
        return session
    }

    private async executeBatch(session: BrowserSession, commands: unknown[]): Promise<unknown[]> {
        const results: unknown[] = []

        for (const command of commands) {
            if (!Array.isArray(command)) {
                throw new Error('Each batch command must be an array')
            }

            const [name, ...args] = command
            const result = await this.executeCommand(session, name as string, args)
            results.push(result)
        }

        return results
    }

    private async executeCommand(session: BrowserSession, name: string, args: unknown[]): Promise<unknown> {
        switch (name) {
            case 'capture':
                return session.capture(args[0] as string | undefined, args[1] as { width: number; height: number } | undefined)
            case 'snapshot':
                return session.snapshot(args[0] as string | undefined, args[1] as { width: number; height: number } | undefined)
            case 'inspect':
                return session.inspect(args[0] as string)
            case 'click':
                await session.click(args[0] as string)
                return { clicked: true }
            case 'fill':
                await session.fill(args[0] as string, args[1] as string)
                return { filled: true }
            case 'type':
                await session.type(args[0] as string, args[1] as string)
                return { typed: true }
            case 'hover':
                await session.hover(args[0] as string)
                return { hovered: true }
            case 'focus':
                await session.focus(args[0] as string)
                return { focused: true }
            case 'press':
                await session.press(args[0] as string)
                return { pressed: true }
            case 'scroll':
                await session.scroll(
                    args[0] as 'up' | 'down' | 'left' | 'right',
                    args[1] as number,
                    args[2] as string | undefined
                )
                return { scrolled: true }
            case 'scrollintoview':
                await session.scrollIntoView(args[0] as string)
                return { scrolledIntoView: true }
            case 'wait':
                await session.wait(args[0] as WaitCondition)
                return { waited: true }
            case 'eval':
                return { result: await session.eval(args[0] as string) }
            case 'status':
                return session.status()
            default:
                throw new Error(`Unknown command: ${name}`)
        }
    }

    private readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
        return new Promise((resolve, reject) => {
            let body = ''
            req.on('data', (chunk) => { body += chunk })
            req.on('end', () => {
                try {
                    resolve(body ? JSON.parse(body) : {})
                } catch (error) {
                    reject(new Error('Invalid JSON'))
                }
            })
            req.on('error', reject)
        })
    }

    private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
    }
}

export async function startDaemon(options: DaemonOptions): Promise<ViewPrintDaemon> {
    const daemon = new ViewPrintDaemon(options)
    await daemon.start()
    return daemon
}
