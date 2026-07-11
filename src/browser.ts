import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Cookie, type Page, type Request, type Response } from 'playwright'
import { extractSnapshotData, inspectElement } from './extractor.js'
import { buildGraph } from './graph.js'
import { loadSession, saveSession } from './session.js'
import type { ElementNode, Graph, NetworkRequest, NetworkRoute, SessionState, Snapshot, SnapshotElementNode, SnapshotNode } from './types.js'

export interface WaitCondition {
    selector?: string
    text?: string
    timeout?: number
    loadState?: 'load' | 'domcontentloaded' | 'networkidle'
    fn?: string
}

export class BrowserSession {
    private name: string
    private browser: Browser | null = null
    private context: BrowserContext | null = null
    private page: Page | null = null
    private state: SessionState
    private requestMap = new Map<Request, NetworkRequest>()
    private requestHandler?: (request: Request) => void
    private responseHandler?: (response: Response) => void
    private harPath?: string

    constructor(name: string) {
        this.name = name
        this.state = loadSession(name)
    }

    async start(): Promise<void> {
        this.browser = await chromium.launch({ headless: true })
        this.context = await this.browser.newContext({ storageState: this.buildStorageState() })
        this.page = await this.context.newPage()
    }

    async capture(url?: string, viewport?: { width: number; height: number }): Promise<Graph> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }

        if (url) {
            await this.page.goto(url)
            this.state.url = url
            await this.restoreStorage()
        }

        if (!this.state.url) {
            throw new Error('URL not provided. Use capture <url> or start with a saved URL.')
        }

        if (viewport) {
            await this.page.setViewportSize(viewport)
        }

        const rawData = await this.page.evaluate(extractSnapshotData)
        const currentViewport = this.page.viewportSize() || { width: 0, height: 0 }
        await this.persistState()

        const graph = buildGraph(rawData, this.state.url, currentViewport)
        this.lastGraph = graph
        return graph
    }

    async snapshot(url?: string, viewport?: { width: number; height: number }): Promise<Snapshot> {
        const graph = await this.capture(url, viewport)
        const root = Object.values(graph.nodes).find((node) => node.parentId === undefined)

        if (!root) {
            return { url: graph.url, viewport: graph.viewport, tree: [] }
        }

        const children = buildSnapshotChildren(graph.nodes, root.id)
        const tree: Snapshot['tree'] = [{
            ref: root.id,
            tag: root.tag,
            role: root.role,
            name: root.name,
            text: root.text,
            boundingBox: root.boundingBox,
            children
        }]

        return { url: graph.url, viewport: graph.viewport, tree }
    }

    async inspect(elementId: string): Promise<ElementNode | null> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }

        if (!this.state.url) {
            throw new Error('URL not provided. Capture a page first.')
        }

        return this.page.evaluate(inspectElement, elementId)
    }

    async click(elementId: string): Promise<void> {
        await this.ensureElementIds()
        await this.page!.click(this.selectorFor(elementId))
        await this.page!.waitForTimeout(100)
        await this.persistState()
    }

    async fill(elementId: string, text: string): Promise<void> {
        await this.runElementAction(elementId, (el) => {
            const input = el as HTMLInputElement | HTMLTextAreaElement
            if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
                input.value = ''
            }
        })
        await this.page!.fill(this.selectorFor(elementId), text)
        await this.persistState()
    }

    async type(elementId: string, text: string): Promise<void> {
        await this.ensureElementIds()
        await this.page!.type(this.selectorFor(elementId), text)
        await this.persistState()
    }

    async hover(elementId: string): Promise<void> {
        await this.ensureElementIds()
        await this.page!.hover(this.selectorFor(elementId))
        await this.persistState()
    }

    async focus(elementId: string): Promise<void> {
        await this.ensureElementIds()
        await this.page!.focus(this.selectorFor(elementId))
        await this.persistState()
    }

    async press(key: string): Promise<void> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }

        await this.page.keyboard.press(key)
        await this.persistState()
    }

    async scroll(direction: 'up' | 'down' | 'left' | 'right', px: number, elementId?: string): Promise<void> {
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
    }

    async scrollIntoView(elementId: string): Promise<void> {
        await this.ensureElementIds()
        await this.page!.evaluate((selector) => {
            const element = document.querySelector(selector)
            element?.scrollIntoView({ behavior: 'instant', block: 'center' })
        }, this.selectorFor(elementId))
        await this.persistState()
    }

    async wait(condition: WaitCondition): Promise<void> {
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
    }

    async eval(script: string): Promise<unknown> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }

        const result = await this.page.evaluate((script) => {
            return eval(script)
        }, script)
        await this.persistState()
        return result
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
    }

    async unroute(url?: string): Promise<void> {
        if (!this.context) {
            return
        }
        await this.context.unroute(url ?? '**/*')
    }

    async getCookies(): Promise<Cookie[]> {
        if (!this.context) {
            throw new Error('Session not started. Call start() first.')
        }
        return this.context.cookies()
    }

    async setCookie(name: string, value: string, domain?: string, path?: string): Promise<void> {
        if (!this.context) {
            throw new Error('Session not started. Call start() first.')
        }
        if (!this.state.url) {
            throw new Error('URL not provided. Capture a page first.')
        }

        const cookieDomain = domain ?? new URL(this.state.url).hostname
        await this.context.addCookies([{ name, value, domain: cookieDomain, path: path ?? '/' }])
        await this.persistState()
    }

    async clearCookies(): Promise<void> {
        if (!this.context) {
            throw new Error('Session not started. Call start() first.')
        }
        await this.context.clearCookies()
        await this.persistState()
    }

    async getLocalStorage(): Promise<Record<string, string>> {
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
    }

    async setLocalStorage(key: string, value: string): Promise<void> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        await this.page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key, value })
        await this.persistState()
    }

    async clearLocalStorage(): Promise<void> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        await this.page.evaluate(() => localStorage.clear())
        await this.persistState()
    }

    async getSessionStorage(): Promise<Record<string, string>> {
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
    }

    async setSessionStorage(key: string, value: string): Promise<void> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        await this.page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), { key, value })
        await this.persistState()
    }

    async clearSessionStorage(): Promise<void> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        await this.page.evaluate(() => sessionStorage.clear())
        await this.persistState()
    }

    async status(): Promise<{ url?: string; elementCount: number }> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }

        const count = await this.page.evaluate(() => document.querySelectorAll('body, body *').length)
        return { url: this.state.url, elementCount: count }
    }

    async close(): Promise<void> {
        await this.persistState()
        await this.context?.close()
        await this.browser?.close()
        this.context = null
        this.browser = null
        this.page = null
    }

    getState(): SessionState {
        return this.state
    }

    getName(): string {
        return this.name
    }

    private selectorFor(elementId: string): string {
        return `[data-viewprint-id="${elementId}"]`
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
        if (!this.context) {
            throw new Error('Session not started. Call start() first.')
        }
        const newPage = await this.context.newPage()
        if (url) {
            await newPage.goto(url)
        }
        this.page = newPage
        if (url) {
            this.state.url = url
        }
        await this.persistState()
    }

    async switchTab(index: number): Promise<void> {
        if (!this.context) {
            throw new Error('Session not started. Call start() first.')
        }
        const pages = this.context.pages()
        if (index < 0 || index >= pages.length) {
            throw new Error(`Tab index ${index} out of range`)
        }
        this.page = pages[index]
        this.state.url = this.page.url()
    }

    async closeTab(index?: number): Promise<void> {
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
    }

    async listTabs(): Promise<Array<{ index: number; url: string; title: string }>> {
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
    }

    async switchFrame(selector: string): Promise<void> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        // frameLocator is used by consumers; we validate the selector exists
        this.page.frameLocator(selector).first()
    }

    async switchFrameMain(): Promise<void> {
        // No-op placeholder until frame-aware capture is implemented
    }

    async listFrames(): Promise<Array<{ name: string; url: string }>> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        return this.page.frames().map((frame) => ({
            name: frame.name() || '',
            url: frame.url()
        }))
    }

    async screenshotPage(path?: string): Promise<string> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        const outputPath = path ?? this.defaultScreenshotPath('page')
        await this.page.screenshot({ path: outputPath, fullPage: true })
        return outputPath
    }

    async screenshotElement(elementId: string, path?: string): Promise<string> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }
        await this.ensureElementIds()
        const selector = this.selectorFor(elementId)
        const outputPath = path ?? this.defaultScreenshotPath('element')
        await this.page.locator(selector).screenshot({ path: outputPath })
        return outputPath
    }

    private defaultScreenshotPath(type: 'page' | 'element'): string {
        const timestamp = Date.now()
        const dir = path.join(os.homedir(), '.viewprint', 'screenshots')
        fs.mkdirSync(dir, { recursive: true })
        return path.join(dir, `${this.name}-${type}-${timestamp}.png`)
    }

    async read(format: 'text' | 'markdown' = 'text'): Promise<string> {
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

    private async persistState(): Promise<void> {
        if (!this.context || !this.page) {
            return
        }

        this.state.cookies = (await this.context.cookies()) as SessionState['cookies']

        try {
            this.state.localStorage = await this.page.evaluate(() =>
                Object.fromEntries(Object.entries(window.localStorage))
            )
            this.state.sessionStorage = await this.page.evaluate(() =>
                Object.fromEntries(Object.entries(window.sessionStorage))
            )
        } catch {
            this.state.localStorage = {}
            this.state.sessionStorage = {}
        }

        saveSession(this.state)
    }
}

function buildSnapshotChildren(nodes: Record<string, SnapshotElementNode>, parentId: string): SnapshotNode[] {
    const children: SnapshotNode[] = []

    for (const node of Object.values(nodes)) {
        if (node.parentId !== parentId) {
            continue
        }

        const grandChildren = buildSnapshotChildren(nodes, node.id)
        const hasMeaningfulContent = node.role || node.name || node.text

        if (hasMeaningfulContent) {
            children.push({
                ref: node.id,
                tag: node.tag,
                role: node.role,
                name: node.name,
                text: node.text,
                boundingBox: node.boundingBox,
                children: grandChildren
            })
        } else if (grandChildren.length > 0) {
            children.push(...grandChildren)
        }
    }

    return children
}

export async function createBrowserSession(name: string): Promise<BrowserSession> {
    const session = new BrowserSession(name)
    await session.start()
    return session
}
