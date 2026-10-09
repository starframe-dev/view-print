import { InMemoryTransport } from '@modelcontextprotocol/server'
import type { JSONRPCMessage } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserSession } from '../src/browser.js'
import { createMcpServer } from '../src/mcp.js'

const handles: Array<{ close(): Promise<void> }> = []
const transports: InMemoryTransport[] = []

afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
    await Promise.all(transports.splice(0).map((transport) => transport.close()))
})

function connect() {
    const session = { status: async () => ({ ok: true }) } as unknown as BrowserSession
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    handles.push(serveStdio(() => createMcpServer(session), { transport: serverTransport }))
    transports.push(clientTransport)

    let nextId = 1
    const pending = new Map<number, (message: JSONRPCMessage) => void>()
    clientTransport.onmessage = (message) => {
        if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
            pending.get(message.id)?.(message)
        }
    }

    const request = async (method: string, params: Record<string, unknown>): Promise<JSONRPCMessage> => {
        const id = nextId++
        const response = new Promise<JSONRPCMessage>((resolve, reject) => {
            const timeout = setTimeout(() => {
                pending.delete(id)
                reject(new Error(`Timed out waiting for MCP response to ${method}.`))
            }, 2_000)
            pending.set(id, (message) => {
                clearTimeout(timeout)
                pending.delete(id)
                resolve(message)
            })
        })
        await clientTransport.send({ jsonrpc: '2.0', id, method, params })
        return response
    }

    return { clientTransport, request }
}

describe('MCP serveStdio entry', () => {
    it('serves the 2025 handshake and lists view-print tools', async () => {
        const { clientTransport, request } = connect()
        await clientTransport.start()

        const initialized = await request('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'view-print-test', version: '1.0.0' }
        })
        expect(initialized).toHaveProperty('result')

        const tools = await request('tools/list', {})
        expect('result' in tools && JSON.stringify(tools.result)).toContain('"capture"')
    })

    it('answers the 2026-07-28 server/discover probe', async () => {
        const { clientTransport, request } = connect()
        await clientTransport.start()

        const discovered = await request('server/discover', {
            _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'view-print-test', version: '1.0.0' },
                'io.modelcontextprotocol/clientCapabilities': {}
            }
        })
        expect(JSON.stringify(discovered)).toContain('2026-07-28')
    })
})
