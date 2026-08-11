import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
import { BrowserSession } from '../src/browser.js'
import { ViewPrintDaemon } from '../src/daemon.js'
import { DaemonClient } from '../src/daemon-client.js'
import type { CaptureNode, ElementNode } from '../src/types.js'

const testPage = `data:text/html,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
  <title>Daemon Test</title>
  <style>#btn { color: green; }</style>
</head>
<body>
  <div id="container">
    <button id="btn" onclick="
      const d = document.createElement('div');
      d.id = 'added';
      d.textContent = 'added';
      document.body.appendChild(d);
    ">Add</button>
  </div>
</body>
</html>
`)}`

function flattenTree(tree: CaptureNode[]): Record<string, CaptureNode> {
    const result: Record<string, CaptureNode> = {}

    function walk(node: CaptureNode): void {
        result[node.id] = node
        for (const child of node.children) {
            walk(child)
        }
    }

    for (const root of tree) {
        walk(root)
    }

    return result
}

async function startDaemonOnRandomPort(daemon: ViewPrintDaemon): Promise<number> {
    await daemon.start()
    return daemon.getPort()
}

describe('ViewPrintDaemon', () => {
    let daemon: ViewPrintDaemon
    let client: DaemonClient

    beforeEach(async () => {
        daemon = new ViewPrintDaemon({ port: 0 })
        await daemon.start()
        client = new DaemonClient({ port: daemon.getPort() })
    })

    afterEach(async () => {
        await daemon.stop()
    })

    it('responds to health check', async () => {
        const response = await fetch(`http://localhost:${daemon.getPort()}/health`)
        const body = await response.json()
        expect(body).toEqual({ ok: true })
    })

    it('captures lightweight layout tree at depth=1', async () => {
        const graph = await client.capture('test-daemon', testPage)

        expect(graph.url).toBe(testPage)
        expect(graph.tree).toHaveLength(1)
        expect(graph.tree[0].tag).toBe('body')
        // depth=1: every direct child is collapsed with childrenCount
        for (const child of graph.tree[0].children) {
            expect(child.children).toEqual([])
        }

        const flat = flattenTree(graph.tree)
        const node = Object.values(flat)[0]
        expect('computedStyles' in node).toBe(false)
        expect('cascade' in node).toBe(false)
    })

    it('creates a headed session only when capture requests no-headless', async () => {
        const headlessModes: boolean[] = []
        const startSpy = vi.spyOn(BrowserSession.prototype, 'start').mockImplementation(async function (this: BrowserSession) {
            headlessModes.push(this.isHeadless())
        })
        const captureSpy = vi.spyOn(BrowserSession.prototype, 'capture').mockResolvedValue({
            url: testPage,
            viewport: { width: 1280, height: 720 },
            tree: []
        })

        try {
            await client.capture('headed-session', testPage, undefined, 1, [], undefined, { noHeadless: true })
            await client.capture('headed-session', testPage)

            expect(headlessModes).toEqual([false])
            expect(captureSpy).toHaveBeenCalledTimes(2)
        } finally {
            startSpy.mockRestore()
            captureSpy.mockRestore()
        }
    })

    it('respects depth parameter via HTTP API', async () => {
        const graph = await client.capture('test-daemon-depth', testPage, undefined, 9999)

        // At depth=9999, button should be reachable as a nested descendant
        const flat = flattenTree(graph.tree)
        const button = Object.values(flat).find((node) => node.tag === 'button')
        expect(button).toBeDefined()
        expect(button!.text).toBe('Add')
    })

    it('captures accessibility snapshot tree', async () => {
        const snapshot = await client.snapshot('test-daemon', testPage)

        expect(snapshot.url).toBe(testPage)
        expect(snapshot.tree.length).toBeGreaterThan(0)

        const root = snapshot.tree[0]
        expect(root.tag).toBe('body')
        expect(root.children.length).toBeGreaterThan(0)

        // At depth=1 the button is hidden inside a collapsed container; container is shown as stub
        const container = root.children.find((node) => node.ref === 'e2')
        expect(container).toBeDefined()
        expect(container!.childrenCount).toBeGreaterThan(0)
        expect(container!.children).toEqual([])
    })

    it('snapshot HTTP API includes id and className top-level fields', async () => {
        const taggedPage = `data:text/html,${encodeURIComponent(`
            <!DOCTYPE html>
            <html>
            <body>
                <header id="page-header" class="site-header dark">
                    <h1 id="title">Hello</h1>
                </header>
            </body>
            </html>
        `)}`
        const snapshot = await client.snapshot('test-snapshot-classid-http', taggedPage, undefined, 9999)

        function findByTag(nodes: typeof snapshot.tree, tag: string): typeof snapshot.tree[number] | undefined {
            for (const n of nodes) {
                if (n.tag === tag) return n
                const inChild = findByTag(n.children, tag)
                if (inChild) return inChild
            }
            return undefined
        }

        const header = findByTag(snapshot.tree, 'header')
        expect(header).toBeDefined()
        expect(header!.id).toBe('page-header')
        expect(header!.className).toBe('site-header dark')

        const h1 = findByTag(snapshot.tree, 'h1')
        expect(h1).toBeDefined()
        expect(h1!.id).toBe('title')
    })

    it('executes batch commands', async () => {
        const results = await client.batch('test-daemon', [
            ['capture', testPage],
            ['eval', "document.title"],
            ['status']
        ])

        expect(Array.isArray(results.results)).toBe(true)
        expect(results.results).toHaveLength(3)
        expect((results.results[0] as { url: string }).url).toBe(testPage)
        expect((results.results[1] as { result: string }).result).toBe('Daemon Test')
        expect((results.results[2] as { url: string; elementCount: number }).elementCount).toBeGreaterThan(0)
    })

    it('executes batch with depth in options object', async () => {
        const results = await client.batch('test-daemon-depth-batch', [
            ['capture', { url: testPage, depth: 9999 }]
        ])

        const captureResult = results.results[0] as { tree: CaptureNode[] }
        const flat = flattenTree(captureResult.tree)
        const button = Object.values(flat).find((node) => node.tag === 'button')
        expect(button).toBeDefined()
    })

    it('passes expand via HTTP API', async () => {
        // --expand e3 makes e3 the tree root (body excluded)
        const graph = await client.capture('test-daemon-expand', testPage, undefined, 9999, ['e3'])

        expect(graph.tree).toHaveLength(1)
        expect(graph.tree[0].id).toBe('e3')
        expect(graph.tree[0].tag).toBe('button')
        expect(graph.tree[0].text).toBe('Add')
        // depth=9999, full subtree visible
        expect(graph.tree[0].childrenCount).toBe(0)
    })

    it('ignores unknown expand ids gracefully', async () => {
        const graph = await client.capture('test-daemon-expand-unknown', testPage, undefined, 1, ['e999', 'e888'])

        // All expand ids unknown → tree is empty
        expect(graph.tree).toEqual([])
    })

    it('passes CSS query via HTTP API', async () => {
        const graph = await client.capture('test-daemon-query', testPage, undefined, 9999, [], 'button')

        expect(graph.tree.length).toBe(1)
        expect(graph.tree[0].tag).toBe('button')
        expect(graph.tree[0].text).toBe('Add')
        // body excluded; button is the root
        expect(graph.tree[0].id).not.toBe('e1')
    })

    it('returns empty tree for query with no matches via HTTP API', async () => {
        const graph = await client.capture('test-daemon-query-empty', testPage, undefined, 1, [], '.nope')

        expect(graph.tree).toEqual([])
    })

    it('fills input and evaluates JavaScript via daemon', async () => {
        const actionPage = `data:text/html,${encodeURIComponent(`
            <!DOCTYPE html>
            <html>
            <body>
                <input id="email" type="text" />
            </body>
            </html>
        `)}`

        await client.capture('test-daemon', actionPage)
        await client.fill('test-daemon', 'e2', 'hello@example.com')

        const { result } = await client.eval('test-daemon', "document.getElementById('email').value")
        expect(result).toBe('hello@example.com')
    })

    it('inspects full element details', async () => {
        const graph = await client.capture('test-daemon', testPage, undefined, 9999)
        const flat = flattenTree(graph.tree)
        const buttonId = Object.entries(flat).find(
            ([, node]) => node.tag === 'button'
        )?.[0]
        expect(buttonId).toBeDefined()

        const element = await client.inspect('test-daemon', buttonId!) as ElementNode

        expect(element).toBeDefined()
        expect(element.tag).toBe('button')
        expect(element.cascade.some((entry) => entry.property === 'color')).toBe(true)
    })

    it('clicks element and updated tree can be captured', async () => {
        // Use full depth for both captures so counts are comparable
        const graph = await client.capture('test-daemon', testPage, undefined, 9999)
        const initialCount = Object.keys(flattenTree(graph.tree)).length

        const flat = flattenTree(graph.tree)
        const buttonId = Object.entries(flat).find(
            ([, node]) => node.tag === 'button'
        )?.[0]
        expect(buttonId).toBeDefined()

        const clickResult = await client.click('test-daemon', buttonId!)
        expect(clickResult).toEqual({ clicked: true })

        // No url — re-capture current page (the click added a new element)
        const updatedGraph = await client.capture('test-daemon', undefined, undefined, 9999)
        const updatedCount = Object.keys(flattenTree(updatedGraph.tree)).length

        expect(updatedCount).toBeGreaterThan(initialCount)
    })

    it('returns session status', async () => {
        await client.capture('test-daemon', testPage)
        const status = await client.status('test-daemon')

        expect(status.url).toBe(testPage)
        expect(status.elementCount).toBeGreaterThan(0)
    })

    it('closes session', async () => {
        await client.capture('test-daemon', testPage)
        await client.close('test-daemon')

        await expect(client.status('test-daemon')).rejects.toThrow()
    })

    it('exports, imports and renames closed session state', async () => {
        const suffix = Date.now().toString()
        const source = `state-source-${suffix}`
        const imported = `state-imported-${suffix}`
        const renamed = `state-renamed-${suffix}`
        const active = `state-active-${suffix}`

        await client.capture(source, testPage, { width: 1440, height: 900 })
        await client.close(source)
        const exported = await client.exportSession(source)
        expect(exported.name).toBe(source)
        expect(exported.viewport).toEqual({ width: 1440, height: 900 })

        await client.importSession(imported, exported, true)
        await expect(client.importSession(imported, exported)).rejects.toThrow('Use --force to overwrite')
        const importedState = await client.exportSession(imported)
        expect(importedState.name).toBe(imported)
        expect(importedState.url).toBe(testPage)

        await client.renameSession(imported, renamed)
        const renamedState = await client.exportSession(renamed)
        expect(renamedState.name).toBe(renamed)
        expect(renamedState.viewport).toEqual({ width: 1440, height: 900 })

        await client.capture(active, testPage)
        const activeState = await client.exportSession(active)
        await expect(client.renameSession(active, `${active}-renamed`)).rejects.toThrow('open session')
        await expect(client.importSession(active, activeState)).rejects.toThrow('open session')
    })

    it('updates lastActivityAt on each request', async () => {
        const before = daemon.getLastActivityAt()
        // Wait to ensure timestamp difference
        await new Promise((resolve) => setTimeout(resolve, 10))
        await fetch(`http://localhost:${daemon.getPort()}/health`)
        const after = daemon.getLastActivityAt()
        expect(after).toBeGreaterThan(before)
    })

    it('reports idle timeout enabled when configured', () => {
        const daemonWithTimeout = new ViewPrintDaemon({ port: 0, idleTimeoutMs: 1000 })
        expect(daemonWithTimeout.isIdleTimeoutEnabled()).toBe(true)
    })

    it('reports idle timeout disabled when set to 0', () => {
        const daemonNoTimeout = new ViewPrintDaemon({ port: 0, idleTimeoutMs: 0 })
        expect(daemonNoTimeout.isIdleTimeoutEnabled()).toBe(false)
    })

    it('reports idle timeout disabled when negative', () => {
        const daemonNegTimeout = new ViewPrintDaemon({ port: 0, idleTimeoutMs: -100 })
        expect(daemonNegTimeout.isIdleTimeoutEnabled()).toBe(false)
    })

    it('enables and reads per-action profiling via HTTP API', async () => {
        const daemon = new ViewPrintDaemon({ port: 0 })
        const port = await startDaemonOnRandomPort(daemon)
        try {
            const baseUrl = `http://localhost:${port}`
            // Enable
            const enableRes = await fetch(`${baseUrl}/sessions/proftest/profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: true })
            })
            expect(enableRes.status).toBe(200)
            const enabled = await enableRes.json() as { profiling: boolean, timingsCount: number }
            expect(enabled.profiling).toBe(true)
            expect(enabled.timingsCount).toBe(0)

            // Trigger a capture
            const captureRes = await fetch(`${baseUrl}/sessions/proftest/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: testPage })
            })
            expect(captureRes.status).toBe(200)

            // Get timings
            const getRes = await fetch(`${baseUrl}/sessions/proftest/profile`)
            expect(getRes.status).toBe(200)
            const data = await getRes.json() as { timings: Array<{ action: string, durationMs: number }>, enabled: boolean }
            expect(data.enabled).toBe(true)
            expect(data.timings.length).toBeGreaterThan(0)
            expect(data.timings.some((t) => t.action === 'capture')).toBe(true)
            for (const t of data.timings) {
                expect(typeof t.durationMs).toBe('number')
                expect(t.durationMs).toBeGreaterThanOrEqual(0)
            }

            // Disable
            const disableRes = await fetch(`${baseUrl}/sessions/proftest/profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false })
            })
            const disabled = await disableRes.json() as { profiling: boolean }
            expect(disabled.profiling).toBe(false)

            // Clear
            const clearRes = await fetch(`${baseUrl}/sessions/proftest/profile`, { method: 'DELETE' })
            const cleared = await clearRes.json() as { cleared: number }
            expect(cleared.cleared).toBeGreaterThan(0)
        } finally {
            await daemon.stop()
        }
    })

    it('returns empty trace report when no tracing is active', async () => {
        const daemon = new ViewPrintDaemon({ port: 0 })
        const port = await startDaemonOnRandomPort(daemon)
        try {
            const res = await fetch(`http://localhost:${port}/sessions/tracetest/trace/report`)
            expect(res.status).toBe(200)
            const data = await res.json() as { report: { eventCount: number } }
            expect(data.report.eventCount).toBe(0)
        } finally {
            await daemon.stop()
        }
    })
})

describe('ViewPrintDaemon integration', () => {
    it('shuts down via POST /shutdown endpoint', async () => {
        const port = 17350
        const entryScript = path.resolve(__dirname, '../dist/src/daemon-entry.js')
        const child = spawn(process.execPath, [entryScript, `--port=${port}`], {
            stdio: ['ignore', 'pipe', 'pipe']
        })

        try {
            // Wait for daemon to be ready
            for (let i = 0; i < 50; i++) {
                try {
                    const res = await fetch(`http://localhost:${port}/health`)
                    if (res.ok) break
                } catch { /* not ready yet */ }
                await new Promise((resolve) => setTimeout(resolve, 100))
            }

            const response = await fetch(`http://localhost:${port}/shutdown`, { method: 'POST' })
            expect(response.status).toBe(200)

            // Wait for process to actually exit
            const exitCode = await new Promise<number | null>((resolve) => {
                const timeout = setTimeout(() => resolve(-1), 3000)
                child.on('exit', (code) => {
                    clearTimeout(timeout)
                    resolve(code)
                })
            })
            expect(exitCode).toBe(0)
        } finally {
            try { child.kill('SIGKILL') } catch { /* ignore */ }
        }
    }, 10000)

    it('auto-shuts down after idle timeout', async () => {
        const port = 17351
        const entryScript = path.resolve(__dirname, '../dist/src/daemon-entry.js')
        // idle-timeout=500ms, check interval forced to 100ms via env for fast test
        const child = spawn(process.execPath, [
            entryScript,
            `--port=${port}`,
            '--idle-timeout=500'
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, VIEWPRINT_IDLE_CHECK_INTERVAL_MS: '100' }
        })

        try {
            // Wait for daemon to be ready
            for (let i = 0; i < 50; i++) {
                try {
                    const res = await fetch(`http://localhost:${port}/health`)
                    if (res.ok) break
                } catch { /* not ready yet */ }
                await new Promise((resolve) => setTimeout(resolve, 100))
            }

            // Wait for idle check to fire and shutdown to happen (timeout 500ms + 100ms tick + 2s cleanup)
            const exitCode = await new Promise<number | null>((resolve) => {
                const timeout = setTimeout(() => resolve(-1), 5000)
                child.on('exit', (code) => {
                    clearTimeout(timeout)
                    resolve(code)
                })
            })
            expect(exitCode).toBe(0)
        } finally {
            try { child.kill('SIGKILL') } catch { /* ignore */ }
        }
    }, 15000)

    it('kills chrome-headless-shell descendants after shutdown', async () => {
        const port = 17352
        const entryScript = path.resolve(__dirname, '../dist/src/daemon-entry.js')
        const child = spawn(process.execPath, [entryScript, `--port=${port}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, VIEWPRINT_PORT: String(port) }
        })

        // Snapshot chrome PIDs machine-wide BEFORE capture. We'll compare after shutdown
        // to verify only our daemon's chrome descendants were killed (not chrome from other tests).
        const listChromePids = (): Set<number> => {
            const out = execSync(`ps -axo pid,command | grep -E "chrome-headless-shell" | grep -v grep || true`, { encoding: 'utf-8' })
            const pids = new Set<number>()
            for (const line of out.split('\n')) {
                const trimmed = line.trim()
                if (!trimmed) continue
                const m = trimmed.match(/^(\d+)/)
                if (m) {
                    pids.add(parseInt(m[1], 10))
                }
            }
            return pids
        }

        try {
            // Wait for daemon to be ready
            for (let i = 0; i < 50; i++) {
                try {
                    const res = await fetch(`http://localhost:${port}/health`)
                    if (res.ok) break
                } catch { /* not ready yet */ }
                await new Promise((resolve) => setTimeout(resolve, 100))
            }

            const beforeCapture = listChromePids()

            // Make a capture to spawn chromium
            const response = await fetch(`http://localhost:${port}/sessions/cleanup-test/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: testPage })
            })
            expect(response.status).toBe(200)

            // Wait a moment for chrome to fully spawn
            await new Promise((resolve) => setTimeout(resolve, 500))

            // Confirm chrome processes were spawned (at least new ones vs beforeCapture)
            const afterCapture = listChromePids()
            const newDuringCapture = [...afterCapture].filter((p) => !beforeCapture.has(p))
            expect(newDuringCapture.length).toBeGreaterThan(0)

            // Shutdown
            const shutdownResponse = await fetch(`http://localhost:${port}/shutdown`, { method: 'POST' })
            expect(shutdownResponse.status).toBe(200)

            // Wait for daemon to exit
            await new Promise<number | null>((resolve) => {
                const timeout = setTimeout(() => resolve(-1), 5000)
                child.on('exit', (code) => {
                    clearTimeout(timeout)
                    resolve(code)
                })
            })

            // Give OS a moment to reap
            await new Promise((resolve) => setTimeout(resolve, 1000))

            // Verify: all chrome we spawned during capture are now gone.
            // Other chrome from other tests/processes may legitimately remain.
            const afterShutdown = listChromePids()
            for (const pid of newDuringCapture) {
                expect(afterShutdown.has(pid)).toBe(false)
            }
        } finally {
            try { child.kill('SIGKILL') } catch { /* ignore */ }
        }
    }, 30000)

    it('accepts skipLoad and noLoad options via HTTP /capture', async () => {
        const port = 17353
        const entryScript = path.resolve(__dirname, '../dist/src/daemon-entry.js')
        const child = spawn(process.execPath, [entryScript, `--port=${port}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, VIEWPRINT_PORT: String(port) }
        })
        child.stderr?.on('data', (chunk) => {
            process.stderr.write(`[daemon-err] ${chunk}`)
        })

        try {
            for (let i = 0; i < 50; i++) {
                try {
                    const res = await fetch(`http://localhost:${port}/health`)
                    if (res.ok) break
                } catch { /* not ready yet */ }
                await new Promise((resolve) => setTimeout(resolve, 100))
            }

            // First load — sets baseline
            const r1 = await fetch(`http://localhost:${port}/sessions/httpload-test/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: testPage })
            })
            expect(r1.status).toBe(200)
            const g1 = await r1.json()
            expect(g1.url).toBe(testPage)

            // skipLoad with same URL → fast
            const t0 = Date.now()
            const r2 = await fetch(`http://localhost:${port}/sessions/httpload-test/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: testPage, options: { skipLoad: true } })
            })
            const elapsedSkip = Date.now() - t0
            expect(r2.status).toBe(200)
            expect(elapsedSkip).toBeLessThan(400)

            // noLoad with different URL → ignores URL, stays on current
            const fakeUrl = 'https://should-not-load.invalid/'
            const r3 = await fetch(`http://localhost:${port}/sessions/httpload-test/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: fakeUrl, options: { noLoad: true } })
            })
            expect(r3.status).toBe(200)
            const g3 = await r3.json()
            expect(g3.url).toBe(testPage)
        } finally {
            await fetch(`http://localhost:${port}/shutdown`, { method: 'POST' }).catch(() => {})
            try { child.kill('SIGKILL') } catch { /* ignore */ }
        }
    }, 30000)
})
