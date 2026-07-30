import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
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

        try {
            // Wait for daemon to be ready
            for (let i = 0; i < 50; i++) {
                try {
                    const res = await fetch(`http://localhost:${port}/health`)
                    if (res.ok) break
                } catch { /* not ready yet */ }
                await new Promise((resolve) => setTimeout(resolve, 100))
            }

            // Make a capture to spawn chromium
            const response = await fetch(`http://localhost:${port}/sessions/cleanup-test/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: testPage })
            })
            expect(response.status).toBe(200)

            // Confirm chrome processes exist
            const before = execSync('ps -axo pid,command | grep -E "chrome-headless-shell" | grep -v grep || true', { encoding: 'utf-8' })
            expect(before.trim().length).toBeGreaterThan(0)

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
            await new Promise((resolve) => setTimeout(resolve, 500))

            // Verify no chrome-headless-shell processes remain
            const after = execSync('ps -axo pid,command | grep -E "chrome-headless-shell" | grep -v grep || true', { encoding: 'utf-8' })
            expect(after.trim()).toBe('')
        } finally {
            try { child.kill('SIGKILL') } catch { /* ignore */ }
        }
    }, 30000)
})
