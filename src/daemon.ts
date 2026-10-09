import http from 'node:http'
import fs from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { URL } from 'node:url'
import { BrowserSession } from './browser.js'
import type { NetworkTrackingOptions, WaitCondition } from './browser.js'
import { getProcessTreePids } from './process-tree.js'
import { removeDaemonMetadata } from './daemon-metadata.js'
import { exportSession, importSession, normalizeSessionState, renameSession, sessionExists, validateSessionName } from './session.js'
import { TracingSession } from './tracing.js'
import type { NetworkRoute, TraceReport } from './types.js'
import type { Page } from 'playwright'

export interface DaemonOptions {
    port: number
    token?: string
    instanceId?: string
    maxRequestBodyBytes?: number
    /**
     * Auto-shutdown the daemon after this many ms without any request.
     * Default: 600000 (10 minutes). Set to 0 or negative to disable.
     */
    idleTimeoutMs?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 30 * 1000
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024
const STOP_TIMEOUT_MS = 5000

class HttpError extends Error {
    status: number

    constructor(status: number, message: string) {
        super(message)
        this.status = status
    }
}

export class ViewPrintDaemon {
    private server: http.Server | null = null
    private sessions = new Map<string, BrowserSession>()
    private tracingSessions = new Map<string, TracingSession>()
    private port: number
    private token: string
    private instanceId: string
    private maxRequestBodyBytes: number
    private idleTimeoutMs: number
    private idleCheckIntervalMs: number
    private lastActivityAt = Date.now()
    private idleCheckInterval: NodeJS.Timeout | null = null
    private stopping = false

    constructor(options: DaemonOptions) {
        if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
            throw new Error('Daemon port must be an integer from 0 to 65535.')
        }
        this.port = options.port
        this.token = options.token ?? randomBytes(32).toString('hex')
        this.instanceId = options.instanceId ?? randomBytes(16).toString('hex')
        if (this.token.length < 32 || this.instanceId.length < 16) {
            throw new Error('Daemon token and instance ID must be at least 32 and 16 characters.')
        }
        this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
        if (!Number.isSafeInteger(this.maxRequestBodyBytes) || this.maxRequestBodyBytes < 1) {
            throw new Error('Daemon request body limit must be a positive integer.')
        }
        const requested = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
        this.idleTimeoutMs = requested > 0 ? requested : 0
        const envInterval = Number(process.env.VIEWPRINT_IDLE_CHECK_INTERVAL_MS)
        this.idleCheckIntervalMs = Number.isSafeInteger(envInterval) && envInterval >= 100
            ? envInterval
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
            this.server?.listen(this.port, '127.0.0.1', () => {
                console.error(`viewprint daemon listening on 127.0.0.1:${this.port}`)
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
            const traceCloses = Array.from(this.tracingSessions.values()).map((tracing) => tracing.close())
            await Promise.allSettled(traceCloses)
            this.tracingSessions.clear()

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

            this.killRemainingDescendants()
            if (this.port > 0) {
                removeDaemonMetadata(this.port, this.instanceId)
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

    /**
     * Sends SIGKILL to all descendant processes of the daemon itself.
     * Used as last-resort cleanup so orphan chromium helpers never survive daemon exit.
     * Returns the number of PIDs signaled.
     */
    killRemainingDescendants(): number {
        const pids = getProcessTreePids(process.pid)
        let killed = 0
        for (const pid of pids) {
            try {
                process.kill(pid, 'SIGKILL')
                killed++
            } catch {
                /* ignore */
            }
        }
        return killed
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

    getToken(): string {
        return this.token
    }

    getInstanceId(): string {
        return this.instanceId
    }

    getAddress(): ReturnType<http.Server['address']> {
        return this.server?.address() ?? null
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
        const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`)
        const pathParts = url.pathname.split('/').filter(Boolean)
        const startTime = Date.now()

        this.markActivity()

        try {
            if (!this.isAuthorized(req)) {
                this.sendJson(res, 401, { error: 'Unauthorized' })
                return
            }

            if (pathParts[0] === 'sessions' && pathParts.length >= 2) {
                try {
                    pathParts[1] = decodeURIComponent(pathParts[1])
                    validateSessionName(pathParts[1])
                } catch {
                    throw new HttpError(400, 'Invalid session name.')
                }
            }

            if (req.method === 'GET' && url.pathname === '/health') {
                this.sendJson(res, 200, { ok: true, instanceId: this.instanceId })
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

            if (req.method === 'POST' && action === 'rename') {
                const body = await this.readJson(req)
                if (this.sessions.has(sessionName)) {
                    throw new Error('Cannot rename an open session. Close the browser first.')
                }
                const newName = this.parseSessionName(body.newName)
                if (this.sessions.has(newName)) {
                    throw new Error(`Session is open: ${newName}. Close the browser first.`)
                }
                renameSession(sessionName, newName)
                this.sendJson(res, 200, { renamed: true, oldName: sessionName, newName })
                return
            }

            if (req.method === 'GET' && action === 'export') {
                const activeSession = this.sessions.get(sessionName)
                if (!activeSession && !sessionExists(sessionName)) {
                    throw new Error(`Session not found: ${sessionName}`)
                }
                const state = activeSession ? activeSession.getState() : exportSession(sessionName)
                this.sendJson(res, 200, state)
                return
            }

            if (req.method === 'POST' && action === 'import') {
                const body = await this.readJson(req)
                if (this.sessions.has(sessionName)) {
                    throw new Error('Cannot import into an open session. Close the browser first.')
                }
                if (body.force !== undefined && typeof body.force !== 'boolean') {
                    throw new Error('Invalid force. Must be a boolean.')
                }
                const state = normalizeSessionState(body.state, sessionName)
                importSession(sessionName, state, body.force === true)
                this.sendJson(res, 200, { imported: true, session: sessionName })
                return
            }

            if (req.method === 'POST' && action === 'capture') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName, {
                    noHeadless: this.parseNoHeadless(body.noHeadless)
                })
                const graph = await session.capture(
                    this.parseOptionalString(body.url, 'url'),
                    this.parseViewport(body.viewport),
                    this.parseDepth(body.depth),
                    this.parseExpand(body.expand),
                    this.parseQuery(body.query),
                    this.parseLoadOptions(body.options)
                )
                this.sendJson(res, 200, graph)
                return
            }

            if (req.method === 'POST' && action === 'snapshot') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const snapshot = await session.snapshot(
                    this.parseOptionalString(body.url, 'url'),
                    this.parseViewport(body.viewport),
                    this.parseDepth(body.depth),
                    this.parseExpand(body.expand),
                    this.parseQuery(body.query),
                    this.parseLoadOptions(body.options)
                )
                this.sendJson(res, 200, snapshot)
                return
            }

            if (req.method === 'POST' && action === 'inspect') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const element = await session.inspect(this.parseRequiredString(body.elementId, 'elementId'))
                this.sendJson(res, 200, element)
                return
            }

            if (req.method === 'POST' && action === 'click') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const query = this.parseOptionalString(body.query, 'query')
                if (query !== undefined) {
                    await session.clickQuery(query)
                } else {
                    await session.click(this.parseRequiredString(body.elementId, 'elementId'))
                }
                this.sendJson(res, 200, { clicked: true })
                return
            }

            if (req.method === 'POST' && action === 'fill') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const query = this.parseOptionalString(body.query, 'query')
                const text = this.parseRequiredString(body.text, 'text')
                if (query !== undefined) {
                    await session.fillQuery(query, text)
                } else {
                    await session.fill(this.parseRequiredString(body.elementId, 'elementId'), text)
                }
                this.sendJson(res, 200, { filled: true })
                return
            }

            if (req.method === 'POST' && action === 'type') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.type(
                    this.parseRequiredString(body.elementId, 'elementId'),
                    this.parseRequiredString(body.text, 'text')
                )
                this.sendJson(res, 200, { typed: true })
                return
            }

            if (req.method === 'POST' && action === 'hover') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.hover(this.parseRequiredString(body.elementId, 'elementId'))
                this.sendJson(res, 200, { hovered: true })
                return
            }

            if (req.method === 'POST' && action === 'focus') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.focus(this.parseRequiredString(body.elementId, 'elementId'))
                this.sendJson(res, 200, { focused: true })
                return
            }

            if (req.method === 'POST' && action === 'press') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.press(this.parseRequiredString(body.key, 'key'))
                this.sendJson(res, 200, { pressed: true })
                return
            }

            if (req.method === 'POST' && action === 'scroll') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.scroll(
                    this.parseDirection(body.direction),
                    this.parseNumber(body.px, 'px'),
                    this.parseOptionalString(body.elementId, 'elementId')
                )
                this.sendJson(res, 200, { scrolled: true })
                return
            }

            if (req.method === 'POST' && action === 'scrollintoview') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.scrollIntoView(this.parseRequiredString(body.elementId, 'elementId'))
                this.sendJson(res, 200, { scrolledIntoView: true })
                return
            }

            if (req.method === 'POST' && action === 'wait') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.wait(this.parseWaitCondition(body))
                this.sendJson(res, 200, { waited: true })
                return
            }

            if (req.method === 'POST' && action === 'eval') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const result = await session.eval(this.parseRequiredString(body.script, 'script'))
                this.sendJson(res, 200, { result })
                return
            }

            if (req.method === 'POST' && action === 'batch') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                if (!Array.isArray(body.commands)) {
                    throw new HttpError(400, 'Invalid commands. Must be an array.')
                }
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
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.startNetworkTracking(this.parseNetworkTrackingOptions(body))
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
                const result = await session.startHar(
                    this.parseOptionalString(body.path, 'path'),
                    this.parseNetworkTrackingOptions(body)
                )
                this.sendJson(res, 200, result)
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'har' && subAction2 === 'stop') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const result = await session.stopHar(this.parseOptionalString(body.path, 'path'))
                this.sendJson(res, 200, result)
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'route') {
                const body = await this.readJson(req)
                const routeUrl = this.parseRequiredString(body.url, 'url')
                const route: NetworkRoute = {
                    url: routeUrl,
                    abort: body.abort === true,
                    status: this.parseOptionalNumber(body.status, 'status'),
                    body: this.parseOptionalString(body.body, 'body'),
                    contentType: this.parseOptionalString(body.contentType, 'contentType')
                }
                if (body.abort !== undefined && typeof body.abort !== 'boolean') {
                    throw new HttpError(400, 'Invalid abort. Must be a boolean.')
                }
                const session = await this.getOrCreateSession(sessionName)
                await session.route(routeUrl, route)
                this.sendJson(res, 200, { routed: true })
                return
            }

            if (req.method === 'POST' && action === 'network' && subAction === 'unroute') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                await session.unroute(this.parseOptionalString(body.url, 'url'))
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
                await session.setCookie(
                    this.parseRequiredString(body.name, 'name'),
                    this.parseRequiredString(body.value, 'value'),
                    this.parseOptionalString(body.domain, 'domain'),
                    this.parseOptionalString(body.path, 'path')
                )
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
                await session.setLocalStorage(
                    this.parseRequiredString(body.key, 'key'),
                    this.parseRequiredString(body.value, 'value')
                )
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
                await session.setSessionStorage(
                    this.parseRequiredString(body.key, 'key'),
                    this.parseRequiredString(body.value, 'value')
                )
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
                await session.newTab(this.parseOptionalString(body.url, 'url'))
                this.sendJson(res, 200, { tabCreated: true })
                return
            }

            if (req.method === 'POST' && action === 'tabs' && subAction === 'switch') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const index = this.parseNumber(body.index, 'index')
                if (!Number.isSafeInteger(index) || index < 0) {
                    throw new HttpError(400, 'Invalid tab index.')
                }
                await session.switchTab(index)
                this.sendJson(res, 200, { switched: true })
                return
            }

            if (req.method === 'POST' && action === 'tabs' && subAction === 'close') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const index = this.parseOptionalNumber(body.index, 'index')
                if (index !== undefined && (!Number.isSafeInteger(index) || index < 0)) {
                    throw new HttpError(400, 'Invalid tab index.')
                }
                await session.closeTab(index)
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
                await session.switchFrame(this.parseRequiredString(body.selector, 'selector'))
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
                const outputPath = await session.screenshotPage(this.parseOptionalString(body.path, 'path'))
                this.sendJson(res, 200, { path: outputPath })
                return
            }

            if (req.method === 'POST' && action === 'screenshot' && subAction === 'element') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const parsedPadding = this.parseOptionalNumber(body.padding, 'padding')
                const padding = parsedPadding ?? 0
                if (padding < 0) {
                    throw new HttpError(400, 'Invalid padding. Must be non-negative.')
                }
                const outputPath = await session.screenshotElement(
                    this.parseRequiredString(body.elementId, 'elementId'),
                    padding,
                    this.parseOptionalString(body.path, 'path')
                )
                this.sendJson(res, 200, { path: outputPath })
                return
            }

            if (req.method === 'POST' && action === 'read') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const format = this.parseOptionalString(body.format, 'format') ?? 'text'
                if (format !== 'text' && format !== 'markdown') {
                    throw new HttpError(400, 'Invalid format. Use text or markdown.')
                }
                const content = await session.read(format)
                this.sendJson(res, 200, { content })
                return
            }

            if (req.method === 'POST' && action === 'dialog') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                if (typeof body.handler !== 'object' || body.handler === null || Array.isArray(body.handler)) {
                    throw new HttpError(400, 'Invalid dialog handler.')
                }
                const handlerBody = body.handler as Record<string, unknown>
                if (typeof handlerBody.accept !== 'boolean') {
                    throw new HttpError(400, 'Dialog handler accept must be a boolean.')
                }
                const handler = {
                    accept: handlerBody.accept,
                    promptText: this.parseOptionalString(handlerBody.promptText, 'promptText')
                }
                await session.setDialogHandler(async () => handler)
                this.sendJson(res, 200, { handlerSet: true })
                return
            }

            if (req.method === 'GET' && action === 'diff' && subAction === 'last') {
                const session = this.getExistingSession(sessionName)
                const lastGraph = session.getLastGraph()
                const currentGraph = await session.capture()
                if (!lastGraph) {
                    this.sendJson(res, 200, { diff: null, message: 'No previous graph to compare' })
                    return
                }
                const { diffGraphs } = await import('./diff.js')
                this.sendJson(res, 200, { diff: diffGraphs(lastGraph, currentGraph) })
                return
            }

            if (req.method === 'POST' && action === 'profile') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                if (body.enabled === false) {
                    session.disableProfiling()
                } else {
                    session.enableProfiling()
                }
                this.sendJson(res, 200, {
                    profiling: session.isProfilingEnabled(),
                    timingsCount: session.getTimings().length
                })
                return
            }

            if (req.method === 'GET' && action === 'profile') {
                const session = this.getExistingSession(sessionName)
                this.sendJson(res, 200, {
                    timings: session.getTimings(),
                    report: session.getTimingsReport(),
                    enabled: session.isProfilingEnabled()
                })
                return
            }

            if (req.method === 'DELETE' && action === 'profile') {
                const session = this.getExistingSession(sessionName)
                const cleared = session.clearTimings()
                this.sendJson(res, 200, { cleared })
                return
            }

            if (req.method === 'POST' && action === 'trace' && subAction === 'start') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const page = this.getSessionPage(session)
                let tracing = this.tracingSessions.get(sessionName)
                if (!tracing) {
                    tracing = new TracingSession()
                    this.tracingSessions.set(sessionName, tracing)
                }
                await tracing.start(page, { categories: this.parseStringArray(body.categories, 'categories') })
                this.sendJson(res, 200, {
                    started: true,
                    categories: tracing.getCategories()
                })
                return
            }

            if (req.method === 'POST' && action === 'trace' && subAction === 'stop') {
                const body = await this.readJson(req)
                const session = this.getExistingSession(sessionName)
                const tracing = this.tracingSessions.get(sessionName)
                if (!tracing || !tracing.isActive()) {
                    this.sendJson(res, 400, { error: 'Tracing not active' })
                    return
                }
                const page = this.getSessionPage(session)
                const report = await tracing.stop(page, this.parseOptionalString(body.output, 'output'))
                this.tracingSessions.delete(sessionName)
                this.sendJson(res, 200, { stopped: true, ...report })
                return
            }

            if (req.method === 'GET' && action === 'trace' && subAction === 'report') {
                const tracing = this.tracingSessions.get(sessionName)
                if (!tracing) {
                    this.sendJson(res, 200, {
                        report: {
                            path: '',
                            durationMs: 0,
                            eventCount: 0,
                            sizeBytes: 0,
                            categoryCounts: {},
                            topEvents: []
                        } satisfies TraceReport
                    })
                    return
                }
                this.sendJson(res, 200, { report: tracing.report() })
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
                    const tracing = this.tracingSessions.get(sessionName)
                    if (tracing) {
                        await tracing.close()
                        this.tracingSessions.delete(sessionName)
                    }
                    await session.close()
                    this.sessions.delete(sessionName)
                }
                this.sendJson(res, 200, { closed: true })
                return
            }

            this.sendJson(res, 404, { error: 'Not found' })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            const status = error instanceof HttpError ? error.status : 500
            this.sendJson(res, status, { error: message })
        } finally {
            this.traceRequest(req, res, startTime, url.pathname)
        }
    }

    private async getOrCreateSession(name: string, options: { noHeadless?: boolean } = {}): Promise<BrowserSession> {
        const existing = this.sessions.get(name)
        if (existing?.isUsable()) {
            return existing
        }
        if (existing) {
            const tracing = this.tracingSessions.get(name)
            if (tracing) {
                await tracing.close()
                this.tracingSessions.delete(name)
            }
            await existing.close()
            this.sessions.delete(name)
        }

        const session = new BrowserSession(name, { headless: !options.noHeadless })
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
            case 'capture': {
                const [urlArg, optionsArg] = this.normalizeCaptureArgs(args)
                return session.capture(
                    urlArg,
                    optionsArg?.viewport as { width: number; height: number } | undefined,
                    this.parseDepth(optionsArg?.depth),
                    this.parseExpand(optionsArg?.expand),
                    this.parseQuery(optionsArg?.query),
                    this.parseLoadOptions(optionsArg?.options)
                )
            }
            case 'snapshot': {
                const [urlArg, optionsArg] = this.normalizeCaptureArgs(args)
                return session.snapshot(
                    urlArg,
                    optionsArg?.viewport as { width: number; height: number } | undefined,
                    this.parseDepth(optionsArg?.depth),
                    this.parseExpand(optionsArg?.expand),
                    this.parseQuery(optionsArg?.query),
                    this.parseLoadOptions(optionsArg?.options)
                )
            }
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

    private parseDepth(value: unknown): number {
        if (value === undefined || value === null) {
            return 1
        }
        const n = typeof value === 'number' ? value : parseInt(String(value), 10)
        if (!Number.isSafeInteger(n) || n < 1) {
            throw new HttpError(400, 'Invalid depth. Use an integer >= 1.')
        }
        return n
    }

    private parseOptionalString(value: unknown, name: string): string | undefined {
        if (value === undefined || value === null) {
            return undefined
        }
        if (typeof value !== 'string') {
            throw new HttpError(400, `Invalid ${name}. Must be a string.`)
        }
        return value
    }

    private parseRequiredString(value: unknown, name: string): string {
        const parsed = this.parseOptionalString(value, name)
        if (parsed === undefined) {
            throw new HttpError(400, `${name} is required.`)
        }
        return parsed
    }

    private parseNumber(value: unknown, name: string): number {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new HttpError(400, `Invalid ${name}. Must be a finite number.`)
        }
        return value
    }

    private parseOptionalNumber(value: unknown, name: string): number | undefined {
        if (value === undefined || value === null) {
            return undefined
        }
        return this.parseNumber(value, name)
    }

    private parseViewport(value: unknown): { width: number; height: number } | undefined {
        if (value === undefined || value === null) {
            return undefined
        }
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new HttpError(400, 'Invalid viewport. Must contain positive width and height.')
        }
        const viewport = value as Record<string, unknown>
        const width = this.parseNumber(viewport.width, 'viewport.width')
        const height = this.parseNumber(viewport.height, 'viewport.height')
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
            throw new HttpError(400, 'Invalid viewport. Width and height must be positive integers.')
        }
        return { width, height }
    }

    private parseDirection(value: unknown): 'up' | 'down' | 'left' | 'right' {
        if (value === 'up' || value === 'down' || value === 'left' || value === 'right') {
            return value
        }
        throw new HttpError(400, 'Invalid scroll direction.')
    }

    private parseStringArray(value: unknown, name: string): string[] | undefined {
        if (value === undefined || value === null) {
            return undefined
        }
        if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
            throw new HttpError(400, `Invalid ${name}. Must be an array of strings.`)
        }
        return value
    }

    private parseWaitCondition(body: Record<string, unknown>): WaitCondition {
        const condition: WaitCondition = {}
        const selector = this.parseOptionalString(body.selector, 'selector')
        const text = this.parseOptionalString(body.text, 'text')
        const fn = this.parseOptionalString(body.fn, 'fn')
        const timeout = this.parseOptionalNumber(body.timeout, 'timeout')
        const loadState = this.parseOptionalString(body.loadState, 'loadState')
        if (loadState !== undefined && loadState !== 'load' && loadState !== 'domcontentloaded' && loadState !== 'networkidle') {
            throw new HttpError(400, 'Invalid loadState.')
        }
        if (timeout !== undefined && timeout <= 0) {
            throw new HttpError(400, 'Invalid timeout. Must be positive.')
        }
        if (selector) condition.selector = selector
        if (text) condition.text = text
        if (fn) condition.fn = fn
        if (timeout !== undefined) condition.timeout = timeout
        if (loadState) condition.loadState = loadState
        if (Object.keys(condition).length === 0) {
            throw new HttpError(400, 'Wait condition not provided.')
        }
        return condition
    }

    private parseNetworkTrackingOptions(body: Record<string, unknown>): NetworkTrackingOptions {
        const captureBodies = body.captureBodies
        if (captureBodies !== undefined && typeof captureBodies !== 'boolean') {
            throw new HttpError(400, 'Invalid captureBodies. Must be a boolean.')
        }
        const maxBodyBytes = this.parseOptionalNumber(body.maxBodyBytes, 'maxBodyBytes')
        if (maxBodyBytes !== undefined && (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0 || maxBodyBytes > 1024 * 1024)) {
            throw new HttpError(400, 'Invalid maxBodyBytes. Use an integer from 0 to 1048576.')
        }
        return {
            ...(captureBodies === undefined ? {} : { captureBodies }),
            ...(maxBodyBytes === undefined ? {} : { maxBodyBytes })
        }
    }

    private parseExpand(value: unknown): Set<string> {
        if (!value) {
            return new Set()
        }
        if (!Array.isArray(value)) {
            throw new Error('Invalid expand. Use an array of element ids.')
        }
        const set = new Set<string>()
        for (const raw of value) {
            if (typeof raw !== 'string') {
                throw new Error('Invalid expand. Each id must be a string.')
            }
            const id = raw.startsWith('@') ? raw.slice(1) : raw
            if (id.length > 0) {
                set.add(id)
            }
        }
        return set
    }

    private parseQuery(value: unknown): string | undefined {
        if (value === undefined || value === null || value === '') {
            return undefined
        }
        if (typeof value !== 'string') {
            throw new Error('Invalid query. Must be a CSS selector string.')
        }
        return value
    }

    private parseNoHeadless(value: unknown): boolean {
        if (value === undefined || value === null) {
            return false
        }
        if (typeof value !== 'boolean') {
            throw new Error('Invalid noHeadless. Must be a boolean.')
        }
        return value
    }

    private parseSessionName(value: unknown): string {
        if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..' || /[\\/]/.test(value)) {
            throw new Error('Invalid session name.')
        }
        return value
    }

    private parseLoadOptions(value: unknown): { skipLoad?: boolean, noLoad?: boolean } {
        if (value === undefined || value === null) {
            return {}
        }
        if (typeof value !== 'object') {
            throw new Error('Invalid load options. Must be an object.')
        }
        const opts = value as Record<string, unknown>
        const result: { skipLoad?: boolean, noLoad?: boolean } = {}
        if (opts.skipLoad === true) {
            result.skipLoad = true
        }
        if (opts.noLoad === true) {
            result.noLoad = true
        }
        return result
    }

    private normalizeCaptureArgs(
        args: unknown[]
    ): [string | undefined, { viewport?: unknown; depth?: unknown; expand?: unknown; query?: unknown; options?: unknown } | undefined] {
        if (args.length === 0) {
            return [undefined, undefined]
        }
        const [first, second] = args
        if (first && typeof first === 'object' && !Array.isArray(first)) {
            const obj = first as { url?: unknown; viewport?: unknown; depth?: unknown; expand?: unknown; query?: unknown; options?: unknown }
            return [obj.url as string | undefined, obj]
        }
        if (second && typeof second === 'object' && !Array.isArray(second)) {
            return [first as string | undefined, second as { viewport?: unknown; depth?: unknown; expand?: unknown; query?: unknown; options?: unknown }]
        }
        return [first as string | undefined, undefined]
    }

    private isAuthorized(req: http.IncomingMessage): boolean {
        const authorization = req.headers.authorization
        if (!authorization?.startsWith('Bearer ')) {
            return false
        }
        const provided = Buffer.from(authorization.slice('Bearer '.length))
        const expected = Buffer.from(this.token)
        return provided.length === expected.length && timingSafeEqual(provided, expected)
    }

    private readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const contentLength = Number(req.headers['content-length'])
            if (Number.isFinite(contentLength) && contentLength > this.maxRequestBodyBytes) {
                req.resume()
                reject(new HttpError(413, 'Request body too large.'))
                return
            }

            const chunks: Buffer[] = []
            let bodyBytes = 0
            let settled = false
            req.on('data', (chunk: Buffer | string) => {
                if (settled) {
                    return
                }
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                bodyBytes += buffer.byteLength
                if (bodyBytes > this.maxRequestBodyBytes) {
                    settled = true
                    reject(new HttpError(413, 'Request body too large.'))
                    return
                }
                chunks.push(buffer)
            })
            req.on('end', () => {
                if (settled) {
                    return
                }
                const body = Buffer.concat(chunks).toString('utf8')
                try {
                    const parsed: unknown = body ? JSON.parse(body) : {}
                    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                        throw new Error('Expected a JSON object')
                    }
                    resolve(parsed as Record<string, unknown>)
                } catch {
                    reject(new HttpError(400, 'Invalid JSON request body.'))
                }
            })
            req.on('error', reject)
        })
    }

    private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
    }

    private getSessionPage(session: BrowserSession): Page {
        const page = session.getPage()
        if (!page) {
            throw new Error('Session not started. Capture a page first.')
        }
        return page
    }

    private traceRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        startTime: number,
        pathname: string
    ): void {
        const durationMs = Date.now() - startTime
        const record = {
            method: req.method ?? '',
            path: pathname,
            status: res.statusCode,
            durationMs,
            timestamp: Date.now()
        }
        const line = JSON.stringify(record) + '\n'
        try {
            process.stderr.write(line)
        } catch {
            /* ignore */
        }
        const traceFile = process.env.VIEWPRINT_HTTP_TRACE_FILE
        if (traceFile) {
            try {
                fs.appendFileSync(traceFile, line)
            } catch {
                /* ignore */
            }
        }
    }
}

export async function startDaemon(options: DaemonOptions): Promise<ViewPrintDaemon> {
    const daemon = new ViewPrintDaemon(options)
    await daemon.start()
    return daemon
}
