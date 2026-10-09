import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'

const fsMocks = vi.hoisted(() => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('node:fs/promises', () => ({ default: fsMocks }))

import { TracingSession, getDefaultCategories } from '../src/tracing.js'

interface FakeCDP {
    handlers: Map<string, Set<(payload: unknown) => void>>
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
    on: (event: string, handler: (payload: unknown) => void) => void
    off: (event: string, handler: (payload: unknown) => void) => void
    detach: ReturnType<typeof vi.fn>
    emit: (event: string, payload: unknown) => void
}

function makeFakePage(
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown> = async () => ({})
): { page: Page; cdp: FakeCDP } {
    const handlers = new Map<string, Set<(payload: unknown) => void>>()
    const cdp: FakeCDP = {
        handlers,
        send,
        on: (event, handler) => {
            const eventHandlers = handlers.get(event) ?? new Set()
            eventHandlers.add(handler)
            handlers.set(event, eventHandlers)
        },
        off: (event, handler) => {
            handlers.get(event)?.delete(handler)
        },
        detach: vi.fn().mockResolvedValue(undefined),
        emit: (event, payload) => {
            for (const handler of handlers.get(event) ?? []) {
                handler(payload)
            }
        }
    }
    const page = {
        context: () => ({ newCDPSession: async () => cdp })
    } as unknown as Page
    return { page, cdp }
}

beforeEach(() => {
    vi.clearAllMocks()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('TracingSession', () => {
    it('starts idle with no events or categories', () => {
        const tracing = new TracingSession()
        expect(tracing.isActive()).toBe(false)
        expect(tracing.getEventCount()).toBe(0)
        expect(tracing.getCategories()).toEqual([])
    })

    it('starts and stores categories, then closes CDP resources', async () => {
        const { page, cdp } = makeFakePage()
        const tracing = new TracingSession()
        await tracing.start(page, { categories: ['devtools.timeline', 'loading'] })

        expect(tracing.isActive()).toBe(true)
        expect(tracing.getCategories()).toEqual(['devtools.timeline', 'loading'])
        expect(cdp.handlers.get('Tracing.dataCollected')?.size).toBe(1)

        await tracing.close()
        expect(tracing.isActive()).toBe(false)
        expect(cdp.handlers.size).toBe(1)
        expect(cdp.handlers.get('Tracing.dataCollected')?.size).toBe(0)
        expect(cdp.detach).toHaveBeenCalledOnce()
    })

    it('rejects duplicate starts and releases the original trace', async () => {
        const { page, cdp } = makeFakePage()
        const tracing = new TracingSession()
        await tracing.start(page)
        await expect(tracing.start(page)).rejects.toThrow('already active')
        await tracing.close()
        expect(cdp.detach).toHaveBeenCalledOnce()
    })

    it('uses default categories when none are provided', async () => {
        const { page } = makeFakePage()
        const tracing = new TracingSession()
        await tracing.start(page)
        expect(tracing.getCategories()).toEqual(getDefaultCategories())
        await tracing.close()
    })

    it('cleans up listeners, timers, and the CDP session after stop', async () => {
        vi.useFakeTimers()
        const { page, cdp } = makeFakePage(async (method) => {
            if (method === 'Tracing.end') {
                cdp.emit('Tracing.dataCollected', {
                    value: [
                        { name: 'layout', cat: 'devtools.timeline', dur: 20, ts: 10 },
                        { name: 'paint', cat: 'devtools.timeline,blink', dur: 5, ts: 30 }
                    ]
                })
                cdp.emit('Tracing.tracingComplete', {})
            }
            return {}
        })
        const tracing = new TracingSession()
        await tracing.start(page, { categories: ['test'] })
        const report = await tracing.stop(page, '/tmp/viewprint-test-trace.json')

        expect(report.eventCount).toBe(2)
        expect(report.categoryCounts).toEqual({ 'devtools.timeline': 2, blink: 1 })
        expect(report.topEvents[0]?.name).toBe('layout')
        expect(report.path).toBe('/tmp/viewprint-test-trace.json')
        expect(tracing.isActive()).toBe(false)
        expect(cdp.handlers.get('Tracing.dataCollected')?.size).toBe(0)
        expect(cdp.handlers.get('Tracing.tracingComplete')?.size).toBe(0)
        expect(cdp.detach).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
        expect(fsMocks.writeFile).toHaveBeenCalledOnce()
        expect(fsMocks.rename).toHaveBeenCalledOnce()
    })

    it('cleans up resources when tracing start or persistence fails', async () => {
        const startFailure = new Error('CDP start failed')
        const startPage = makeFakePage(async (method) => {
            if (method === 'Tracing.start') throw startFailure
            return {}
        })
        const failedStart = new TracingSession()
        await expect(failedStart.start(startPage.page)).rejects.toThrow(startFailure)
        expect(failedStart.isActive()).toBe(false)
        expect(startPage.cdp.handlers.get('Tracing.dataCollected')?.size).toBe(0)
        expect(startPage.cdp.detach).toHaveBeenCalledOnce()

        const persistPage = makeFakePage(async (method) => {
            if (method === 'Tracing.end') persistPage.cdp.emit('Tracing.tracingComplete', {})
            return {}
        })
        const failedWrite = new TracingSession()
        await failedWrite.start(persistPage.page)
        fsMocks.writeFile.mockRejectedValueOnce(new Error('disk full'))
        await expect(failedWrite.stop(persistPage.page, '/tmp/failing-trace.json')).rejects.toThrow('disk full')
        expect(failedWrite.isActive()).toBe(false)
        expect(persistPage.cdp.handlers.get('Tracing.dataCollected')?.size).toBe(0)
        expect(persistPage.cdp.detach).toHaveBeenCalledOnce()
    })

    it('rejects stop when no trace is active', async () => {
        const { page } = makeFakePage()
        await expect(new TracingSession().stop(page)).rejects.toThrow('not active')
    })

    it('rejects invalid or empty categories before opening CDP', async () => {
        const { page } = makeFakePage()
        const tracing = new TracingSession()
        await expect(tracing.start(page, { categories: [] })).rejects.toThrow('non-empty array')
    })

    it('reports event aggregates while recording', async () => {
        const { page, cdp } = makeFakePage()
        const tracing = new TracingSession()
        await tracing.start(page, { categories: ['test'] })
        cdp.emit('Tracing.dataCollected', { value: [
            { name: 'script', cat: 'v8.execute', dur: 8, ts: 4 },
            { name: 'layout', cat: 'devtools.timeline', dur: 3, ts: 12 }
        ] })

        const report = tracing.report()
        expect(report.eventCount).toBe(2)
        expect(report.categoryCounts).toEqual({ 'v8.execute': 1, 'devtools.timeline': 1 })
        expect(report.topEvents.map((event) => event.name)).toEqual(['script', 'layout'])
        await tracing.close()
    })
})
