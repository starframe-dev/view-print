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

interface TraceEvent {
    name?: string
    cat?: string
    dur?: number
    ts?: number
    ph?: string
    [key: string]: unknown
}

type DataCollectedHandler = (data: { value: TraceEvent[] }) => void
type TracingCompleteHandler = () => void

interface CDPSessionLike {
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
    on: (event: string, handler: (...args: unknown[]) => void) => void
    off: (event: string, handler: (...args: unknown[]) => void) => void
}

/**
 * Manages Chrome DevTools Protocol Tracing for a single BrowserSession.
 * State machine: idle → recording → idle. Only one trace at a time.
 */
export class TracingSession {
    private active = false
    private categories: string[] = []
    private startTime = 0
    private events: TraceEvent[] = []
    private cdpSession: CDPSession | null = null

    isActive(): boolean {
        return this.active
    }

    getCategories(): string[] {
        return [...this.categories]
    }

    getEventCount(): number {
        return this.events.length
    }

    /**
     * Starts CDP tracing. Must be called before any page actions to be captured.
     */
    async start(page: Page, options: { categories?: string[] } = {}): Promise<void> {
        if (this.active) {
            throw new Error('Tracing already active. Call stop() first.')
        }

        this.categories = options.categories ?? DEFAULT_CATEGORIES
        this.events = []
        this.startTime = Date.now()

        const context = page.context()
        const session = await context.newCDPSession(page)
        this.cdpSession = session

        const handler: DataCollectedHandler = (data) => {
            if (Array.isArray(data.value)) {
                this.events.push(...data.value)
            }
        }
        ;(session as unknown as CDPSessionLike).on('Tracing.dataCollected', handler as (...args: unknown[]) => void)

        await session.send('Tracing.start', {
            categories: this.categories.join(','),
            options: 'sampling-frequency=10000'
        })

        this.active = true
    }

    /**
     * Stops CDP tracing and writes events to JSON file.
     * Returns the report with statistics.
     */
    async stop(page: Page, outputPath?: string): Promise<TraceReport> {
        if (!this.active || !this.cdpSession) {
            throw new Error('Tracing not active. Call start() first.')
        }

        const startMs = this.startTime
        const stopTime = Date.now()
        const session = this.cdpSession as unknown as CDPSessionLike
        const events = this.events

        const report = await new Promise<TraceReport>((resolve, reject) => {
            let completed = false
            const finalize = (): void => {
                if (completed) return
                completed = true
                this.writeReport(events, startMs, stopTime, outputPath).then(resolve).catch(reject)
            }
            const completeHandler: TracingCompleteHandler = () => finalize()
            ;(session as unknown as CDPSessionLike).on('Tracing.tracingComplete', completeHandler as (...args: unknown[]) => void)
            session.send('Tracing.end').catch(() => finalize())
            // Timeout fallback in case tracingComplete never fires
            setTimeout(() => finalize(), 5000)
        })

        // Suppress unused parameter warning; page is kept for API symmetry
        void page
        return report
    }

    /**
     * Generates a summary report from collected events without writing.
     * Useful for live inspection.
     */
    report(): TraceReport {
        return {
            path: '',
            durationMs: this.active ? Date.now() - this.startTime : 0,
            eventCount: this.events.length,
            sizeBytes: 0,
            ...this.computeAggregates(this.events)
        }
    }

    private async writeReport(events: TraceEvent[], startMs: number, stopTime: number, outputPath?: string): Promise<TraceReport> {
        const targetPath = outputPath ?? this.defaultPath()
        await fs.mkdir(path.dirname(targetPath), { recursive: true })

        const traceFile = { traceEvents: events }
        const json = JSON.stringify(traceFile)
        await fs.writeFile(targetPath, json, 'utf-8')

        this.active = false

        return {
            path: targetPath,
            durationMs: stopTime - startMs,
            eventCount: events.length,
            sizeBytes: Buffer.byteLength(json, 'utf-8'),
            ...this.computeAggregates(events)
        }
    }

    private defaultPath(): string {
        const dir = path.join(os.homedir(), '.viewprint', 'traces')
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        return path.join(dir, `trace-${stamp}.json`)
    }

    private computeAggregates(events: TraceEvent[]): Pick<TraceReport, 'categoryCounts' | 'topEvents'> {
        const categoryCounts: Record<string, number> = {}
        const topEvents: Array<{ name: string, dur: number, ts: number }> = []

        for (const ev of events) {
            if (ev.cat) {
                for (const cat of ev.cat.split(',')) {
                    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1
                }
            }
            if (typeof ev.dur === 'number' && ev.dur > 0 && typeof ev.name === 'string') {
                topEvents.push({ name: ev.name, dur: ev.dur, ts: ev.ts ?? 0 })
            }
        }

        topEvents.sort((a, b) => b.dur - a.dur)
        return { categoryCounts, topEvents: topEvents.slice(0, 10) }
    }
}

/**
 * Convenience helper: start tracing, run callback, stop tracing.
 * Returns the report.
 */
export async function capturePerformanceTrace<T>(
    page: Page,
    options: { categories?: string[], outputPath?: string },
    fn: () => Promise<T>
): Promise<{ result: T, report: TraceReport }> {
    const tracing = new TracingSession()
    await tracing.start(page, options)
    let result: T
    try {
        result = await fn()
    } catch (err) {
        // Still stop tracing so we don't leak the active flag
        try { await tracing.stop(page, options.outputPath) } catch { /* ignore */ }
        throw err
    }
    const report = await tracing.stop(page, options.outputPath)
    return { result, report }
}

export function getDefaultCategories(): string[] {
    return [...DEFAULT_CATEGORIES]
}
