export interface BoundingBox {
    x: number
    y: number
    width: number
    height: number
}

export interface CascadeEntry {
    property: string
    value: string
    source: 'inline' | 'stylesheet' | 'inherited' | 'user-agent'
    selector?: string
    sheet?: string
}

export interface ElementNodeBase {
    id: string
    parentId?: string
    tag: string
    role?: string
    attributes: Record<string, string>
    text?: string
    boundingBox: BoundingBox
}

export interface ElementNode extends ElementNodeBase {
    computedStyles: Record<string, string>
    cascade: CascadeEntry[]
    pseudo: {
        before?: PseudoElementNode
        after?: PseudoElementNode
    }
}

export interface SnapshotElementNode extends ElementNodeBase {}

export interface PseudoElementNode {
    id: string
    parentId: string
    pseudo: 'before' | 'after'
    boundingBox: BoundingBox
    computedStyles: Record<string, string>
    cascade: CascadeEntry[]
}

export interface Edge {
    from: string
    to: string
    type: 'child' | 'pseudo'
}

export interface Graph {
    url: string
    viewport: { width: number; height: number }
    nodes: Record<string, SnapshotElementNode>
}

export interface SessionState {
    name: string
    url?: string
    cookies: unknown[]
    localStorage: Record<string, string>
}

export interface RawElementData {
    id: string
    parentId?: string
    tag: string
    role?: string
    attributes: Record<string, string>
    text?: string
    boundingBox: BoundingBox
    computedStyles: Record<string, string>
    cascade: CascadeEntry[]
    pseudo: {
        before?: PseudoElementData
        after?: PseudoElementData
    }
}

export interface RawSnapshotElement {
    id: string
    parentId?: string
    tag: string
    role?: string
    attributes: Record<string, string>
    text?: string
    boundingBox: BoundingBox
}

export interface PseudoElementData {
    boundingBox: BoundingBox
    computedStyles: Record<string, string>
    cascade: CascadeEntry[]
}
