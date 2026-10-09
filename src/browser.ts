import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type BrowserServer, type Cookie, type ElementHandle, type Frame, type Page, type Request, type Response } from 'playwright'
import { extractSnapshotData, inspectElement } from './extractor.js'
import { buildGraph } from './graph.js'
import { killProcessTree, isProcessAlive, hasOrphanedChromeProcesses, killChromeProcessesByUserDataDir } from './process-tree.js'
import { loadSession, saveSession } from './session.js'
import { getPackageVersion } from './version.js'
import type { ActionReport, ActionTiming, ElementNode, Graph, NetworkRequest, NetworkRoute, SessionState, Snapshot, SnapshotNode } from './types.js'

export interface WaitCondition {
    selector?: string
    text?: string
    timeout?: number
    loadState?: 'load' | 'domcontentloaded' | 'networkidle'
    fn?: string
}

export interface BrowserSessionOptions {
    headless?: boolean
    stateCheckpointIntervalMs?: number
}

export interface NetworkTrackingOptions {
    captureBodies?: boolean
    maxBodyBytes?: number
}

const STATE_PERSIST_DEBOUNCE_MS = 150
const STATE_PERSIST_CHECKPOINT_MS = 30_000
const MAX_NETWORK_REQUESTS = 1_000
const DEFAULT_NETWORK_BODY_LIMIT_BYTES = 64 * 1024
const NETWORK_SENSITIVE_HEADER = /authorization|cookie|token|secret|password|api[-_]?key/i

export function getBrowserLaunchOptions(options: BrowserSessionOptions = {}): { headless: boolean } {
    return { headless: options.headless ?? true }
}

export class BrowserSession {
    private name: string
    private headless: boolean
    private stateCheckpointIntervalMs: number
    private server: BrowserServer | null = null
    private browser: Browser | null = null
    private context: BrowserContext | null = null
    private page: Page | null = null
    private state: SessionState
    private activeFrame: Frame | null = null
    private pageTabIds = new WeakMap<Page, string>()
    private nextTabId = 1
    private requestMap = new Map<Request, NetworkRequest>()
    private requestHandler?: (request: Request) => void
    private responseHandler?: (response: Response) => void
    private captureNetworkBodies = false
    private networkBodyLimitBytes = DEFAULT_NETWORK_BODY_LIMIT_BYTES
    private harPath?: string
    private browserPid: number | null = null
    private userDataDir: string | null = null
    private closing = false
    private profiling = false
    private timings: ActionTiming[] = []
    private statePersistTimer: NodeJS.Timeout | null = null
    private stateCheckpointTimer: NodeJS.Timeout | null = null
    private statePersistInFlight: Promise<void> | null = null
    private stateVersion = 0
    private stateDirty = false
    private lastGraph: Graph | null = null
    private previousGraph: Graph | null = null

    constructor(name: string, options: BrowserSessionOptions = {}) {
        this.name = name
        this.headless = options.headless ?? true
        this.stateCheckpointIntervalMs = Math.max(10, options.stateCheckpointIntervalMs ?? STATE_PERSIST_CHECKPOINT_MS)
        this.state = loadSession(name)
    }

    isHeadless(): boolean {
        return this.headless
    }

    isUsable(): boolean {
        return !this.closing && this.page !== null && !this.page.isClosed() && (this.browser?.isConnected() ?? false)
    }

    async start(): Promise<void> {
        this.server = await chromium.launchServer(getBrowserLaunchOptions({ headless: this.headless }))
        this.browserPid = this.server.process().pid ?? null
        this.userDataDir = extractUserDataDir(this.server.process().spawnargs)
        this.browser = await chromium.connect(this.server.wsEndpoint())
        this.context = await this.browser.newContext({ storageState: this.buildStorageState() })

        const savedTabs = this.state.tabs.length > 0
            ? this.state.tabs
            : [{ id: this.state.activeTabId ?? 'tab-1', url: this.state.url ?? 'about:blank' }]
        this.pageTabIds = new WeakMap<Page, string>()
        const pages: Page[] = []
        for (const tab of savedTabs) {
            const page = await this.context.newPage()
            this.pageTabIds.set(page, tab.id)
            await this.installStorageRestore(page, tab.id)
            if (this.state.viewport) {
                await page.setViewportSize(this.state.viewport)
            }
            pages.push(page)
            const numericId = Number(tab.id.match(/(\d+)$/)?.[1] ?? 0)
            this.nextTabId = Math.max(this.nextTabId, numericId + 1)
        }

        const activeTabId = this.state.activeTabId ?? savedTabs[0]?.id
        const activeIndex = savedTabs.findIndex((tab) => tab.id === activeTabId)
        this.page = pages[activeIndex >= 0 ? activeIndex : 0] ?? await this.context.newPage()
        if (!this.pageTabIds.has(this.page)) {
            this.pageTabIds.set(this.page, this.createTabId())
        }
        this.state.activeTabId = this.pageTabIds.get(this.page)
        if (this.page.url() !== 'about:blank') {
            this.state.url = this.page.url()
        } else {
            const savedActiveTab = savedTabs.find((tab) => tab.id === this.state.activeTabId)
            this.state.url = savedActiveTab?.url === 'about:blank'
                ? undefined
                : savedActiveTab?.url ?? this.state.url
        }
        this.activeFrame = null
        this.startStatePersistence()
    }

    private startStatePersistence(): void {
        this.stateCheckpointTimer = setInterval(() => {
            void this.persistState(true).catch((error: unknown) => {
                console.error('Background state persistence error:', error)
            })
        }, this.stateCheckpointIntervalMs)
        this.stateCheckpointTimer.unref()
    }

    private stopStatePersistence(): void {
        if (this.statePersistTimer !== null) {
            clearTimeout(this.statePersistTimer)
            this.statePersistTimer = null
        }
        if (this.stateCheckpointTimer !== null) {
            clearInterval(this.stateCheckpointTimer)
            this.stateCheckpointTimer = null
        }
    }

    private markStateDirty(): void {
        this.stateVersion++
        this.stateDirty = true
        if (this.statePersistTimer !== null || this.closing) {
            return
        }
        this.statePersistTimer = setTimeout(() => {
            this.statePersistTimer = null
            void this.persistState(true).catch((error: unknown) => {
                console.error('Background state persistence error:', error)
            })
        }, STATE_PERSIST_DEBOUNCE_MS)
        this.statePersistTimer.unref()
    }

    async capture(
        url?: string,
        viewport?: { width: number; height: number },
        depth: number = 1,
        expand: Set<string> = new Set(),
        query?: string,
        options?: { skipLoad?: boolean, noLoad?: boolean }
    ): Promise<Graph> {
        return this.timed('capture', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }

            const savedUrl = this.page.url() === 'about:blank' ? this.state.url : undefined
            const targetUrl = url ?? savedUrl
            const skipGoto = options?.noLoad === true
                || (options?.skipLoad === true && Boolean(targetUrl) && this.page.url() === targetUrl)

            if (targetUrl && !skipGoto && (this.page.url() !== targetUrl || Boolean(url))) {
                await this.persistState(true)
                await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' })
                this.state.url = this.page.url()
                this.activeFrame = null
                this.updateActiveTabUrl()
                this.markStateDirty()
            }

            if (!this.state.url && this.page.url() !== 'about:blank') {
                this.state.url = this.page.url()
            }
            if (!this.state.url || (this.page.url() === 'about:blank' && options?.noLoad)) {
                throw new Error('URL not provided. Use capture <url> or start with a saved URL.')
            }

            if (viewport) {
                await this.page.setViewportSize(viewport)
            }

            const frame = this.targetFrame()
            if (frame.isDetached()) {
                this.activeFrame = null
                throw new Error('Selected frame is detached. Switch to frames main and select another frame.')
            }
            const rawData = await frame.evaluate(extractSnapshotData)
            const currentViewport = this.page.viewportSize() || { width: 0, height: 0 }
            this.state.viewport = currentViewport

            const expandedIds = new Set(expand)
            if (query) {
                const queryIds = await this.resolveQuery(query)
                for (const id of queryIds) {
                    expandedIds.add(id)
                }
            }

            await this.persistState()

            const graph = buildGraph(rawData, frame.url() || this.state.url, currentViewport, depth, expandedIds, query !== undefined)
            this.previousGraph = this.lastGraph
            this.lastGraph = graph
            return graph
        })
    }

    async snapshot(
        url?: string,
        viewport?: { width: number; height: number },
        depth: number = 1,
        expand: Set<string> = new Set(),
        query?: string,
        options?: { skipLoad?: boolean, noLoad?: boolean }
    ): Promise<Snapshot> {
        return this.timed('snapshot', async () => {
            const graph = await this.capture(url, viewport, depth, expand, query, options)
            if (graph.tree.length === 0) {
                return { url: graph.url, viewport: graph.viewport, tree: [] }
            }

            const tree: Snapshot['tree'] = graph.tree.map((root) => ({
                ref: root.id,
                tag: root.tag,
                role: root.role,
                name: root.name,
                text: root.text,
                boundingBox: root.boundingBox,
                childrenCount: root.childrenCount,
                children: buildSnapshotTree(root.children)
            }))

            return { url: graph.url, viewport: graph.viewport, tree }
        })
    }

    private async resolveQuery(selector: string): Promise<string[]> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        return this.targetFrame().evaluate((sel: string) => {
            const elements = document.querySelectorAll(sel)
            const registry = (window as unknown as Record<PropertyKey, unknown>)[Symbol.for('starframe.viewprint.element-registry.v1')] as
                | { ids: WeakMap<Element, string> }
                | undefined
            return Array.from(elements)
                .map((element) => registry?.ids.get(element))
                .filter((id): id is string => id !== undefined)
        }, selector)
    }

    async inspect(elementId: string): Promise<ElementNode | null> {
        return this.timed('inspect', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }

            if (!this.state.url) {
                throw new Error('URL not provided. Capture a page first.')
            }

            return this.targetFrame().evaluate(inspectElement, normalizeElementRef(elementId))
        })
    }

    async click(elementId: string): Promise<void> {
        return this.timed('click', async () => {
            const element = await this.getElementHandle(elementId)
            try {
                await element.click()
            } finally {
                await element.dispose()
            }
            await this.page!.waitForTimeout(100)
            this.updateActiveTabUrl()
            await this.persistState()
        })
    }

    async clickQuery(selector: string): Promise<void> {
        return this.timed('clickQuery', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            await this.targetFrame().locator(selector).click()
            await this.page.waitForTimeout(100)
            this.updateActiveTabUrl()
            await this.persistState()
        })
    }

    async fill(elementId: string, text: string): Promise<void> {
        return this.timed('fill', async () => {
            const element = await this.getElementHandle(elementId)
            try {
                await element.fill(text)
            } finally {
                await element.dispose()
            }
            await this.persistState()
        })
    }

    async fillQuery(selector: string, text: string): Promise<void> {
        return this.timed('fillQuery', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            await this.targetFrame().locator(selector).fill(text)
            await this.persistState()
        })
    }

    async type(elementId: string, text: string): Promise<void> {
        return this.timed('type', async () => {
            const element = await this.getElementHandle(elementId)
            try {
                await element.type(text)
            } finally {
                await element.dispose()
            }
            await this.persistState()
        })
    }

    async hover(elementId: string): Promise<void> {
        return this.timed('hover', async () => {
            const element = await this.getElementHandle(elementId)
            try {
                await element.hover()
            } finally {
                await element.dispose()
            }
            await this.persistState()
        })
    }

    async focus(elementId: string): Promise<void> {
        return this.timed('focus', async () => {
            const element = await this.getElementHandle(elementId)
            try {
                await element.focus()
            } finally {
                await element.dispose()
            }
            await this.persistState()
        })
    }

    async press(key: string): Promise<void> {
        return this.timed('press', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }

            await this.page.keyboard.press(key)
            await this.persistState()
        })
    }

    async scroll(direction: 'up' | 'down' | 'left' | 'right', px: number, elementId?: string): Promise<void> {
        return this.timed('scroll', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }

            const dx = direction === 'left' ? -px : direction === 'right' ? px : 0
            const dy = direction === 'up' ? -px : direction === 'down' ? px : 0

            if (elementId) {
                const element = await this.getElementHandle(elementId)
                try {
                    await element.evaluate((target, delta) => target.scrollBy(delta.dx, delta.dy), { dx, dy })
                } finally {
                    await element.dispose()
                }
            } else {
                await this.targetFrame().evaluate(({ dx, dy }) => window.scrollBy(dx, dy), { dx, dy })
            }

            await this.persistState()
        })
    }

    async scrollIntoView(elementId: string): Promise<void> {
        return this.timed('scrollIntoView', async () => {
            const element = await this.getElementHandle(elementId)
            try {
                await element.scrollIntoViewIfNeeded()
            } finally {
                await element.dispose()
            }
            await this.persistState()
        })
    }

    async wait(condition: WaitCondition): Promise<void> {
        return this.timed('wait', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }

            const timeout = condition.timeout ?? 5000

            const frame = this.targetFrame()
            if (condition.selector) {
                await frame.waitForSelector(condition.selector, { timeout, state: 'visible' })
            } else if (condition.text) {
                await frame.waitForFunction(
                    (text) => document.body.innerText.includes(text),
                    condition.text,
                    { timeout }
                )
            } else if (condition.loadState) {
                await frame.waitForLoadState(condition.loadState, { timeout })
            } else if (condition.fn) {
                await frame.waitForFunction(condition.fn, undefined, { timeout })
            } else if (condition.timeout) {
                await this.page.waitForTimeout(condition.timeout)
            } else {
                throw new Error('Wait condition not provided')
            }

            await this.persistState()
        })
    }

    async eval(script: string): Promise<unknown> {
        return this.timed('eval', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }

            const result = await this.targetFrame().evaluate((script) => {
                return eval(script)
            }, script)
            await this.persistState()
            return result
        })
    }

    async startNetworkTracking(options: NetworkTrackingOptions = {}): Promise<void> {
        if (!this.context) {
            throw new Error('Session not started. Call start() first.')
        }
        if (this.requestHandler && this.responseHandler) {
            return
        }

        this.requestMap.clear()
        this.captureNetworkBodies = options.captureBodies ?? false
        const requestedLimit = options.maxBodyBytes ?? DEFAULT_NETWORK_BODY_LIMIT_BYTES
        this.networkBodyLimitBytes = Math.max(0, Math.min(requestedLimit, 1024 * 1024))
        this.requestHandler = (request: Request) => {
            this.requestMap.set(request, {
                url: request.url(),
                method: request.method(),
                headers: redactHeaders(request.headers()),
                timestamp: Date.now()
            })
            while (this.requestMap.size > MAX_NETWORK_REQUESTS) {
                const oldest = this.requestMap.keys().next().value
                if (oldest === undefined) {
                    break
                }
                this.requestMap.delete(oldest)
            }
        }

        this.responseHandler = async (response: Response) => {
            const entry = this.requestMap.get(response.request())
            if (!entry) {
                return
            }
            entry.status = response.status()
            const headers = response.headers()
            entry.responseHeaders = redactHeaders(headers)
            if (!this.captureNetworkBodies || this.networkBodyLimitBytes === 0) {
                return
            }

            const contentType = headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
            const declaredBytes = Number(headers['content-length'])
            const isText = /^text\//.test(contentType)
                || /^application\/(?:[^;]+\+)?(?:json|xml|javascript|x-www-form-urlencoded)$/.test(contentType)
            if (!isText || !Number.isSafeInteger(declaredBytes) || declaredBytes < 0
                || declaredBytes > this.networkBodyLimitBytes) {
                return
            }

            try {
                const body = await response.body()
                if (body.byteLength <= this.networkBodyLimitBytes) {
                    entry.responseBody = body.toString('utf8')
                }
            } catch {
                entry.responseBody = undefined
            }
        }

        this.context.on('request', this.requestHandler)
        this.context.on('response', this.responseHandler)
    }

    async stopNetworkTracking(): Promise<void> {
        if (!this.context) {
            return
        }
        if (this.requestHandler) {
            this.context.off('request', this.requestHandler)
        }
        if (this.responseHandler) {
            this.context.off('response', this.responseHandler)
        }
        this.requestHandler = undefined
        this.responseHandler = undefined
    }

    getNetworkRequests(): NetworkRequest[] {
        return Array.from(this.requestMap.values())
    }

    clearNetworkRequests(): void {
        this.requestMap.clear()
    }

    async startHar(path?: string, options: NetworkTrackingOptions = {}): Promise<{ path: string }> {
        this.requestMap.clear()
        if (this.requestHandler) {
            await this.stopNetworkTracking()
        }
        await this.startNetworkTracking(options)
        this.harPath = path ?? `viewprint-${Date.now()}.har.json`
        return { path: this.harPath }
    }

    async stopHar(path?: string): Promise<{ path: string }> {
        const outputPath = path ?? this.harPath ?? `viewprint-${Date.now()}.har.json`
        await this.stopNetworkTracking()
        this.harPath = undefined

        const fs = await import('node:fs/promises')
        await fs.writeFile(outputPath, JSON.stringify({
            log: {
                version: '1.2',
                creator: { name: 'viewprint', version: getPackageVersion() },
                entries: this.getNetworkRequests().map((req) => ({
                    request: {
                        method: req.method,
                        url: req.url,
                        headers: Object.entries(req.headers).map(([name, value]) => ({ name, value }))
                    },
                    response: {
                        status: req.status ?? 0,
                        headers: Object.entries(req.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
                        content: { text: req.responseBody }
                    }
                }))
            }
        }, null, 2))

        return { path: outputPath }
    }

    async route(url: string, options: NetworkRoute): Promise<void> {
        return this.timed('route', async () => {
            if (!this.context) {
                throw new Error('Session not started. Call start() first.')
            }

            await this.context.route(url, async (route) => {
                if (options.abort) {
                    await route.abort()
                } else if (options.body !== undefined) {
                    await route.fulfill({
                        status: options.status ?? 200,
                        body: options.body,
                        contentType: options.contentType ?? 'application/json'
                    })
                } else {
                    await route.continue()
                }
            })
        })
    }

    async unroute(url?: string): Promise<void> {
        return this.timed('unroute', async () => {
            if (!this.context) {
                return
            }
            await this.context.unroute(url ?? '**/*')
        })
    }

    async getCookies(): Promise<Cookie[]> {
        if (!this.context) {
            throw new Error('Session not started. Call start() first.')
        }
        return this.context.cookies()
    }

    async setCookie(name: string, value: string, domain?: string, path?: string): Promise<void> {
        return this.timed('setCookie', async () => {
            if (!this.context) {
                throw new Error('Session not started. Call start() first.')
            }
            if (!this.state.url) {
                throw new Error('URL not provided. Capture a page first.')
            }

            const cookieDomain = domain ?? new URL(this.state.url).hostname
            await this.context.addCookies([{ name, value, domain: cookieDomain, path: path ?? '/' }])
            await this.persistState()
        })
    }

    async clearCookies(): Promise<void> {
        return this.timed('clearCookies', async () => {
            if (!this.context) {
                throw new Error('Session not started. Call start() first.')
            }
            await this.context.clearCookies()
            await this.persistState()
        })
    }

    async getLocalStorage(): Promise<Record<string, string>> {
        return this.timed('getLocalStorage', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            return readWindowStorage(this.page, 'localStorage')
        })
    }

    async setLocalStorage(key: string, value: string): Promise<void> {
        return this.timed('setLocalStorage', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            await this.page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key, value })
            await this.persistState()
        })
    }

    async clearLocalStorage(): Promise<void> {
        return this.timed('clearLocalStorage', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            await this.page.evaluate(() => localStorage.clear())
            await this.persistState()
        })
    }

    async getSessionStorage(): Promise<Record<string, string>> {
        return this.timed('getSessionStorage', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            return readWindowStorage(this.page, 'sessionStorage')
        })
    }

    async setSessionStorage(key: string, value: string): Promise<void> {
        return this.timed('setSessionStorage', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            await this.page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), { key, value })
            await this.persistState()
        })
    }

    async clearSessionStorage(): Promise<void> {
        return this.timed('clearSessionStorage', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            await this.page.evaluate(() => sessionStorage.clear())
            await this.persistState()
        })
    }

    async status(): Promise<{ url?: string; elementCount: number }> {
        return this.timed('status', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }

            const frame = this.targetFrame()
            const count = await frame.evaluate(() => document.querySelectorAll('body, body *').length)
            return { url: frame.url() || this.state.url, elementCount: count }
        })
    }

    async close(): Promise<void> {
        if (this.closing) {
            return
        }
        this.closing = true
        this.stopStatePersistence()
        await this.stopNetworkTracking()

        try {
            await this.persistState(true)
        } catch (error) {
            console.error('persistState error during close:', error)
        }

        // Try graceful Playwright close with a short timeout
        const gracefulClose = (async () => {
            try {
                await this.context?.close()
            } catch (error) {
                console.error('context.close error:', error)
            }
            try {
                await this.browser?.close()
            } catch (error) {
                console.error('browser.close error:', error)
            }
            try {
                await this.server?.close()
            } catch (error) {
                console.error('server.close error:', error)
            }
        })()

        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000))
        await Promise.race([gracefulClose, timeout])

        // If browser process is still alive, kill its process tree as fallback
        if (this.browserPid !== null && isProcessAlive(this.browserPid)) {
            killProcessTree(this.browserPid)
            await new Promise<void>((resolve) => setTimeout(resolve, 500))
            if (isProcessAlive(this.browserPid)) {
                killProcessTree(this.browserPid, 'SIGKILL')
                await new Promise<void>((resolve) => setTimeout(resolve, 500))
            }
        }

        // Belt-and-suspenders: scan for orphaned chrome processes matching our user-data-dir
        if (this.userDataDir && hasOrphanedChromeProcesses(this.userDataDir)) {
            killChromeProcessesByUserDataDir(this.userDataDir, 'SIGTERM')
            await new Promise<void>((resolve) => setTimeout(resolve, 500))
            if (hasOrphanedChromeProcesses(this.userDataDir)) {
                killChromeProcessesByUserDataDir(this.userDataDir, 'SIGKILL')
            }
        }

        this.context = null
        this.browser = null
        this.server = null
        this.page = null
        this.activeFrame = null
        this.browserPid = null
        this.userDataDir = null
    }

    getState(): SessionState {
        return this.state
    }

    /**
     * Wraps an async function with timing instrumentation.
     * Records duration into `this.timings` when profiling is enabled.
     */
    private async timed<T>(action: string, fn: () => Promise<T>): Promise<T> {
        if (!this.profiling) {
            return fn()
        }
        const start = performance.now()
        try {
            return await fn()
        } finally {
            this.timings.push({
                action,
                durationMs: performance.now() - start,
                timestamp: Date.now()
            })
        }
    }

    getName(): string {
        return this.name
    }

    private targetFrame(): Frame {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        if (this.activeFrame?.isDetached()) {
            this.activeFrame = null
            throw new Error('Selected frame is detached. Switch to frames main and select another frame.')
        }
        return this.activeFrame ?? this.page.mainFrame()
    }

    private async ensureElementIds(): Promise<void> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        await this.targetFrame().evaluate(extractSnapshotData)
    }

    private async getElementHandle(elementId: string): Promise<ElementHandle<HTMLElement>> {
        await this.ensureElementIds()
        const handle = await this.targetFrame().evaluateHandle((ref) => {
            const registry = (window as unknown as Record<PropertyKey, unknown>)[Symbol.for('starframe.viewprint.element-registry.v1')] as
                | { elements: Map<string, WeakRef<Element>> }
                | undefined
            return registry?.elements.get(ref)?.deref() ?? null
        }, normalizeElementRef(elementId))
        const element = handle.asElement()
        if (!element) {
            await handle.dispose()
            throw new Error(`Element not found: ${elementId}`)
        }
        return element as ElementHandle<HTMLElement>
    }

    private createTabId(): string {
        const tabId = `tab-${this.nextTabId}`
        this.nextTabId++
        return tabId
    }

    private updateActiveTabUrl(): void {
        if (!this.page || !this.context) {
            return
        }
        const pages = this.context.pages()
        const previousUrls = new Map(this.state.tabs.map((tab) => [tab.id, tab.url]))
        const activeTabId = this.pageTabIds.get(this.page) ?? this.createTabId()
        this.pageTabIds.set(this.page, activeTabId)
        this.state.tabs = pages.map((page) => {
            let id = this.pageTabIds.get(page)
            if (!id) {
                id = this.createTabId()
                this.pageTabIds.set(page, id)
            }
            const url = page.url() === 'about:blank'
                ? previousUrls.get(id) ?? 'about:blank'
                : page.url()
            return { id, url }
        })
        this.state.activeTabId = activeTabId
        const activeTab = this.state.tabs.find((tab) => tab.id === activeTabId)
        if (activeTab) {
            this.state.url = activeTab.url === 'about:blank' ? undefined : activeTab.url
        }
    }

    private async installStorageRestore(page: Page, tabId: string): Promise<void> {
        const localStorageByOrigin = this.state.localStorage
        const sessionStorageByOrigin = this.state.sessionStorage[tabId] ?? {}
        await page.addInitScript(({ localStorageByOrigin, sessionStorageByOrigin }) => {
            const origin = window.location.origin
            try {
                for (const [key, value] of Object.entries(localStorageByOrigin[origin] ?? {})) {
                    window.localStorage.setItem(key, value)
                }
                for (const [key, value] of Object.entries(sessionStorageByOrigin[origin] ?? {})) {
                    window.sessionStorage.setItem(key, value)
                }
            } catch {
                // Storage is unavailable for opaque or sandboxed origins.
            }
        }, { localStorageByOrigin, sessionStorageByOrigin })
    }

    private buildStorageState(): Exclude<BrowserContextOptions['storageState'], string> {
        const origins = Object.entries(this.state.localStorage).map(([origin, values]) => ({
            origin,
            localStorage: Object.entries(values).map(([name, value]) => ({ name, value }))
        }))
        if (this.state.cookies.length === 0 && origins.length === 0) {
            return undefined
        }
        return { cookies: this.state.cookies as Cookie[], origins }
    }
    async newTab(url?: string): Promise<void> {
        return this.timed('newTab', async () => {
            if (!this.context) {
                throw new Error('Session not started. Call start() first.')
            }
            const newPage = await this.context.newPage()
            const tabId = this.createTabId()
            this.pageTabIds.set(newPage, tabId)
            await this.installStorageRestore(newPage, tabId)
            if (url) {
                await newPage.goto(url, { waitUntil: 'domcontentloaded' })
            }
            this.page = newPage
            this.activeFrame = null
            this.updateActiveTabUrl()
            await this.persistState()
        })
    }

    async switchTab(index: number): Promise<void> {
        return this.timed('switchTab', async () => {
            if (!this.context) {
                throw new Error('Session not started. Call start() first.')
            }
            const pages = this.context.pages()
            if (index < 0 || index >= pages.length) {
                throw new Error(`Tab index ${index} out of range`)
            }
            this.page = pages[index]
            this.activeFrame = null
            this.updateActiveTabUrl()
            await this.persistState()
        })
    }

    async closeTab(index?: number): Promise<void> {
        return this.timed('closeTab', async () => {
            if (!this.context) {
                throw new Error('Session not started. Call start() first.')
            }
            const pages = this.context.pages()
            if (pages.length <= 1) {
                throw new Error('Cannot close the only tab')
            }
            const targetIndex = index ?? pages.length - 1
            if (targetIndex < 0 || targetIndex >= pages.length) {
                throw new Error(`Tab index ${targetIndex} out of range`)
            }
            await pages[targetIndex].close()
            const remaining = this.context.pages()
            this.page = remaining[Math.max(0, targetIndex - 1)] ?? remaining[0]
            this.activeFrame = null
            this.updateActiveTabUrl()
            await this.persistState()
        })
    }

    async listTabs(): Promise<Array<{ index: number; url: string; title: string }>> {
        return this.timed('listTabs', async () => {
            if (!this.context) {
                throw new Error('Session not started. Call start() first.')
            }
            const pages = this.context.pages()
            const titles = await Promise.all(pages.map((page) => page.title()))
            return pages.map((page, index) => ({
                index,
                url: page.url(),
                title: titles[index]
            }))
        })
    }

    async switchFrame(selector: string): Promise<void> {
        return this.timed('switchFrame', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            const frames = this.page.locator(selector)
            const count = await frames.count()
            for (let index = 0; index < count; index++) {
                const element = await frames.nth(index).elementHandle()
                if (!element) {
                    continue
                }
                const frame = await element.contentFrame()
                await element.dispose()
                if (frame && !frame.isDetached()) {
                    this.activeFrame = frame
                    return
                }
            }
            throw new Error(`Frame not found for selector: ${selector}`)
        })
    }

    async switchFrameMain(): Promise<void> {
        return this.timed('switchFrameMain', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            this.activeFrame = null
        })
    }

    async listFrames(): Promise<Array<{ name: string; url: string }>> {
        return this.timed('listFrames', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            return this.page.frames().map((frame) => ({
                name: frame.name() || '',
                url: frame.url()
            }))
        })
    }

    async screenshotPage(path?: string): Promise<string> {
        return this.timed('screenshotPage', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            const outputPath = path ?? this.defaultScreenshotPath('page')
            await this.page.screenshot({ path: outputPath, fullPage: true })
            return outputPath
        })
    }

    async screenshotElement(elementId: string, padding: number = 0, path?: string): Promise<string> {
        return this.timed('screenshotElement', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            const element = await this.getElementHandle(elementId)
            const outputPath = path ?? this.defaultScreenshotPath('element')
            try {
                if (padding <= 0) {
                    await element.screenshot({ path: outputPath })
                    return outputPath
                }
                if (this.activeFrame) {
                    throw new Error('Element screenshot padding is not supported inside a frame.')
                }

                const bbox = await element.boundingBox()
                if (!bbox) {
                    throw new Error(`Element ${elementId} not found or not visible`)
                }
                const viewport = this.page.viewportSize() ?? { width: bbox.width + 2 * padding, height: bbox.height + 2 * padding }
                const clip = {
                    x: Math.max(0, Math.floor(bbox.x - padding)),
                    y: Math.max(0, Math.floor(bbox.y - padding)),
                    width: Math.min(
                        viewport.width - Math.max(0, Math.floor(bbox.x - padding)),
                        Math.ceil(bbox.width + 2 * padding)
                    ),
                    height: Math.min(
                        viewport.height - Math.max(0, Math.floor(bbox.y - padding)),
                        Math.ceil(bbox.height + 2 * padding)
                    )
                }
                await this.page.screenshot({ path: outputPath, clip })
                return outputPath
            } finally {
                await element.dispose()
            }
        })
    }

    private defaultScreenshotPath(type: 'page' | 'element'): string {
        const timestamp = Date.now()
        const root = path.join(os.homedir(), '.viewprint')
        const dir = path.join(root, 'screenshots')
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        fs.chmodSync(root, 0o700)
        fs.chmodSync(dir, 0o700)
        return path.join(dir, `${this.name}-${type}-${timestamp}.png`)
    }

    async read(format: 'text' | 'markdown' = 'text'): Promise<string> {
        return this.timed('read', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            return this.targetFrame().evaluate((fmt: string) => {
                const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])
                const BLOCK = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR'])

                function clean(node: Element): string {
                    let result = ''
                    for (const child of Array.from(node.childNodes)) {
                        if (child.nodeType === 1) {
                            const el = child as Element
                            const tag = el.tagName
                            if (SKIP.has(tag)) continue
                            const text = clean(el).trim()
                            if (!text) continue
                            if (tag === 'H1') result += '# ' + text + '\n\n'
                            else if (tag === 'H2') result += '## ' + text + '\n\n'
                            else if (tag === 'H3') result += '### ' + text + '\n\n'
                            else if (tag === 'H4') result += '#### ' + text + '\n\n'
                            else if (tag === 'H5') result += '##### ' + text + '\n\n'
                            else if (tag === 'H6') result += '###### ' + text + '\n\n'
                            else if (tag === 'P') result += text + '\n\n'
                            else if (tag === 'LI') result += '- ' + text + '\n'
                            else if (tag === 'A') result += '[' + text + '](' + (el as HTMLAnchorElement).href + ')'
                            else if (tag === 'STRONG' || tag === 'B') result += '**' + text + '**'
                            else if (tag === 'EM' || tag === 'I') result += '*' + text + '*'
                            else if (tag === 'CODE') result += '`' + text + '`'
                            else if (tag === 'BR') result += '\n'
                            else if (BLOCK.has(tag)) result += text + '\n\n'
                            else result += text
                        } else if (child.nodeType === 3) {
                            result += child.textContent ?? ''
                        }
                    }
                    return result
                }

                if (fmt === 'markdown') {
                    return clean(document.body).replace(/\n{3,}/g, '\n\n').trim()
                }
                return document.body.innerText
            }, format)
        })
    }

    private dialogHandler?: (dialog: { type: string; message: string }) => Promise<{ accept: boolean; promptText?: string }>

    async setDialogHandler(handler: (dialog: { type: string; message: string }) => Promise<{ accept: boolean; promptText?: string }>): Promise<void> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        this.dialogHandler = handler
        this.page.removeAllListeners('dialog')
        this.page.on('dialog', async (dialog) => {
            if (this.dialogHandler) {
                const { accept, promptText } = await this.dialogHandler({ type: dialog.type(), message: dialog.message() })
                if (accept) {
                    await dialog.accept(promptText)
                } else {
                    await dialog.dismiss()
                }
            } else {
                await dialog.accept()
            }
        })
    }

    getLastGraph(): Graph | null {
        return this.lastGraph
    }

    getPreviousGraph(): Graph | null {
        return this.previousGraph
    }

    /**
     * Returns the active Playwright Page, or null if session is closed.
     * Used by tracing and other introspection features.
     */
    getPage(): Page | null {
        return this.page
    }

    /**
     * Enables per-action profiling. Each subsequent action will record
     * its duration into `getTimings()`.
     */
    enableProfiling(): void {
        this.profiling = true
    }

    /**
     * Disables per-action profiling. Already-collected timings are retained
     * until `clearTimings()` is called.
     */
    disableProfiling(): void {
        this.profiling = false
    }

    isProfilingEnabled(): boolean {
        return this.profiling
    }

    /**
     * Returns a copy of the collected timings array.
     */
    getTimings(): ActionTiming[] {
        return [...this.timings]
    }

    /**
     * Clears the collected timings. Returns the count that was cleared.
     */
    clearTimings(): number {
        const count = this.timings.length
        this.timings = []
        return count
    }

    /**
     * Computes aggregate statistics over the collected timings.
     */
    getTimingsReport(): ActionReport {
        if (this.timings.length === 0) {
            return {
                count: 0,
                totalMs: 0,
                avgMs: 0,
                p50Ms: 0,
                p95Ms: 0,
                p99Ms: 0,
                byAction: {}
            }
        }

        const durations = this.timings.map((t) => t.durationMs).sort((a, b) => a - b)
        const totalMs = durations.reduce((sum, d) => sum + d, 0)

        const byAction: Record<string, { count: number, totalMs: number, avgMs: number }> = {}
        for (const t of this.timings) {
            const existing = byAction[t.action] ?? { count: 0, totalMs: 0, avgMs: 0 }
            existing.count++
            existing.totalMs += t.durationMs
            byAction[t.action] = existing
        }
        for (const key of Object.keys(byAction)) {
            const entry = byAction[key]!
            entry.avgMs = entry.count > 0 ? entry.totalMs / entry.count : 0
        }

        return {
            count: durations.length,
            totalMs,
            avgMs: totalMs / durations.length,
            p50Ms: percentile(durations, 0.5),
            p95Ms: percentile(durations, 0.95),
            p99Ms: percentile(durations, 0.99),
            byAction
        }
    }

    private scheduleStatePersistence(): void {
        if (this.statePersistTimer !== null || this.closing) {
            return
        }
        this.statePersistTimer = setTimeout(() => {
            this.statePersistTimer = null
            void this.persistState(true).catch((error: unknown) => {
                console.error('Background state persistence error:', error)
            })
        }, STATE_PERSIST_DEBOUNCE_MS)
        this.statePersistTimer.unref()
    }

    private async persistState(force: boolean = false): Promise<void> {
        if (!force) {
            this.markStateDirty()
            return
        }
        if (!this.context || !this.page) {
            return
        }
        const context = this.context
        const activePage = this.page
        if (this.statePersistInFlight) {
            await this.statePersistInFlight
            if (this.stateDirty) {
                return this.persistState(true)
            }
            return
        }

        const version = this.stateVersion
        const operation = (async () => {
            this.state.cookies = (await context.cookies()) as SessionState['cookies']
            const pages = context.pages()
            const previousUrls = new Map(this.state.tabs.map((tab) => [tab.id, tab.url]))
            const tabs: SessionState['tabs'] = []

            for (const page of pages) {
                let tabId = this.pageTabIds.get(page)
                if (!tabId) {
                    tabId = this.createTabId()
                    this.pageTabIds.set(page, tabId)
                }
                const tabUrl = page.url() === 'about:blank'
                    ? previousUrls.get(tabId) ?? 'about:blank'
                    : page.url()
                tabs.push({ id: tabId, url: tabUrl })

                try {
                    const storage = await page.evaluate(() => {
                        const origin = window.location.origin
                        if (origin === 'null') {
                            return null
                        }
                        const read = (source: Storage): Record<string, string> => {
                            const values: Record<string, string> = {}
                            for (let index = 0; index < source.length; index++) {
                                const key = source.key(index)
                                if (key !== null) {
                                    const value = source.getItem(key)
                                    if (value !== null) {
                                        values[key] = value
                                    }
                                }
                            }
                            return values
                        }
                        return {
                            origin,
                            localStorage: read(window.localStorage),
                            sessionStorage: read(window.sessionStorage)
                        }
                    })
                    if (storage) {
                        this.state.localStorage[storage.origin] = storage.localStorage
                        const perTab = this.state.sessionStorage[tabId] ?? {}
                        perTab[storage.origin] = storage.sessionStorage
                        this.state.sessionStorage[tabId] = perTab
                    }
                } catch {
                    // Opaque and sandboxed documents do not expose web storage.
                }
            }

            this.state.tabs = tabs
            const activeTabId = this.pageTabIds.get(activePage)
            this.state.activeTabId = activeTabId
            const activeTab = tabs.find((tab) => tab.id === activeTabId)
            if (activeTab) {
                this.state.url = activeTab.url === 'about:blank' ? undefined : activeTab.url
            }
            const activeTabs = new Set(tabs.map((tab) => tab.id))
            for (const tabId of Object.keys(this.state.sessionStorage)) {
                if (!activeTabs.has(tabId)) {
                    delete this.state.sessionStorage[tabId]
                }
            }
            saveSession(this.state)
        })()

        this.statePersistInFlight = operation
        let succeeded = false
        try {
            await operation
            succeeded = true
        } finally {
            this.statePersistInFlight = null
            if (succeeded && version === this.stateVersion) {
                this.stateDirty = false
            } else if (this.stateDirty || version !== this.stateVersion) {
                this.stateDirty = true
                this.scheduleStatePersistence()
            }
        }
    }
}

function normalizeElementRef(elementId: string): string {
    return elementId.startsWith('@') ? elementId.slice(1) : elementId
}

async function readWindowStorage(page: Page, name: 'localStorage' | 'sessionStorage'): Promise<Record<string, string>> {
    return page.evaluate((storageName) => {
        const storage = storageName === 'localStorage' ? window.localStorage : window.sessionStorage
        const result: Record<string, string> = {}
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index)
            if (key !== null) {
                const value = storage.getItem(key)
                if (value !== null) {
                    result[key] = value
                }
            }
        }
        return result
    }, name)
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
        name,
        NETWORK_SENSITIVE_HEADER.test(name) ? '[REDACTED]' : value
    ]))
}

function buildSnapshotTree(
    children: import('./types.js').CaptureNode[]
): SnapshotNode[] {
    const result: SnapshotNode[] = []

    for (const child of children) {
        const expandedChildren = child.children.length > 0
            ? buildSnapshotTree(child.children)
            : []
        const hasMeaningfulContent = child.role || child.name || child.text

        if (hasMeaningfulContent) {
            result.push({
                ref: child.id,
                tag: child.tag,
                role: child.role,
                name: child.name,
                text: child.text,
                id: child.attributes.id,
                className: child.attributes.class,
                boundingBox: child.boundingBox,
                childrenCount: child.childrenCount,
                children: expandedChildren
            })
        } else if (expandedChildren.length > 0) {
            // Lift empty container: promote grandchildren up
            result.push(...expandedChildren)
        } else {
            // Collapsed empty container: keep as a stub with childrenCount
            result.push({
                ref: child.id,
                tag: child.tag,
                id: child.attributes.id,
                className: child.attributes.class,
                boundingBox: child.boundingBox,
                childrenCount: child.childrenCount,
                children: []
            })
        }
    }

    return result
}

/**
 * Extracts --user-data-dir argument value from chromium spawn args.
 * Returns null if not found.
 */
function extractUserDataDir(spawnArgs: string[] | undefined): string | null {
    if (!spawnArgs) {
        return null
    }
    for (let i = 0; i < spawnArgs.length; i++) {
        if (spawnArgs[i] === '--user-data-dir' && i + 1 < spawnArgs.length) {
            return spawnArgs[i + 1]
        }
        if (spawnArgs[i].startsWith('--user-data-dir=')) {
            return spawnArgs[i].slice('--user-data-dir='.length)
        }
    }
    return null
}

export async function createBrowserSession(name: string, options: BrowserSessionOptions = {}): Promise<BrowserSession> {
    const session = new BrowserSession(name, options)
    await session.start()
    return session
}

/**
 * Computes the p-th percentile (0..1) of a sorted ascending array.
 * Returns 0 for empty input.
 */
function percentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return 0
    if (p <= 0) return sortedAsc[0]!
    if (p >= 1) return sortedAsc[sortedAsc.length - 1]!
    const idx = (sortedAsc.length - 1) * p
    const lower = Math.floor(idx)
    const upper = Math.ceil(idx)
    if (lower === upper) return sortedAsc[lower]!
    return sortedAsc[lower]! + (sortedAsc[upper]! - sortedAsc[lower]!) * (idx - lower)
}
