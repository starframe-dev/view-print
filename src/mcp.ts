import readline from 'node:readline'
import { BrowserSession } from './browser.js'

interface McpRequest {
    jsonrpc: '2.0'
    id: number | string
    method: string
    params?: Record<string, unknown>
}

interface McpResponse {
    jsonrpc: '2.0'
    id: number | string | null
    result?: unknown
    error?: { code: number; message: string; data?: unknown }
}

const TOOLS = [
    {
        name: 'capture',
        description: 'Navigate to a URL and capture the layout graph',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to navigate to' },
                viewport: {
                    type: 'object',
                    properties: {
                        width: { type: 'number' },
                        height: { type: 'number' }
                    }
                }
            }
        }
    },
    {
        name: 'snapshot',
        description: 'Capture the accessibility snapshot tree',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                viewport: {
                    type: 'object',
                    properties: { width: { type: 'number' }, height: { type: 'number' } }
                }
            }
        }
    },
    {
        name: 'click',
        description: 'Click an element by ref (e.g. @e2) or elementId',
        inputSchema: {
            type: 'object',
            properties: { elementId: { type: 'string' } },
            required: ['elementId']
        }
    },
    {
        name: 'fill',
        description: 'Fill an input element',
        inputSchema: {
            type: 'object',
            properties: {
                elementId: { type: 'string' },
                text: { type: 'string' }
            },
            required: ['elementId', 'text']
        }
    },
    {
        name: 'inspect',
        description: 'Inspect full details of an element',
        inputSchema: {
            type: 'object',
            properties: { elementId: { type: 'string' } },
            required: ['elementId']
        }
    },
    {
        name: 'eval',
        description: 'Evaluate a JavaScript expression',
        inputSchema: {
            type: 'object',
            properties: { script: { type: 'string' } },
            required: ['script']
        }
    },
    {
        name: 'read',
        description: 'Extract readable text or markdown',
        inputSchema: {
            type: 'object',
            properties: {
                format: { type: 'string', enum: ['text', 'markdown'] }
            }
        }
    },
    {
        name: 'status',
        description: 'Show session status',
        inputSchema: { type: 'object', properties: {} }
    }
]

function normalizeRef(elementId: string): string {
    return elementId.startsWith('@') ? elementId.slice(1) : elementId
}

export async function runMcpServer(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin })

    const session = new BrowserSession('mcp')
    await session.start()

    async function handleRequest(request: McpRequest): Promise<McpResponse> {
        const { id, method, params } = request

        try {
            if (method === 'initialize') {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'view-print', version: '0.1.0' }
                    }
                }
            }

            if (method === 'tools/list') {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: { tools: TOOLS }
                }
            }

            if (method === 'tools/call') {
                const toolName = (params?.name as string) ?? ''
                const args = (params?.arguments as Record<string, unknown>) ?? {}

                switch (toolName) {
                    case 'capture': {
                        const graph = await session.capture(args.url as string | undefined, args.viewport as { width: number; height: number } | undefined)
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(graph) }] } }
                    }
                    case 'snapshot': {
                        const snapshot = await session.snapshot(args.url as string | undefined, args.viewport as { width: number; height: number } | undefined)
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } }
                    }
                    case 'click': {
                        await session.click(normalizeRef(args.elementId as string))
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ clicked: true }) }] } }
                    }
                    case 'fill': {
                        await session.fill(normalizeRef(args.elementId as string), args.text as string)
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ filled: true }) }] } }
                    }
                    case 'inspect': {
                        const element = await session.inspect(normalizeRef(args.elementId as string))
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(element) }] } }
                    }
                    case 'eval': {
                        const result = await session.eval(args.script as string)
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }
                    }
                    case 'read': {
                        const content = await session.read((args.format as 'text' | 'markdown') ?? 'text')
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: content }] } }
                    }
                    case 'status': {
                        const status = await session.status()
                        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(status) }] } }
                    }
                    default:
                        return {
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32602, message: `Unknown tool: ${toolName}` }
                        }
                }
            }

            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `Method not found: ${method}` }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            return {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message }
            }
        }
    }

    for await (const line of rl) {
        if (!line.trim()) continue
        try {
            const request = JSON.parse(line) as McpRequest
            const response = await handleRequest(request)
            process.stdout.write(JSON.stringify(response) + '\n')
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Parse error'
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message }
            }) + '\n')
        }
    }

    await session.close()
}