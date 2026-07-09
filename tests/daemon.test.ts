import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
