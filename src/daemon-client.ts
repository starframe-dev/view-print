import type { ElementNode, Graph, NetworkRoute, Snapshot } from './types.js'
import type { Cookie } from 'playwright'
import type { WaitCondition } from './browser.js'

export interface DaemonClientOptions {
    port: number
}

export class DaemonClient {
    private baseUrl: string

    constructor(options: DaemonClientOptions) {
        this.baseUrl = `http://localhost:${options.port}`
    }

    private async post(path: string, body: unknown): Promise<Response> {
        return fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
    }

    private async get(path: string): Promise<Response> {
        return fetch(`${this.baseUrl}${path}`)
    }

    private async handleResponse(response: Response, action: string): Promise<unknown> {
        if (!response.ok) {
            throw new Error(`${action} failed: ${response.status} ${await response.text()}`)
        }
        return response.json()
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
        const response = await this.post(`/sessions/${session}/capture`, { url, viewport })
        return this.handleResponse(response, 'Capture') as Promise<Graph>
    }

    async snapshot(
        session: string,
        url?: string,
        viewport?: { width: number; height: number }
    ): Promise<Snapshot> {
        const response = await this.post(`/sessions/${session}/snapshot`, { url, viewport })
        return this.handleResponse(response, 'Snapshot') as Promise<Snapshot>
    }

    async inspect(session: string, elementId: string): Promise<ElementNode | null> {
        const response = await this.post(`/sessions/${session}/inspect`, { elementId })
        return this.handleResponse(response, 'Inspect') as Promise<ElementNode | null>
    }

    async click(session: string, elementId: string): Promise<{ clicked: boolean }> {
        const response = await this.post(`/sessions/${session}/click`, { elementId })
        return this.handleResponse(response, 'Click') as Promise<{ clicked: boolean }>
    }

    async fill(session: string, elementId: string, text: string): Promise<{ filled: boolean }> {
        const response = await this.post(`/sessions/${session}/fill`, { elementId, text })
        return this.handleResponse(response, 'Fill') as Promise<{ filled: boolean }>
    }

    async type(session: string, elementId: string, text: string): Promise<{ typed: boolean }> {
        const response = await this.post(`/sessions/${session}/type`, { elementId, text })
        return this.handleResponse(response, 'Type') as Promise<{ typed: boolean }>
    }

    async hover(session: string, elementId: string): Promise<{ hovered: boolean }> {
        const response = await this.post(`/sessions/${session}/hover`, { elementId })
        return this.handleResponse(response, 'Hover') as Promise<{ hovered: boolean }>
    }

    async focus(session: string, elementId: string): Promise<{ focused: boolean }> {
        const response = await this.post(`/sessions/${session}/focus`, { elementId })
        return this.handleResponse(response, 'Focus') as Promise<{ focused: boolean }>
    }

    async press(session: string, key: string): Promise<{ pressed: boolean }> {
        const response = await this.post(`/sessions/${session}/press`, { key })
        return this.handleResponse(response, 'Press') as Promise<{ pressed: boolean }>
    }

    async scroll(
        session: string,
        direction: 'up' | 'down' | 'left' | 'right',
        px: number,
        elementId?: string
    ): Promise<{ scrolled: boolean }> {
        const response = await this.post(`/sessions/${session}/scroll`, { direction, px, elementId })
        return this.handleResponse(response, 'Scroll') as Promise<{ scrolled: boolean }>
    }

    async scrollIntoView(session: string, elementId: string): Promise<{ scrolledIntoView: boolean }> {
        const response = await this.post(`/sessions/${session}/scrollintoview`, { elementId })
        return this.handleResponse(response, 'ScrollIntoView') as Promise<{ scrolledIntoView: boolean }>
    }

    async wait(session: string, condition: WaitCondition): Promise<{ waited: boolean }> {
        const response = await this.post(`/sessions/${session}/wait`, condition)
        return this.handleResponse(response, 'Wait') as Promise<{ waited: boolean }>
    }

    async eval(session: string, script: string): Promise<{ result: unknown }> {
        const response = await this.post(`/sessions/${session}/eval`, { script })
        return this.handleResponse(response, 'Eval') as Promise<{ result: unknown }>
    }

    async batch(session: string, commands: unknown[]): Promise<{ results: unknown[] }> {
        const response = await this.post(`/sessions/${session}/batch`, { commands })
        return this.handleResponse(response, 'Batch') as Promise<{ results: unknown[] }>
    }

    async networkRequests(session: string): Promise<{ requests: unknown[] }> {
        const response = await this.post(`/sessions/${session}/network/requests`, {})
        return this.handleResponse(response, 'NetworkRequests') as Promise<{ requests: unknown[] }>
    }

    async startNetworkTracking(session: string): Promise<{ tracking: boolean }> {
        const response = await this.post(`/sessions/${session}/network/track/start`, {})
        return this.handleResponse(response, 'StartNetworkTracking') as Promise<{ tracking: boolean }>
    }

    async stopNetworkTracking(session: string): Promise<{ tracking: boolean }> {
        const response = await this.post(`/sessions/${session}/network/track/stop`, {})
        return this.handleResponse(response, 'StopNetworkTracking') as Promise<{ tracking: boolean }>
    }

    async startHar(session: string, path?: string): Promise<{ path: string }> {
        const response = await this.post(`/sessions/${session}/network/har/start`, { path })
        return this.handleResponse(response, 'StartHar') as Promise<{ path: string }>
    }

    async stopHar(session: string, path?: string): Promise<{ path: string }> {
        const response = await this.post(`/sessions/${session}/network/har/stop`, { path })
        return this.handleResponse(response, 'StopHar') as Promise<{ path: string }>
    }

    async route(session: string, route: NetworkRoute): Promise<{ routed: boolean }> {
        const response = await this.post(`/sessions/${session}/network/route`, route)
        return this.handleResponse(response, 'Route') as Promise<{ routed: boolean }>
    }

    async unroute(session: string, url?: string): Promise<{ unrouted: boolean }> {
        const response = await this.post(`/sessions/${session}/network/unroute`, { url })
        return this.handleResponse(response, 'Unroute') as Promise<{ unrouted: boolean }>
    }

    async cookies(session: string): Promise<{ cookies: Cookie[] }> {
        const response = await this.get(`/sessions/${session}/cookies`)
        return this.handleResponse(response, 'Cookies') as Promise<{ cookies: Cookie[] }>
    }

    async setCookie(
        session: string,
        name: string,
        value: string,
        domain?: string,
        path?: string
    ): Promise<{ set: boolean }> {
        const response = await this.post(`/sessions/${session}/cookies/set`, { name, value, domain, path })
        return this.handleResponse(response, 'SetCookie') as Promise<{ set: boolean }>
    }

    async clearCookies(session: string): Promise<{ cleared: boolean }> {
        const response = await this.post(`/sessions/${session}/cookies/clear`, {})
        return this.handleResponse(response, 'ClearCookies') as Promise<{ cleared: boolean }>
    }

    async getLocalStorage(session: string): Promise<{ data: Record<string, string> }> {
        const response = await this.get(`/sessions/${session}/storage/local`)
        return this.handleResponse(response, 'GetLocalStorage') as Promise<{ data: Record<string, string> }>
    }

    async setLocalStorage(session: string, key: string, value: string): Promise<{ set: boolean }> {
        const response = await this.post(`/sessions/${session}/storage/local/set`, { key, value })
        return this.handleResponse(response, 'SetLocalStorage') as Promise<{ set: boolean }>
    }

    async clearLocalStorage(session: string): Promise<{ cleared: boolean }> {
        const response = await this.post(`/sessions/${session}/storage/local/clear`, {})
        return this.handleResponse(response, 'ClearLocalStorage') as Promise<{ cleared: boolean }>
    }

    async getSessionStorage(session: string): Promise<{ data: Record<string, string> }> {
        const response = await this.get(`/sessions/${session}/storage/session`)
        return this.handleResponse(response, 'GetSessionStorage') as Promise<{ data: Record<string, string> }>
    }

    async setSessionStorage(session: string, key: string, value: string): Promise<{ set: boolean }> {
        const response = await this.post(`/sessions/${session}/storage/session/set`, { key, value })
        return this.handleResponse(response, 'SetSessionStorage') as Promise<{ set: boolean }>
    }

    async clearSessionStorage(session: string): Promise<{ cleared: boolean }> {
        const response = await this.post(`/sessions/${session}/storage/session/clear`, {})
        return this.handleResponse(response, 'ClearSessionStorage') as Promise<{ cleared: boolean }>
    }

    async status(session: string): Promise<{ url?: string; elementCount: number }> {
        const response = await this.get(`/sessions/${session}`)
        return this.handleResponse(response, 'Status') as Promise<{ url?: string; elementCount: number }>
    }

    async newTab(session: string, url?: string): Promise<{ tabCreated: boolean }> {
        const response = await this.post(`/sessions/${session}/tabs/new`, { url })
        return this.handleResponse(response, 'NewTab') as Promise<{ tabCreated: boolean }>
    }

    async switchTab(session: string, index: number): Promise<{ switched: boolean }> {
        const response = await this.post(`/sessions/${session}/tabs/switch`, { index })
        return this.handleResponse(response, 'SwitchTab') as Promise<{ switched: boolean }>
    }

    async closeTab(session: string, index?: number): Promise<{ closed: boolean }> {
        const response = await this.post(`/sessions/${session}/tabs/close`, { index })
        return this.handleResponse(response, 'CloseTab') as Promise<{ closed: boolean }>
    }

    async listTabs(session: string): Promise<{ tabs: Array<{ index: number; url: string; title: string }> }> {
        const response = await this.get(`/sessions/${session}/tabs`)
        return this.handleResponse(response, 'ListTabs') as Promise<{ tabs: Array<{ index: number; url: string; title: string }> }>
    }

    async switchFrame(session: string, selector: string): Promise<{ switched: boolean }> {
        const response = await this.post(`/sessions/${session}/frames/switch`, { selector })
        return this.handleResponse(response, 'SwitchFrame') as Promise<{ switched: boolean }>
    }

    async switchFrameMain(session: string): Promise<{ switched: boolean }> {
        const response = await this.post(`/sessions/${session}/frames/main`, {})
        return this.handleResponse(response, 'SwitchFrameMain') as Promise<{ switched: boolean }>
    }

    async listFrames(session: string): Promise<{ frames: Array<{ name: string; url: string }> }> {
        const response = await this.get(`/sessions/${session}/frames`)
        return this.handleResponse(response, 'ListFrames') as Promise<{ frames: Array<{ name: string; url: string }> }>
    }

    async screenshotPage(session: string, path?: string): Promise<{ path: string }> {
        const response = await this.post(`/sessions/${session}/screenshot/page`, { path })
        return this.handleResponse(response, 'ScreenshotPage') as Promise<{ path: string }>
    }

    async screenshotElement(session: string, elementId: string, path?: string): Promise<{ path: string }> {
        const response = await this.post(`/sessions/${session}/screenshot/element`, { elementId, path })
        return this.handleResponse(response, 'ScreenshotElement') as Promise<{ path: string }>
    }

    async read(session: string, format: 'text' | 'markdown' = 'text'): Promise<{ content: string }> {
        const response = await this.post(`/sessions/${session}/read`, { format })
        return this.handleResponse(response, 'Read') as Promise<{ content: string }>
    }

    async close(session: string): Promise<void> {
        const response = await fetch(`${this.baseUrl}/sessions/${session}`, { method: 'DELETE' })
        await this.handleResponse(response, 'Close')
    }
}

export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
    return new DaemonClient(options)
}
