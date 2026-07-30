import http from 'node:http'
import { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createBrowserSession } from '../src/browser.js'
import type { CaptureNode, ElementNode } from '../src/types.js'

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

function findByTag(tree: CaptureNode[], tag: string): CaptureNode | undefined {
    const flat = flattenTree(tree)
    return Object.values(flat).find((node) => node.tag === tag)
}

function findByAttribute(tree: CaptureNode[], attr: string, value: string): CaptureNode | undefined {
    const flat = flattenTree(tree)
    return Object.values(flat).find((node) => node.attributes[attr] === value)
}

describe('BrowserSession', () => {
    it('captures lightweight layout tree from a page at depth=1', async () => {
        const session = await createBrowserSession('test-browser')
        try {
            const graph = await session.capture(testPage)

            expect(graph.url).toBe(testPage)
            expect(graph.viewport.width).toBeGreaterThan(0)
            expect(graph.tree).toHaveLength(1)

            const bodyNode = graph.tree[0]
            expect(bodyNode.id).toBe('e1')
            expect(bodyNode.tag).toBe('body')
            expect(bodyNode.text).toBeUndefined()
            expect(bodyNode.children.length).toBeGreaterThan(0)
            // All direct children are collapsed at depth=1
            for (const child of bodyNode.children) {
                expect(child.children).toEqual([])
                expect(child.childrenCount).toBeGreaterThanOrEqual(0)
            }

            // box and button are nested deeper (level=2), so they appear only as childrenCount
            const container = bodyNode.children.find((c) => c.attributes.id === 'container')
            expect(container).toBeDefined()
            expect(container!.childrenCount).toBeGreaterThan(0)
        } finally {
            await session.close()
        }
    })

    it('uses CSS query as tree roots via --query', async () => {
        const session = await createBrowserSession('test-browser-query')
        try {
            // All buttons in the test page: there is exactly one <button id="btn">
            const graph = await session.capture(testPage, undefined, 9999, new Set(), 'button')

            expect(graph.tree.length).toBeGreaterThanOrEqual(1)
            const button = graph.tree.find((n) => n.tag === 'button')!
            expect(button).toBeDefined()
            expect(button.attributes.id).toBe('btn')
            expect(button.text).toBe('Add')
            // body is NOT in the tree (button is the root)
            expect(graph.tree.find((n) => n.id === 'e1')).toBeUndefined()
        } finally {
            await session.close()
        }
    })

    it('combines --query and --depth (depth=1 stops at first level)', async () => {
        const session = await createBrowserSession('test-browser-query-depth')
        try {
            const graph = await session.capture(testPage, undefined, 1, new Set(), 'button')

            expect(graph.tree.length).toBe(1)
            expect(graph.tree[0].tag).toBe('button')
            expect(graph.tree[0].children).toEqual([])
        } finally {
            await session.close()
        }
    })

    it('combines --query with --expand (multiple roots)', async () => {
        const session = await createBrowserSession('test-browser-query-expand')
        try {
            // query adds the button, expand adds the container — both become roots
            const graph = await session.capture(testPage, undefined, 9999, new Set(['e2']), 'button')

            expect(graph.tree.length).toBe(2)
            const ids = graph.tree.map((n) => n.id).sort()
            expect(ids).toEqual(['e2', 'e4']) // e2=container, e4=button
        } finally {
            await session.close()
        }
    })

    it('returns empty tree for query with no matches', async () => {
        const session = await createBrowserSession('test-browser-query-empty')
        try {
            const graph = await session.capture(testPage, undefined, 1, new Set(), '.does-not-exist')

            expect(graph.tree).toEqual([])
        } finally {
            await session.close()
        }
    })

    it('expands full tree at depth=9999', async () => {
        const session = await createBrowserSession('test-browser-depth')
        try {
            const graph = await session.capture(testPage, undefined, 9999)
            const flat = flattenTree(graph.tree)

            // All elements should be present in the flat set
            const boxNode = flat[Object.keys(flat).find((id) => {
                const node = flat[id]
                return node.tag === 'div' && node.attributes.id === 'box'
            })!]
            expect(boxNode).toBeDefined()
            // Box has no children, so children=[] and childrenCount=0
            expect(boxNode.children).toEqual([])
            expect(boxNode.childrenCount).toBe(0)
        } finally {
            await session.close()
        }
    })

    it('inspects full element details', async () => {
        const session = await createBrowserSession('test-browser-inspect')
        try {
            const graph = await session.capture(testPage, undefined, 9999)
            const boxNode = findByAttribute(graph.tree, 'id', 'box')
            expect(boxNode).toBeDefined()

            const element = await session.inspect(boxNode!.id) as ElementNode

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

    it('clicks element and recaptures updated tree', async () => {
        const session = await createBrowserSession('test-browser-click')
        try {
            // Use full depth for both captures so counts are comparable
            const graph = await session.capture(testPage, undefined, 9999)
            const initialCount = Object.keys(flattenTree(graph.tree)).length

            const buttonNode = findByTag(graph.tree, 'button')
            expect(buttonNode).toBeDefined()

            await session.click(buttonNode!.id)
            // No url — re-capture current page (the click added a new element)
            const updatedGraph = await session.capture(undefined, undefined, 9999)
            const updatedCount = Object.keys(flattenTree(updatedGraph.tree)).length

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

    it('captures accessibility snapshot tree at depth=1', async () => {
        const session = await createBrowserSession('test-snapshot')
        try {
            const snapshot = await session.snapshot(testPage, { width: 1280, height: 720 })

            expect(snapshot.url).toBe(testPage)
            expect(snapshot.tree.length).toBeGreaterThan(0)

            const root = snapshot.tree[0]
            expect(root.tag).toBe('body')
            expect(root.childrenCount).toBeGreaterThan(0)
            expect(root.children.length).toBeGreaterThan(0)

            // At depth=1 the button is inside a collapsed container; container is shown as stub
            const container = root.children.find((node) => node.ref === 'e2')
            expect(container).toBeDefined()
            expect(container!.childrenCount).toBeGreaterThan(0)
            expect(container!.children).toEqual([])
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

    it('takes element screenshot with padding', async () => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(`
                <!DOCTYPE html>
                <html><body style="margin:0;padding:0;">
                    <div style="width:1280px;height:720px;background:#eee;">
                        <div id="box" style="position:absolute;top:100px;left:100px;width:200px;height:100px;background:#0af;"></div>
                    </div>
                </body></html>
            `)
        })
        await new Promise<void>((resolve) => server.listen(0, resolve))
        const port = (server.address() as AddressInfo).port
        const url = `http://localhost:${port}`

        const session = await createBrowserSession('test-screenshot-padding')
        try {
            await session.capture(url)
            // Capture again with --expand to find the box element's id
            const graph = await session.capture(url, undefined, 9999, new Set(), '#box')
            const ref = graph.tree[0].id

            const pathNoPadding = `/tmp/view-print-test-el-no-pad.png`
            const pathWithPadding = `/tmp/view-print-test-el-pad.png`

            const noPad = await session.screenshotElement(ref, 0, pathNoPadding)
            expect(noPad).toBe(pathNoPadding)

            const withPad = await session.screenshotElement(ref, 50, pathWithPadding)
            expect(withPad).toBe(pathWithPadding)

            const { statSync } = await import('node:fs')
            const noPadSize = statSync(pathNoPadding).size
            const padSize = statSync(pathWithPadding).size
            expect(padSize).toBeGreaterThan(noPadSize)
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
