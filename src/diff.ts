import type { CaptureNode, Graph } from './types.js'

export interface GraphDiff {
    added: string[]
    removed: string[]
    changed: Array<{
        id: string
        tag: string
        changes: Record<string, { from: unknown; to: unknown }>
    }>
}

export function diffGraphs(before: Graph, after: Graph): GraphDiff {
    const beforeMap = flattenTree(before.tree)
    const afterMap = flattenTree(after.tree)
    const added: string[] = []
    const removed: string[] = []
    const changed: GraphDiff['changed'] = []

    for (const [id, afterNode] of Object.entries(afterMap)) {
        const beforeNode = beforeMap[id]
        if (!beforeNode) {
            added.push(id)
            continue
        }

        const changes: Record<string, { from: unknown; to: unknown }> = {}

        if (beforeNode.text !== afterNode.text) {
            changes.text = { from: beforeNode.text, to: afterNode.text }
        }
        if (beforeNode.name !== afterNode.name) {
            changes.name = { from: beforeNode.name, to: afterNode.name }
        }
        if (JSON.stringify(beforeNode.attributes) !== JSON.stringify(afterNode.attributes)) {
            changes.attributes = { from: beforeNode.attributes, to: afterNode.attributes }
        }
        if (JSON.stringify(beforeNode.boundingBox) !== JSON.stringify(afterNode.boundingBox)) {
            changes.boundingBox = { from: beforeNode.boundingBox, to: afterNode.boundingBox }
        }

        if (Object.keys(changes).length > 0) {
            changed.push({ id, tag: afterNode.tag, changes })
        }
    }

    for (const id of Object.keys(beforeMap)) {
        if (!afterMap[id]) {
            removed.push(id)
        }
    }

    return { added, removed, changed }
}

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
