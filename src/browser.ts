import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright'
import { extractSnapshotData, inspectElement } from './extractor.js'
import { buildGraph } from './graph.js'
import { loadSession, saveSession } from './session.js'
import type { ElementNode, Graph, SessionState } from './types.js'

interface StorageState {
    cookies: unknown[]
    origins: Array<{
        origin: string
        localStorage: Array<{ name: string; value: string }>
    }>
}

export class BrowserSession {
    private name: string
    private browser: Browser | null = null
    private context: BrowserContext | null = null
    private page: Page | null = null
    private state: SessionState

    constructor(name: string) {
        this.name = name
        this.state = loadSession(name)
    }

    async start(): Promise<void> {
        this.browser = await chromium.launch({ headless: true })
        this.context = await this.browser.newContext({ storageState: this.buildStorageState() })
        this.page = await this.context.newPage()

        if (this.state.url) {
            await this.page.goto(this.state.url)
        }
    }

    async capture(url?: string, viewport?: { width: number; height: number }): Promise<Graph> {
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }

        if (url) {
            await this.page.goto(url)
            this.state.url = url
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

        return buildGraph(rawData, this.state.url, currentViewport)
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
        if (!this.page) {
            throw new Error('Session not started. Call start() first.')
        }

        if (!this.state.url) {
            throw new Error('URL not provided. Capture a page first.')
        }

        // Set data-viewprint-id attributes without computing the full graph
        await this.page.evaluate(extractSnapshotData)

        const selector = `[data-viewprint-id="${elementId}"]`
        await this.page.click(selector)
        await this.page.waitForTimeout(100)
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

    private buildStorageState(): Exclude<BrowserContextOptions['storageState'], string> {
        const hasCookies = this.state.cookies.length > 0
        const hasLocalStorage = Object.keys(this.state.localStorage).length > 0

        if (!hasCookies && !hasLocalStorage) {
            return undefined
        }

        const origin = this.state.url || 'http://localhost'
        const localStorage = Object.entries(this.state.localStorage).map(([name, value]) => ({
            name,
            value
        }))

        return {
            cookies: this.state.cookies,
            origins: [{ origin, localStorage }]
        } as Exclude<BrowserContextOptions['storageState'], string>
    }

    private async persistState(): Promise<void> {
        if (!this.context) {
            return
        }

        const storage = (await this.context.storageState()) as StorageState
        this.state.cookies = Array.isArray(storage.cookies)
            ? (storage.cookies as unknown[])
            : []
        this.state.localStorage = {}

        const origins = Array.isArray(storage.origins) ? storage.origins : []
        for (const origin of origins) {
            const entries = Array.isArray(origin.localStorage) ? origin.localStorage : []
            for (const entry of entries) {
                this.state.localStorage[entry.name] = entry.value
            }
        }

        saveSession(this.state)
    }
}

export async function createBrowserSession(name: string): Promise<BrowserSession> {
    const session = new BrowserSession(name)
    await session.start()
    return session
}
