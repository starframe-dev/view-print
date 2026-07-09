import http from 'node:http'
import { URL } from 'node:url'
import { BrowserSession } from './browser.js'

export interface DaemonOptions {
    port: number
}

export class ViewPrintDaemon {
    private server: http.Server | null = null
    private sessions = new Map<string, BrowserSession>()
    private port: number

    constructor(options: DaemonOptions) {
        this.port = options.port
    }

    async start(): Promise<void> {
        this.server = http.createServer((req, res) => this.handleRequest(req, res))

        return new Promise((resolve, reject) => {
            this.server?.listen(this.port, () => {
                console.error(`viewprint daemon listening on port ${this.port}`)
                resolve()
            })

            this.server?.on('error', reject)
        })
    }

    async stop(): Promise<void> {
        for (const session of this.sessions.values()) {
            await session.close()
        }
        this.sessions.clear()

        if (this.server) {
            return new Promise((resolve) => {
                this.server?.close(() => resolve())
            })
        }
    }

    getPort(): number {
        if (this.port === 0) {
            const address = this.server?.address()
            if (address && typeof address !== 'string') {
                return address.port
            }
        }
        return this.port
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url || '/', `http://localhost:${this.port}`)
        const pathParts = url.pathname.split('/').filter(Boolean)

        try {
            if (req.method === 'GET' && url.pathname === '/health') {
                this.sendJson(res, 200, { ok: true })
                return
            }

            if (req.method === 'POST' && url.pathname === '/shutdown') {
                this.sendJson(res, 200, { shuttingDown: true })
                await this.stop()
                return
            }

            if (pathParts[0] !== 'sessions' || pathParts.length < 2) {
                this.sendJson(res, 404, { error: 'Not found' })
                return
            }

            const sessionName = pathParts[1]
            const action = pathParts[2]

            if (req.method === 'POST' && action === 'capture') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const graph = await session.capture(body.url, body.viewport)
                this.sendJson(res, 200, graph)
                return
            }

            if (req.method === 'POST' && action === 'inspect') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                const element = await session.inspect(body.elementId)
                this.sendJson(res, 200, element)
                return
            }

            if (req.method === 'POST' && action === 'click') {
                const body = await this.readJson(req)
                const session = await this.getOrCreateSession(sessionName)
                await session.click(body.elementId)
                this.sendJson(res, 200, { clicked: true })
                return
            }

            if (req.method === 'GET' && action === undefined) {
                const session = this.sessions.get(sessionName)
                if (!session) {
                    this.sendJson(res, 404, { error: 'Session not found' })
                    return
                }
                const status = await session.status()
                this.sendJson(res, 200, status)
                return
            }

            if (req.method === 'DELETE' && action === undefined) {
                const session = this.sessions.get(sessionName)
                if (session) {
                    await session.close()
                    this.sessions.delete(sessionName)
                }
                this.sendJson(res, 200, { closed: true })
                return
            }

            this.sendJson(res, 404, { error: 'Not found' })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            this.sendJson(res, 500, { error: message })
        }
    }

    private async getOrCreateSession(name: string): Promise<BrowserSession> {
        const existing = this.sessions.get(name)
        if (existing) {
            return existing
        }

        const session = new BrowserSession(name)
        await session.start()
        this.sessions.set(name, session)
        return session
    }

    private readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
        return new Promise((resolve, reject) => {
            let body = ''
            req.on('data', (chunk) => { body += chunk })
            req.on('end', () => {
                try {
                    resolve(body ? JSON.parse(body) : {})
                } catch (error) {
                    reject(new Error('Invalid JSON'))
                }
            })
            req.on('error', reject)
        })
    }

    private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
    }
}

export async function startDaemon(options: DaemonOptions): Promise<ViewPrintDaemon> {
    const daemon = new ViewPrintDaemon(options)
    await daemon.start()
    return daemon
}
