import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { CDPSession, Page } from 'playwright'
import type { TraceReport } from './types.js'

const DEFAULT_CATEGORIES: string[] = [
    '-*',
    'devtools.timeline',
    'v8.execute',
    'blink.console',
    'blink.user_timing',
    'loading',
    'latencyInfo',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack'
]
const MAX_TRACE_EVENTS = 100_000
const TRACE_COMPLETE_TIMEOUT_MS = 5_000

interface TraceEvent {
    name?: string
    cat?: string
    dur?: number
    ts?: number
    ph?: string
    [key: string]: unknown
}

interface CDPSessionLike {
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
    on: (event: string, handler: (payload: unknown) => void) => void
    off: (event: string, handler: (payload: unknown) => void) => void
    detach: () => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEvents(payload: unknown): TraceEvent[] {
    if (!isRecord(payload) || !Array.isArray(payload.value)) {
        return []
    }
    return payload.value.filter(isRecord)
}

/** Manages one bounded Chrome DevTools Protocol trace. */
export class TracingSession {
    private active = false
    private categories: string[] = []
    private startTime = 0
    private events: TraceEvent[] = []
    private cdpSession: CDPSession | null = null
    private cdp: CDPSessionLike | null = null
    private dataHandler: ((payload: unknown) => void) | null = null
    private completeHandler: ((payload: unknown) => void) | null = null
    private stopTimer: NodeJS.Timeout | null = null
    private stopPromise: Promise<TraceReport> | null = null

    isActive(): boolean {
        return this.active
    }

    getCategories(): string[] {
        return [...this.categories]
    }

    getEventCount(): number {
        return this.events.length
    }

    async start(page: Page, options: { categories?: string[] } = {}): Promise<void> {
        if (this.active || this.cdpSession) {
            throw new Error('Tracing already active. Call stop() first.')
        }

        const categories = options.categories ?? DEFAULT_CATEGORIES
        if (categories.length === 0 || !categories.every((category) => typeof category === 'string' && category.length > 0)) {
            throw new Error('Trace categories must be a non-empty array of strings.')
        }

        this.categories = [...categories]
        this.events = []
        this.startTime = Date.now()

        const cdpSession = await page.context().newCDPSession(page)
        const cdp = cdpSession as unknown as CDPSessionLike
        const dataHandler = (payload: unknown): void => {
            const available = MAX_TRACE_EVENTS - this.events.length
            if (available > 0) {
                this.events.push(...parseEvents(payload).slice(0, available))
            }
        }
        this.cdpSession = cdpSession
        this.cdp = cdp
        this.dataHandler = dataHandler
        cdp.on('Tracing.dataCollected', dataHandler)

        try {
            await cdp.send('Tracing.start', {
                categories: this.categories.join(','),
                options: 'sampling-frequency=10000',
                transferMode: 'ReportEvents'
            })
            this.active = true
        } catch (error) {
            await this.cleanup(cdp)
            throw error
        }
    }

    async stop(page: Page, outputPath?: string): Promise<TraceReport> {
        if (this.stopPromise) {
            return this.stopPromise
        }
        const promise = this.stopInternal(page, outputPath)
        this.stopPromise = promise
        try {
            return await promise
        } finally {
            this.stopPromise = null
        }
    }

    private async stopInternal(page: Page, outputPath?: string): Promise<TraceReport> {
        const cdp = this.cdp
        if (!this.active || !cdp) {
            throw new Error('Tracing not active. Call start() first.')
        }

        const startedAt = this.startTime
        const stoppedAt = Date.now()
        const completion = new Promise<void>((resolve) => {
            let completed = false
            const finish = (): void => {
                if (completed) return
                completed = true
                resolve()
            }
            this.completeHandler = finish
            cdp.on('Tracing.tracingComplete', finish)
            this.stopTimer = setTimeout(finish, TRACE_COMPLETE_TIMEOUT_MS)
            void cdp.send('Tracing.end').catch(finish)
        })

        try {
            await completion
            void page
            return await this.writeReport(this.events, startedAt, stoppedAt, outputPath)
        } finally {
            await this.cleanup(cdp)
        }
    }

    async close(): Promise<void> {
        if (this.stopPromise) {
            await this.stopPromise.catch(() => undefined)
        }
        const cdp = this.cdp
        if (!cdp) {
            this.active = false
            return
        }
        try {
            if (this.active) {
                await cdp.send('Tracing.end').catch(() => undefined)
            }
        } finally {
            await this.cleanup(cdp)
        }
    }

    report(): TraceReport {
        return {
            path: '',
            durationMs: this.active ? Date.now() - this.startTime : 0,
            eventCount: this.events.length,
            sizeBytes: 0,
            ...this.computeAggregates(this.events)
        }
    }

    private async cleanup(cdp: CDPSessionLike): Promise<void> {
        if (this.stopTimer) {
            clearTimeout(this.stopTimer)
            this.stopTimer = null
        }
        if (this.dataHandler) {
            cdp.off('Tracing.dataCollected', this.dataHandler)
            this.dataHandler = null
        }
        if (this.completeHandler) {
            cdp.off('Tracing.tracingComplete', this.completeHandler)
            this.completeHandler = null
        }
        this.active = false
        this.cdp = null
        this.cdpSession = null
        try {
            await cdp.detach()
        } catch {
            // CDP sessions may already be detached by page teardown.
        }
    }

    private async writeReport(
        events: TraceEvent[],
        startedAt: number,
        stoppedAt: number,
        outputPath?: string
    ): Promise<TraceReport> {
        const targetPath = outputPath ?? this.defaultPath()
        const parentDirectory = path.dirname(targetPath)
        const isDefaultPath = outputPath === undefined
        await fs.mkdir(parentDirectory, { recursive: true, mode: isDefaultPath ? 0o700 : 0o755 })
        if (isDefaultPath) {
            await fs.chmod(parentDirectory, 0o700)
        }

        const json = JSON.stringify({ traceEvents: events })
        const temporaryPath = `${targetPath}.${randomUUID()}.tmp`
        try {
            await fs.writeFile(temporaryPath, json, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
            await fs.rename(temporaryPath, targetPath)
        } finally {
            await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
        }

        return {
            path: targetPath,
            durationMs: stoppedAt - startedAt,
            eventCount: events.length,
            sizeBytes: Buffer.byteLength(json, 'utf8'),
            ...this.computeAggregates(events)
        }
    }

    private defaultPath(): string {
        const directory = path.join(os.homedir(), '.viewprint', 'traces')
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        return path.join(directory, `trace-${stamp}.json`)
    }

    private computeAggregates(events: TraceEvent[]): Pick<TraceReport, 'categoryCounts' | 'topEvents'> {
        const categoryCounts: Record<string, number> = Object.create(null) as Record<string, number>
        const topEvents: Array<{ name: string; dur: number; ts: number }> = []

        for (const event of events) {
            if (event.cat) {
                for (const category of event.cat.split(',')) {
                    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1
                }
            }
            if (typeof event.dur === 'number' && event.dur > 0 && typeof event.name === 'string') {
                topEvents.push({ name: event.name, dur: event.dur, ts: event.ts ?? 0 })
            }
        }

        topEvents.sort((left, right) => right.dur - left.dur)
        return { categoryCounts, topEvents: topEvents.slice(0, 10) }
    }
}

export async function capturePerformanceTrace<T>(
    page: Page,
    options: { categories?: string[]; outputPath?: string },
    fn: () => Promise<T>
): Promise<{ result: T; report: TraceReport }> {
    const tracing = new TracingSession()
    await tracing.start(page, options)
    try {
        const result = await fn()
        const report = await tracing.stop(page, options.outputPath)
        return { result, report }
    } catch (error) {
        await tracing.close()
        throw error
    }
}

export function getDefaultCategories(): string[] {
    return [...DEFAULT_CATEGORIES]
}
