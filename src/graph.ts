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
    const childrenByParent = new Map<string, string[]>()
    let rootId: string | undefined

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

        if (raw.parentId === undefined) {
            rootId ??= raw.id
        } else {
            const childIds = childrenByParent.get(raw.parentId) ?? []
            childIds.push(raw.id)
            childrenByParent.set(raw.parentId, childIds)
        }
    }

    if (expand.size > 0 || hasQuery) {
        const tree: CaptureNode[] = []
        for (const id of expand) {
            if (nodes[id]) {
                tree.push(buildCaptureNode(id, nodes, childrenByParent, 0, depth))
            }
        }
        return { url, viewport, tree }
    }

    if (rootId === undefined) {
        return { url, viewport, tree: [] }
    }

    return {
        url,
        viewport,
        tree: [buildCaptureNode(rootId, nodes, childrenByParent, 0, depth)]
    }
}

function buildCaptureNode(
    id: string,
    nodes: Record<string, SnapshotElementNode>,
    childrenByParent: Map<string, string[]>,
    level: number,
    maxDepth: number
): CaptureNode {
    const node = nodes[id]
    const childIds = childrenByParent.get(id) ?? []

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
            buildCaptureNode(childId, nodes, childrenByParent, level + 1, maxDepth)
        )
    }
}
