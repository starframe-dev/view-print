import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/graph.js'
import type { RawSnapshotElement } from '../src/types.js'

function createRawElement(
    id: string,
    parentId?: string,
    tag = 'div'
): RawSnapshotElement {
    return {
        id,
        parentId,
        tag,
        attributes: {},
        boundingBox: { x: 0, y: 0, width: 100, height: 100 }
    }
}

describe('buildGraph', () => {
    it('builds flat graph with parentId', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1'),
            createRawElement('e3', 'e1')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 })

        expect(graph.url).toBe('https://example.com')
        expect(graph.viewport).toEqual({ width: 1280, height: 720 })
        expect(Object.keys(graph.nodes)).toHaveLength(3)
        expect(graph.nodes['e1'].parentId).toBeUndefined()
        expect(graph.nodes['e2'].parentId).toBe('e1')
        expect(graph.nodes['e3'].parentId).toBe('e1')
    })

    it('does not include computed styles or cascade in snapshot nodes', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 })
        const node = graph.nodes['e1']

        expect('computedStyles' in node).toBe(false)
        expect('cascade' in node).toBe(false)
    })
})
