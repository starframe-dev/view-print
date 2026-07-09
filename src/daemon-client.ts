import type { ElementNode, Graph } from './types.js'

export interface DaemonClientOptions {
    port: number
}

export class DaemonClient {
    private baseUrl: string

    constructor(options: DaemonClientOptions) {
        this.baseUrl = `http://localhost:${options.port}`
    }

    async health(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/health`)
            return response.ok
        } catch {
            return false
        }
    }

    async capture(
        session: string,
        url?: string,
        viewport?: { width: number; height: number }
    ): Promise<Graph> {
        const response = await fetch(`${this.baseUrl}/sessions/${session}/capture`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, viewport })
        })

        if (!response.ok) {
            throw new Error(`Capture failed: ${response.status} ${await response.text()}`)
        }

        return response.json() as Promise<Graph>
    }

    async inspect(session: string, elementId: string): Promise<ElementNode | null> {
        const response = await fetch(`${this.baseUrl}/sessions/${session}/inspect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ elementId })
        })

        if (!response.ok) {
            throw new Error(`Inspect failed: ${response.status} ${await response.text()}`)
        }

        return response.json() as Promise<ElementNode | null>
    }

    async click(session: string, elementId: string): Promise<{ clicked: boolean }> {
        const response = await fetch(`${this.baseUrl}/sessions/${session}/click`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ elementId })
        })

        if (!response.ok) {
            throw new Error(`Click failed: ${response.status} ${await response.text()}`)
        }

        return response.json() as Promise<{ clicked: boolean }>
    }

    async status(session: string): Promise<{ url?: string; elementCount: number }> {
        const response = await fetch(`${this.baseUrl}/sessions/${session}`)

        if (!response.ok) {
            throw new Error(`Status failed: ${response.status} ${await response.text()}`)
        }

        return response.json() as Promise<{ url?: string; elementCount: number }>
    }

    async close(session: string): Promise<void> {
        const response = await fetch(`${this.baseUrl}/sessions/${session}`, {
            method: 'DELETE'
        })

        if (!response.ok) {
            throw new Error(`Close failed: ${response.status} ${await response.text()}`)
        }
    }
}

export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
    return new DaemonClient(options)
}
