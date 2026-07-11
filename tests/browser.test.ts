import http from 'node:http'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest' 
import { createBrowserSession } from '../src/browser.js'
import type { ElementNode } from '../src/types.js'

const testPage = `data:text/html,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
  <title>Test</title>
  <style>
    #box { color: red; width: 100px; }
    #btn { background: blue; }
    #box::before { content: ''; position: absolute; top: 5px; left: 10px; width: 20px; height: 30px; }
  </style>
</head>
<body>
  <div id="container">
    <div id="box">Hello</div>
    <button id="btn" onclick="
      const d = document.createElement('div');
      d.id = 'added';
      d.textContent = 'added';
      document.body.appendChild(d);
    ">Add</button>
  </div>
  <script>var secret = 'not visible';</script>
</body>
</html>
`)}`

describe('BrowserSession', () => {
    it('captures lightweight layout graph from a page', async () => {
        const session = await createBrowserSession('test-browser')
        try {
            const graph = await session.capture(testPage)

            expect(graph.url).toBe(testPage)
            expect(graph.viewport.width).toBeGreaterThan(0)
            expect(Object.keys(graph.nodes).length).toBeGreaterThan(0)

            const bodyNode = graph.nodes['e1']
            expect(bodyNode).toBeDefined()
            expect(bodyNode.tag).toBe('body')
            expect(bodyNode.text).toBeUndefined()

            const boxNode = Object.values(graph.nodes).find(
                (node) => node.tag === 'div' && node.attributes.id === 'box'
            )
            expect(boxNode).toBeDefined()
            expect(boxNode!.text).toBe('Hello')
            expect('computedStyles' in boxNode!).toBe(false)
            expect('cascade' in boxNode!).toBe(false)

            const buttonNode = Object.values(graph.nodes).find(
                (node) => node.tag === 'button'
            )
            expect(buttonNode).toBeDefined()
            expect(buttonNode!.text).toBe('Add')
        } finally {
            await session.close()
        }
    })

    it('inspects full element details', async () => {
        const session = await createBrowserSession('test-browser-inspect')
        try {
            const graph = await session.capture(testPage)
            const boxId = Object.entries(graph.nodes).find(
                ([, node]) => node.tag === 'div' && node.attributes.id === 'box'
            )?.[0]
            expect(boxId).toBeDefined()

            const element = await session.inspect(boxId!) as ElementNode

            expect(element).toBeDefined()
            expect(element.tag).toBe('div')
            expect(element.attributes.id).toBe('box')
            expect(element.cascade.some((entry) => entry.property === 'color')).toBe(true)
            expect(element.computedStyles['color']).toBeDefined()
            expect(element.pseudo.before).toBeDefined()
        } finally {
            await session.close()
        }
    })

    it('clicks element and recaptures updated graph', async () => {
        const session = await createBrowserSession('test-browser-click')
        try {
            const graph = await session.capture(testPage)
            const initialCount = Object.keys(graph.nodes).length

            const buttonId = Object.entries(graph.nodes).find(
                ([, node]) => node.tag === 'button'
            )?.[0]
            expect(buttonId).toBeDefined()

            await session.click(buttonId!)
            const updatedGraph = await session.capture()
            const updatedCount = Object.keys(updatedGraph.nodes).length

            expect(updatedCount).toBeGreaterThan(initialCount)
        } finally {
            await session.close()
        }
    })

    it('returns session status', async () => {
        const session = await createBrowserSession('test-browser-status')
        try {
            await session.capture(testPage)
            const status = await session.status()

            expect(status.url).toBe(testPage)
            expect(status.elementCount).toBeGreaterThan(0)
        } finally {
            await session.close()
        }
    })

    it('applies custom viewport', async () => {
        const session = await createBrowserSession('test-viewport')
        try {
            const graph = await session.capture(testPage, { width: 1920, height: 1080 })

            expect(graph.viewport).toEqual({ width: 1920, height: 1080 })
        } finally {
            await session.close()
        }
    })

    it('captures accessibility snapshot tree', async () => {
        const session = await createBrowserSession('test-snapshot')
        try {
            const snapshot = await session.snapshot(testPage, { width: 1280, height: 720 })

            expect(snapshot.url).toBe(testPage)
            expect(snapshot.tree.length).toBeGreaterThan(0)

            const root = snapshot.tree[0]
            expect(root.tag).toBe('body')
            expect(root.children.length).toBeGreaterThan(0)

            const button = root.children.find((node) => node.role === 'button')
            expect(button).toBeDefined()
            expect(button!.name).toBe('Add')
        } finally {
            await session.close()
        }
    })

    it('fills input and evaluates JavaScript', async () => {
        const session = await createBrowserSession('test-actions')
        try {
            const actionPage = `data:text/html,${encodeURIComponent(`
                <!DOCTYPE html>
                <html>
                <body>
                    <input id="email" type="text" />
                    <div id="result"></div>
                </body>
                </html>
            `)}`

            await session.capture(actionPage)
            await session.fill('e2', 'hello@example.com')

            const value = await session.eval("document.getElementById('email').value")
            expect(value).toBe('hello@example.com')
        } finally {
            await session.close()
        }
    })

    it('mocks network route and reads response', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(`<html><body>
                <script>
                    fetch('/api/data').then(r => r.json()).then(d => {
                        window.__result = d
                    })
                </script>
            </body></html>`)
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        const url = `http://localhost:${port}`

        const session = await createBrowserSession('test-route')
        try {
            await session.route('**/api/data', { body: JSON.stringify({ ok: true }) })
            await session.capture(url)
            await session.wait({ fn: "typeof window.__result !== 'undefined'", timeout: 5000 })

            const result = await session.eval('window.__result')
            expect(result).toEqual({ ok: true })
        } finally {
            await session.close()
            server.close()
        }
    })

    it('sets and reads cookies', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body></body></html>')
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        const url = `http://localhost:${port}`

        const session = await createBrowserSession('test-cookies')
        try {
            await session.capture(url)
            await session.setCookie('session', 'abc')

            const cookies = await session.getCookies()
            expect(cookies.some((c) => c.name === 'session' && c.value === 'abc')).toBe(true)
        } finally {
            await session.close()
            server.close()
        }
    })

    it('sets and reads localStorage', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body></body></html>')
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        const url = `http://localhost:${port}`

        const session = await createBrowserSession('test-storage')
        try {
            await session.capture(url)
            await session.setLocalStorage('key', 'value')

            const data = await session.getLocalStorage()
            expect(data.key).toBe('value')
        } finally {
            await session.close()
            server.close()
        }
    })

    it('manages multiple browser tabs', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body></body></html>')
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        const url = `http://localhost:${port}`

        const session = await createBrowserSession('test-tabs')
        try {
            await session.capture(url)
            await session.newTab(url)
            const tabs = await session.listTabs()
            expect(tabs.length).toBe(2)
        } finally {
            await session.close()
            server.close()
        }
    })

    it('takes page screenshot', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body></head></body></html>')
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        const url = `http://localhost:${port}`

        const session = await createBrowserSession('test-screenshot')
        try {
            await session.capture(url)
            const path = await session.screenshotPage('/tmp/view-print-test-page.png')
            expect(path).toBe('/tmp/view-print-test-page.png')
        } finally {
            await session.close()
            server.close()
        }
    })

    it('reads text content from the page', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body><h1>Title</h1><p>Hello world</p></body></html>')
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        const url = `http://localhost:${port}`

        const session = await createBrowserSession('test-read')
        try {
            await session.capture(url)

            const text = await session.read('text')
            expect(text).toContain('Title')
            expect(text).toContain('Hello world')

            const md = await session.read('markdown')
            expect(md).toContain('# Title')
            expect(md).toContain('Hello world')
        } finally {
            await session.close()
            server.close()
        }
    })

    it('waits for text condition', async () => {
        const session = await createBrowserSession('test-wait')
        try {
            const waitPage = `data:text/html,${encodeURIComponent(`
                <!DOCTYPE html>
                <html>
                <body>
                    <div id="target">Initial</div>
                    <script>
                        setTimeout(() => document.getElementById('target').textContent = 'Ready', 200)
                    </script>
                </body>
                </html>
            `)}`

            await session.capture(waitPage)
            await session.wait({ text: 'Ready', timeout: 5000 })
        } finally {
            await session.close()
        }
    })
})
