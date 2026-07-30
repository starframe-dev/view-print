import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/graph.js'
import type { RawSnapshotElement } from '../src/types.js'

function createRawElement(
    id: string,
    parentId?: string,
    tag = 'div',
    extras: Partial<RawSnapshotElement> = {}
): RawSnapshotElement {
    return {
        id,
        parentId,
        tag,
        attributes: extras.attributes ?? {},
        boundingBox: extras.boundingBox ?? { x: 0, y: 0, width: 100, height: 100 },
        ...(extras.role !== undefined ? { role: extras.role } : {}),
        ...(extras.name !== undefined ? { name: extras.name } : {}),
        ...(extras.text !== undefined ? { text: extras.text } : {})
    }
}

function findNode(tree: { id: string; children: Array<{ id: string; children: unknown[] }> }, id: string): { id: string; children: unknown[] } | undefined {
    if (tree.id === id) return tree as { id: string; children: unknown[] }
    for (const child of tree.children) {
        const found = findNode(child as { id: string; children: Array<{ id: string; children: unknown[] }> }, id)
        if (found) return found
    }
    return undefined
}

describe('buildGraph', () => {
    it('builds tree at depth=1 with collapsed children', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div'),
            createRawElement('e3', 'e2', 'span'),
            createRawElement('e4', 'e2', 'span'),
            createRawElement('e5', 'e1', 'main')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 1)

        expect(graph.url).toBe('https://example.com')
        expect(graph.viewport).toEqual({ width: 1280, height: 720 })
        expect(graph.tree).toHaveLength(1)
        expect(graph.tree[0].id).toBe('e1')
        expect(graph.tree[0].children).toHaveLength(2)
        expect(graph.tree[0].childrenCount).toBe(2)

        const e2 = graph.tree[0].children.find((c) => c.id === 'e2')!
        expect(e2.children).toEqual([])
        expect(e2.childrenCount).toBe(2)

        const e5 = graph.tree[0].children.find((c) => c.id === 'e5')!
        expect(e5.children).toEqual([])
        expect(e5.childrenCount).toBe(0)
    })

    it('expands 3 levels at depth=3', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div'),
            createRawElement('e3', 'e2', 'div'),
            createRawElement('e4', 'e3', 'span')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 3)

        expect(graph.tree).toHaveLength(1)
        expect(graph.tree[0].children).toHaveLength(1)
        expect(graph.tree[0].children[0].children).toHaveLength(1)
        expect(graph.tree[0].children[0].children[0].children).toHaveLength(1)

        const e4 = graph.tree[0].children[0].children[0].children[0]
        expect(e4.id).toBe('e4')
        expect(e4.children).toEqual([])
        expect(e4.childrenCount).toBe(0)
    })

    it('fully expands at very large depth', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div'),
            createRawElement('e3', 'e2', 'div'),
            createRawElement('e4', 'e3', 'span')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 9999)

        const e4 = findNode(graph.tree[0] as { id: string; children: Array<{ id: string; children: unknown[] }> }, 'e4')!
        expect(e4.children).toEqual([])
    })

    it('defaults to depth=1 when depth argument is omitted', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div'),
            createRawElement('e3', 'e2', 'span')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 })

        expect(graph.tree[0].children[0].children).toEqual([])
        expect(graph.tree[0].children[0].childrenCount).toBe(1)
    })

    it('returns empty tree when no root found', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', 'e999', 'div')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 })

        expect(graph.tree).toEqual([])
    })

    it('preserves all node fields including role, name, text, attributes', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'button', { role: 'button', name: 'Submit', text: 'Submit', attributes: { type: 'submit' } })
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 1)
        const e2 = graph.tree[0].children[0]

        expect(e2.tag).toBe('button')
        expect(e2.role).toBe('button')
        expect(e2.name).toBe('Submit')
        expect(e2.text).toBe('Submit')
        expect(e2.attributes).toEqual({ type: 'submit' })
        expect(e2.boundingBox).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    })

    it('does not include computedStyles or cascade in capture nodes', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 1)
        const node = graph.tree[0]

        expect('computedStyles' in node).toBe(false)
        expect('cascade' in node).toBe(false)
    })

    it('preserves parentId in capture nodes', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 1)
        const e2 = graph.tree[0].children[0]

        expect(e2.parentId).toBe('e1')
        expect(graph.tree[0].parentId).toBeUndefined()
    })

    it('uses expand ids as tree roots (body excluded)', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div'),
            createRawElement('e3', 'e2', 'div'),
            createRawElement('e4', 'e3', 'span'),
            createRawElement('e5', 'e3', 'span')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 1, new Set(['e3']))

        // Body (e1) is NOT in the tree; e3 is the only root
        expect(graph.tree).toHaveLength(1)
        expect(graph.tree[0].id).toBe('e3')
        expect(graph.tree[0].parentId).toBe('e2')

        // depth=1: e3 is expanded, e4/e5 are stubs (children: [], childrenCount: 0)
        expect(graph.tree[0].children.length).toBe(2)
        expect(graph.tree[0].children.map((c) => c.id).sort()).toEqual(['e4', 'e5'])
        for (const child of graph.tree[0].children) {
            expect(child.children).toEqual([])
            expect(child.childrenCount).toBe(0)
        }
        expect(graph.tree[0].childrenCount).toBe(2)
    })

    it('multiple expand ids produce multiple roots', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div'),
            createRawElement('e3', 'e1', 'div'),
            createRawElement('e4', 'e2', 'span'),
            createRawElement('e5', 'e3', 'span')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 9999, new Set(['e2', 'e3']))

        expect(graph.tree).toHaveLength(2)
        const rootIds = graph.tree.map((n) => n.id).sort()
        expect(rootIds).toEqual(['e2', 'e3'])

        const e2 = graph.tree.find((n) => n.id === 'e2')!
        expect(e2.children.length).toBe(1)
        expect(e2.children[0].id).toBe('e4')

        const e3 = graph.tree.find((n) => n.id === 'e3')!
        expect(e3.children.length).toBe(1)
        expect(e3.children[0].id).toBe('e5')
    })

    it('expand respects depth (depth=N counts from each expand root)', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div'),
            createRawElement('e3', 'e2', 'div'),
            createRawElement('e4', 'e3', 'span')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 2, new Set(['e2']))

        expect(graph.tree).toHaveLength(1)
        expect(graph.tree[0].id).toBe('e2')
        // depth=2 from e2: e2 + e3 + e4 (collapsed at level 2)
        expect(graph.tree[0].children.length).toBe(1)
        expect(graph.tree[0].children[0].id).toBe('e3')
        expect(graph.tree[0].children[0].children.length).toBe(1)
        expect(graph.tree[0].children[0].children[0].id).toBe('e4')
        expect(graph.tree[0].children[0].children[0].children).toEqual([])
    })

    it('ignores unknown ids in expand set', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div')
        ]

        // All ids unknown → tree is empty (no body fallback when expand is given)
        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 1, new Set(['e999', 'e888']))

        expect(graph.tree).toEqual([])
    })

    it('expand with empty set behaves like no expand', () => {
        const raw: RawSnapshotElement[] = [
            createRawElement('e1', undefined, 'body'),
            createRawElement('e2', 'e1', 'div'),
            createRawElement('e3', 'e2', 'span')
        ]

        const graph = buildGraph(raw, 'https://example.com', { width: 1280, height: 720 }, 1, new Set())

        expect(graph.tree).toHaveLength(1)
        expect(graph.tree[0].id).toBe('e1')
        expect(graph.tree[0].children[0].children).toEqual([])
        expect(graph.tree[0].children[0].childrenCount).toBe(1)
    })
})
