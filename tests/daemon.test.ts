import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { ViewPrintDaemon } from '../src/daemon.js'
import { DaemonClient } from '../src/daemon-client.js'
import type { ElementNode } from '../src/types.js'

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

    it('captures lightweight layout graph', async () => {
        const graph = await client.capture('test-daemon', testPage)

        expect(graph.url).toBe(testPage)
        expect(Object.keys(graph.nodes).length).toBeGreaterThan(0)

        const node = Object.values(graph.nodes)[0]
        expect('computedStyles' in node).toBe(false)
        expect('cascade' in node).toBe(false)
    })

    it('captures accessibility snapshot tree', async () => {
        const snapshot = await client.snapshot('test-daemon', testPage)

        expect(snapshot.url).toBe(testPage)
        expect(snapshot.tree.length).toBeGreaterThan(0)

        const root = snapshot.tree[0]
        expect(root.tag).toBe('body')
        expect(root.children.length).toBeGreaterThan(0)

        const button = root.children.find((node) => node.role === 'button')
        expect(button).toBeDefined()
        expect(button!.name).toBe('Add')
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
        const graph = await client.capture('test-daemon', testPage)
        const buttonId = Object.entries(graph.nodes).find(
            ([, node]) => node.tag === 'button'
        )?.[0]
        expect(buttonId).toBeDefined()

        const element = await client.inspect('test-daemon', buttonId!) as ElementNode

        expect(element).toBeDefined()
        expect(element.tag).toBe('button')
        expect(element.cascade.some((entry) => entry.property === 'color')).toBe(true)
    })

    it('clicks element and updated graph can be captured', async () => {
        const graph = await client.capture('test-daemon', testPage)
        const initialCount = Object.keys(graph.nodes).length

        const buttonId = Object.entries(graph.nodes).find(
            ([, node]) => node.tag === 'button'
        )?.[0]
        expect(buttonId).toBeDefined()

        const clickResult = await client.click('test-daemon', buttonId!)
        expect(clickResult).toEqual({ clicked: true })

        const updatedGraph = await client.capture('test-daemon')
        const updatedCount = Object.keys(updatedGraph.nodes).length

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
})
