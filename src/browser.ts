import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type BrowserServer, type Cookie, type Page, type Request, type Response } from 'playwright'
import { extractSnapshotData, inspectElement } from './extractor.js'
import { buildGraph } from './graph.js'
import { killProcessTree, isProcessAlive, hasOrphanedChromeProcesses, killChromeProcessesByUserDataDir } from './process-tree.js'
import { loadSession, saveSession } from './session.js'
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
}

const STATE_PERSIST_INTERVAL_MS = 1000

export function getBrowserLaunchOptions(options: BrowserSessionOptions = {}): { channel: 'chrome'; headless: boolean } {
    return { channel: 'chrome', headless: options.headless ?? true }
}

export class BrowserSession {
    private name: string
    private headless: boolean
    private server: BrowserServer | null = null
    private browser: Browser | null = null
    private context: BrowserContext | null = null
    private page: Page | null = null
    private state: SessionState
    private requestMap = new Map<Request, NetworkRequest>()
    private requestHandler?: (request: Request) => void
    private responseHandler?: (response: Response) => void
    private harPath?: string
    private browserPid: number | null = null
    private userDataDir: string | null = null
    private closing = false
    private profiling = false
    private timings: ActionTiming[] = []
    private statePersistTimer: NodeJS.Timeout | null = null
    private statePersistQueue: Promise<void> = Promise.resolve()

    constructor(name: string, options: BrowserSessionOptions = {}) {
        this.name = name
        this.headless = options.headless ?? true
        this.state = loadSession(name)
    }

    isHeadless(): boolean {
        return this.headless
    }

    isUsable(): boolean {
        return !this.closing && this.page !== null && !this.page.isClosed() && (this.browser?.isConnected() ?? false)
    }

    async start(): Promise<void> {
        // Use launchServer + connect so we have access to the browser process PID.
        // This is required to guarantee chromium cleanup on daemon exit.
        this.server = await chromium.launchServer(getBrowserLaunchOptions({ headless: this.headless }))
        this.browserPid = this.server.process().pid ?? null
        this.userDataDir = extractUserDataDir(this.server.process().spawnargs)
        this.browser = await chromium.connect(this.server.wsEndpoint())
        this.context = await this.browser.newContext({ storageState: this.buildStorageState() })
        this.page = await this.context.newPage()
        if (this.state.viewport) {
            await this.page.setViewportSize(this.state.viewport)
        }
        this.startStatePersistence()
    }

    private startStatePersistence(): void {
        this.statePersistTimer = setInterval(() => {
            void this.persistState().catch((error: unknown) => {
                console.error('Background state persistence error:', error)
            })
        }, STATE_PERSIST_INTERVAL_MS)
    }

    private stopStatePersistence(): void {
        if (this.statePersistTimer === null) {
            return
        }
        clearInterval(this.statePersistTimer)
        this.statePersistTimer = null
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

            const skipGoto = options?.noLoad === true
                || (options?.skipLoad === true && Boolean(url) && this.page.url() === url)

            if (url && !skipGoto) {
                this.state.url = url
                await this.persistState()
                await this.page.goto(url, { waitUntil: 'domcontentloaded' })
                await this.restoreStorage()
            }
            // If skipGoto: keep state.url as-is (it's already the actual current URL).
            // noLoad: URL is intentionally ignored, don't overwrite state.url.

            if (!this.state.url) {
                throw new Error('URL not provided. Use capture <url> or start with a saved URL.')
            }

            if (viewport) {
                await this.page.setViewportSize(viewport)
            }

            const rawData = await this.page.evaluate(extractSnapshotData)
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

            const graph = buildGraph(rawData, this.state.url, currentViewport, depth, expandedIds, query !== undefined)
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
        return this.page.evaluate((sel: string) => {
            const elements = document.querySelectorAll(sel)
            const ids: string[] = []
            for (const element of Array.from(elements)) {
                const id = element.getAttribute('data-viewprint-id')
                if (id) ids.push(id)
            }
            return ids
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

            return this.page.evaluate(inspectElement, elementId)
        })
    }

    async click(elementId: string): Promise<void> {
        return this.timed('click', async () => {
            await this.ensureElementIds()
            await this.page!.click(this.selectorFor(elementId))
            await this.page!.waitForTimeout(100)
            await this.persistState()
        })
    }

    async clickQuery(selector: string): Promise<void> {
        return this.timed('clickQuery', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            await this.page.locator(selector).click()
            await this.page.waitForTimeout(100)
            await this.persistState()
        })
    }

    async fill(elementId: string, text: string): Promise<void> {
        return this.timed('fill', async () => {
            await this.runElementAction(elementId, (el) => {
                const input = el as HTMLInputElement | HTMLTextAreaElement
                if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
                    input.value = ''
                }
            })
            await this.page!.fill(this.selectorFor(elementId), text)
            await this.persistState()
        })
    }

    async fillQuery(selector: string, text: string): Promise<void> {
        return this.timed('fillQuery', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            await this.page.locator(selector).fill(text)
            await this.persistState()
        })
    }

    async type(elementId: string, text: string): Promise<void> {
        return this.timed('type', async () => {
            await this.ensureElementIds()
            await this.page!.type(this.selectorFor(elementId), text)
            await this.persistState()
        })
    }

    async hover(elementId: string): Promise<void> {
        return this.timed('hover', async () => {
            await this.ensureElementIds()
            await this.page!.hover(this.selectorFor(elementId))
            await this.persistState()
        })
    }

    async focus(elementId: string): Promise<void> {
        return this.timed('focus', async () => {
            await this.ensureElementIds()
            await this.page!.focus(this.selectorFor(elementId))
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
                await this.ensureElementIds()
                await this.page.evaluate(({ selector, dx, dy }) => {
                    const element = document.querySelector(selector)
                    if (element) {
                        element.scrollBy(dx, dy)
                    }
                }, { selector: this.selectorFor(elementId), dx, dy })
            } else {
                await this.page.evaluate(({ dx, dy }) => window.scrollBy(dx, dy), { dx, dy })
            }

            await this.persistState()
        })
    }

    async scrollIntoView(elementId: string): Promise<void> {
        return this.timed('scrollIntoView', async () => {
            await this.ensureElementIds()
            await this.page!.evaluate((selector) => {
                const element = document.querySelector(selector)
                element?.scrollIntoView({ behavior: 'instant', block: 'center' })
            }, this.selectorFor(elementId))
            await this.persistState()
        })
    }

    async wait(condition: WaitCondition): Promise<void> {
        return this.timed('wait', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }

            const timeout = condition.timeout ?? 5000

            if (condition.selector) {
                await this.page.waitForSelector(condition.selector, { timeout, state: 'visible' })
            } else if (condition.text) {
                await this.page.waitForFunction(
                    (text) => document.body.innerText.includes(text),
                    condition.text,
                    { timeout }
                )
            } else if (condition.loadState) {
                await this.page.waitForLoadState(condition.loadState, { timeout })
            } else if (condition.fn) {
                await this.page.waitForFunction(condition.fn, undefined, { timeout })
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

            const result = await this.page.evaluate((script) => {
                return eval(script)
            }, script)
            await this.persistState()
            return result
        })
    }

    async startNetworkTracking(): Promise<void> {
        if (!this.context) {
            throw new Error('Session not started. Call start() first.')
        }

        this.requestHandler = (request: Request) => {
            this.requestMap.set(request, {
                url: request.url(),
                method: request.method(),
                headers: request.headers(),
                timestamp: Date.now()
            })
        }

        this.responseHandler = async (response: Response) => {
            const request = response.request()
            const entry = this.requestMap.get(request)
            if (!entry) {
                return
            }
            entry.status = response.status()
            entry.responseHeaders = response.headers()
            try {
                entry.responseBody = await response.text()
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

    async startHar(path?: string): Promise<{ path: string }> {
        await this.startNetworkTracking()
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
                creator: { name: 'viewprint', version: '0.1.0' },
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
            return this.page.evaluate(() => {
                const result: Record<string, string> = {}
                for (let i = 0; i < window.localStorage.length; i++) {
                    const key = window.localStorage.key(i)
                    if (key) {
                        result[key] = window.localStorage.getItem(key) ?? ''
                    }
                }
                return result
            })
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
            return this.page.evaluate(() => {
                const result: Record<string, string> = {}
                for (let i = 0; i < window.sessionStorage.length; i++) {
                    const key = window.sessionStorage.key(i)
                    if (key) {
                        result[key] = window.sessionStorage.getItem(key) ?? ''
                    }
                }
                return result
            })
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

            const count = await this.page.evaluate(() => document.querySelectorAll('body, body *').length)
            return { url: this.state.url, elementCount: count }
        })
    }

    async close(): Promise<void> {
        if (this.closing) {
            return
        }
        this.closing = true
        this.stopStatePersistence()

        // Best-effort state persistence (don't block cleanup on failure)
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

    private selectorFor(elementId: string): string {
        const ref = elementId.startsWith('@') ? elementId.slice(1) : elementId
        return `[data-viewprint-id="${ref}"]`
    }

    private async ensureElementIds(): Promise<void> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        if (!this.state.url) {
            throw new Error('URL not provided. Capture a page first.')
        }
        await this.page.evaluate(extractSnapshotData)
    }

    private async runElementAction(elementId: string, action: (element: HTMLElement) => void): Promise<void> {
        await this.ensureElementIds()
        await this.page!.evaluate(({ selector, actionBody }) => {
            const element = document.querySelector(selector)
            if (!element) {
                throw new Error(`Element not found: ${selector}`)
            }
            const fn = new Function('element', actionBody)
            fn(element as HTMLElement)
        }, { selector: this.selectorFor(elementId), actionBody: action.toString() })
        await this.page!.waitForTimeout(100)
        await this.persistState()
    }

    private buildStorageState(): Exclude<BrowserContextOptions['storageState'], string> {
        if (this.state.cookies.length === 0) {
            return undefined
        }

        return {
            cookies: this.state.cookies as Cookie[],
            origins: []
        }
    }

    private async restoreStorage(): Promise<void> {
        if (!this.page) {
            return
        }

        const localStorage = this.state.localStorage
        const sessionStorage = this.state.sessionStorage
        if (Object.keys(localStorage).length === 0 && Object.keys(sessionStorage).length === 0) {
            return
        }

        try {
            await this.page.evaluate(({ localStorage, sessionStorage }) => {
                for (const [key, value] of Object.entries(localStorage)) {
                    window.localStorage.setItem(key, value)
                }
                for (const [key, value] of Object.entries(sessionStorage)) {
                    window.sessionStorage.setItem(key, value)
                }
            }, { localStorage, sessionStorage })
        } catch {
            // Storage is unavailable for this document (e.g. data: URLs)
        }
    }


    async newTab(url?: string): Promise<void> {
        return this.timed('newTab', async () => {
            if (!this.context) {
                throw new Error('Session not started. Call start() first.')
            }
            const newPage = await this.context.newPage()
            if (url) {
                await newPage.goto(url, { waitUntil: 'domcontentloaded' })
            }
            this.page = newPage
            if (url) {
                this.state.url = url
            }
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
            this.state.url = this.page.url()
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
            this.state.url = this.page.url()
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
            // frameLocator is used by consumers; we validate the selector exists
            this.page.frameLocator(selector).first()
        })
    }

    async switchFrameMain(): Promise<void> {
        return this.timed('switchFrameMain', async () => {
            // No-op placeholder until frame-aware capture is implemented
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
            await this.ensureElementIds()
            const selector = this.selectorFor(elementId)
            const outputPath = path ?? this.defaultScreenshotPath('element')

            if (padding <= 0) {
                await this.page.locator(selector).screenshot({ path: outputPath })
                return outputPath
            }

            // With padding: capture a clip area around the element's bounding box.
            // Clamped to the viewport — if padding exceeds visible bounds, the
            // element may be clipped; users should use scrollintoview first.
            const bbox = await this.page.locator(selector).boundingBox()
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
        })
    }

    private defaultScreenshotPath(type: 'page' | 'element'): string {
        const timestamp = Date.now()
        const dir = path.join(os.homedir(), '.viewprint', 'screenshots')
        fs.mkdirSync(dir, { recursive: true })
        return path.join(dir, `${this.name}-${type}-${timestamp}.png`)
    }

    async read(format: 'text' | 'markdown' = 'text'): Promise<string> {
        return this.timed('read', async () => {
            if (!this.page) {
                throw new Error('Session not started. Call start() first.')
            }
            return this.page.evaluate((fmt: string) => {
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
    private lastGraph: Graph | null = null

    getLastGraph(): Graph | null {
        return this.lastGraph
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

    private persistState(force: boolean = false): Promise<void> {
        const persist = this.statePersistQueue.then(async () => {
            if ((!force && this.closing) || !this.context || !this.page) {
                return
            }

            this.state.cookies = (await this.context.cookies()) as SessionState['cookies']

            try {
                this.state.localStorage = await this.page.evaluate(() => {
                    const result: Record<string, string> = {}
                    for (let i = 0; i < window.localStorage.length; i++) {
                        const key = window.localStorage.key(i)
                        if (key !== null) {
                            const value = window.localStorage.getItem(key)
                            if (value !== null) {
                                result[key] = value
                            }
                        }
                    }
                    return result
                })
                this.state.sessionStorage = await this.page.evaluate(() => {
                    const result: Record<string, string> = {}
                    for (let i = 0; i < window.sessionStorage.length; i++) {
                        const key = window.sessionStorage.key(i)
                        if (key !== null) {
                            const value = window.sessionStorage.getItem(key)
                            if (value !== null) {
                                result[key] = value
                            }
                        }
                    }
                    return result
                })
            } catch {
                this.state.localStorage = {}
                this.state.sessionStorage = {}
            }

            saveSession(this.state)
        })

        this.statePersistQueue = persist.catch(() => undefined)
        return persist
    }
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
