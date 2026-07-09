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
})
