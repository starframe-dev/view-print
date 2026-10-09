import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server'
import type { JSONRPCMessage } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSession } from '../src/browser.js'
import { createMcpServer } from '../src/mcp.js'
import type { Graph } from '../src/types.js'

const servers: Array<ReturnType<typeof createMcpServer>> = []
const transports: InMemoryTransport[] = []

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
    await Promise.all(transports.splice(0).map((transport) => transport.close()))
})

describe('MCP SDK server', () => {
    it('registers tools and serves capture through the official MCP transport', async () => {
        const graph: Graph = {
            url: 'https://example.test/',
            viewport: { width: 1280, height: 720 },
            tree: []
        }
        const capture = vi.fn().mockResolvedValue(graph)
        const session = { capture } as unknown as BrowserSession
        const server = createMcpServer(session)
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        servers.push(server)
        transports.push(clientTransport)
        await clientTransport.start()
        await server.connect(serverTransport)

        let nextId = 1
        const pending = new Map<number, (message: JSONRPCMessage) => void>()
        clientTransport.onmessage = (message) => {
            if (typeof message === 'object' && message !== null && 'id' in message && typeof message.id === 'number') {
                pending.get(message.id)?.(message)
            }
        }
        const request = async (method: string, params: Record<string, unknown>): Promise<JSONRPCMessage> => {
            const id = nextId++
            const responsePromise = new Promise<JSONRPCMessage>((resolve, reject) => {
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
            return responsePromise
        }

        const initialized = await request('initialize', {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'view-print-test', version: '1.0.0' }
        })
        expect(initialized).toHaveProperty('result')
        await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

        const toolsResponse = await request('tools/list', {})
        expect('result' in toolsResponse).toBe(true)
        if (!('result' in toolsResponse) || typeof toolsResponse.result !== 'object' || toolsResponse.result === null) {
            throw new Error('MCP tools/list returned an invalid result.')
        }
        const tools = (toolsResponse.result as { tools: Array<{ name: string }> }).tools
        expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
            'capture', 'snapshot', 'click', 'fill', 'inspect', 'eval', 'read', 'status',
            'diff_last', 'frames_list', 'frame_switch', 'frame_main', 'set_dialog_handler'
        ]))

        const captureResponse = await request('tools/call', {
            name: 'capture',
            arguments: { url: graph.url, viewport: { width: 1280, height: 720 } }
        })
        expect(capture).toHaveBeenCalledWith(
            graph.url,
            { width: 1280, height: 720 },
            undefined,
            new Set(),
            undefined
        )
        expect(captureResponse).toHaveProperty('result')
    })
})
