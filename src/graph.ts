import type { CaptureNode, Graph, RawSnapshotElement, SnapshotElementNode } from './types.js'

export function buildGraph(
    rawData: RawSnapshotElement[],
    url: string,
    viewport: { width: number; height: number },
    depth: number = 1,
    expand: Set<string> = new Set(),
    hasQuery: boolean = false
): Graph {
    const nodes: Record<string, SnapshotElementNode> = {}

    for (const raw of rawData) {
        nodes[raw.id] = {
            id: raw.id,
            parentId: raw.parentId,
            tag: raw.tag,
            role: raw.role,
            name: raw.name,
            attributes: raw.attributes,
            text: raw.text,
            boundingBox: raw.boundingBox
        }
    }

    // If expand is set OR a query was given, never fall back to body as a root.
    // An empty result (no matching ids) returns an empty tree.
    if (expand.size > 0 || hasQuery) {
        const tree: CaptureNode[] = []
        for (const id of expand) {
            if (nodes[id]) {
                tree.push(buildCaptureNode(id, nodes, 0, depth))
            }
        }
        return { url, viewport, tree }
    }

    // Default behaviour: root = body.
    const root = Object.values(nodes).find((node) => node.parentId === undefined)
    if (!root) {
        return { url, viewport, tree: [] }
    }
    return {
        url,
        viewport,
        tree: [buildCaptureNode(root.id, nodes, 0, depth)]
    }
}

function buildCaptureNode(
    id: string,
    nodes: Record<string, SnapshotElementNode>,
    level: number,
    maxDepth: number
): CaptureNode {
    const node = nodes[id]
    const childIds = collectDirectChildIds(nodes, id)

    const base: CaptureNode = {
        id: node.id,
        parentId: node.parentId,
        tag: node.tag,
        role: node.role,
        name: node.name,
        attributes: node.attributes,
        text: node.text,
        boundingBox: node.boundingBox,
        childrenCount: childIds.length,
        children: []
    }

    if (level >= maxDepth) {
        return base
    }

    return {
        ...base,
        children: childIds.map((childId) =>
            buildCaptureNode(childId, nodes, level + 1, maxDepth)
        )
    }
}

function collectDirectChildIds(
    nodes: Record<string, SnapshotElementNode>,
    parentId: string
): string[] {
    return Object.values(nodes)
        .filter((node) => node.parentId === parentId)
        .map((node) => node.id)
}