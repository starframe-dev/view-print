import type { Graph, RawSnapshotElement } from './types.js'

export function buildGraph(
    rawData: RawSnapshotElement[],
    url: string,
    viewport: { width: number; height: number }
): Graph {
    const nodes: Graph['nodes'] = {}

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

    return { url, viewport, nodes }
}
