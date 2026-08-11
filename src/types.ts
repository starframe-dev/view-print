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
    name?: string
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

export interface CaptureNode {
    id: string
    parentId?: string
    tag: string
    role?: string
    name?: string
    attributes: Record<string, string>
    text?: string
    boundingBox: BoundingBox
    childrenCount: number
    children: CaptureNode[]
}

export interface Graph {
    url: string
    viewport: { width: number; height: number }
    tree: CaptureNode[]
}

export interface SnapshotNode {
    ref: string
    tag: string
    role?: string
    name?: string
    text?: string
    id?: string
    className?: string
    boundingBox: BoundingBox
    childrenCount: number
    children: SnapshotNode[]
}

export interface Snapshot {
    url: string
    viewport: { width: number; height: number }
    tree: SnapshotNode[]
}

export interface SessionState {
    name: string
    url?: string
    viewport?: { width: number; height: number }
    cookies: Array<{ name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }>
    localStorage: Record<string, string>
    sessionStorage: Record<string, string>
}

export interface NetworkRequest {
    url: string
    method: string
    headers: Record<string, string>
    timestamp: number
    status?: number
    responseHeaders?: Record<string, string>
    responseBody?: string
}

export interface NetworkRoute {
    url?: string
    abort?: boolean
    status?: number
    body?: string
    contentType?: string
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
    name?: string
    attributes: Record<string, string>
    text?: string
    boundingBox: BoundingBox
}

export interface PseudoElementData {
    boundingBox: BoundingBox
    computedStyles: Record<string, string>
    cascade: CascadeEntry[]
}

export interface ActionTiming {
    action: string
    durationMs: number
    timestamp: number
}

export interface ActionReport {
    count: number
    totalMs: number
    avgMs: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    byAction: Record<string, { count: number, totalMs: number, avgMs: number }>
}

export interface TraceReport {
    path: string
    durationMs: number
    eventCount: number
    sizeBytes: number
    categoryCounts: Record<string, number>
    topEvents: Array<{ name: string, dur: number, ts: number }>
}
