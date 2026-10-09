import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { BrowserSession } from './browser.js'
import { diffGraphs } from './diff.js'
import { getPackageVersion } from './version.js'

function normalizeRef(elementId: string): string {
    return elementId.startsWith('@') ? elementId.slice(1) : elementId
}

async function executeTool(handler: () => Promise<unknown>): Promise<CallToolResult> {
    try {
        const value = await handler()
        const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'
        return { content: [{ type: 'text', text }] }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return { content: [{ type: 'text', text: message }], isError: true }
    }
}

export function createMcpServer(session: BrowserSession): McpServer {
    const server = new McpServer({ name: 'view-print', version: getPackageVersion() })
    const viewportSchema = z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive()
    }).strict()
    const captureSchema = z.object({
        url: z.string().optional(),
        viewport: viewportSchema.optional(),
        depth: z.number().int().min(1).optional(),
        expand: z.array(z.string()).optional(),
        query: z.string().optional()
    }).strict()

    server.registerTool('capture', {
        description: 'Navigate to a URL and capture the layout graph as a tree',
        inputSchema: captureSchema
    }, async (args) => executeTool(() => session.capture(
        args.url,
        args.viewport,
        args.depth,
        new Set(args.expand),
        args.query
    )))

    server.registerTool('snapshot', {
        description: 'Capture the semantic DOM snapshot tree',
        inputSchema: captureSchema
    }, async (args) => executeTool(() => session.snapshot(
        args.url,
        args.viewport,
        args.depth,
        new Set(args.expand),
        args.query
    )))

    server.registerTool('click', {
        description: 'Click an element by ref (e.g. @e2) or elementId',
        inputSchema: z.object({ elementId: z.string() }).strict()
    }, async ({ elementId }) => executeTool(() => session.click(normalizeRef(elementId))))

    server.registerTool('fill', {
        description: 'Fill an input element',
        inputSchema: z.object({ elementId: z.string(), text: z.string() }).strict()
    }, async ({ elementId, text }) => executeTool(() => session.fill(normalizeRef(elementId), text)))

    server.registerTool('inspect', {
        description: 'Inspect full details of an element',
        inputSchema: z.object({ elementId: z.string() }).strict()
    }, async ({ elementId }) => executeTool(() => session.inspect(normalizeRef(elementId))))

    server.registerTool('eval', {
        description: 'Evaluate a JavaScript expression in the active page',
        inputSchema: z.object({ script: z.string() }).strict()
    }, async ({ script }) => executeTool(() => session.eval(script)))

    server.registerTool('read', {
        description: 'Extract readable text or markdown',
        inputSchema: z.object({ format: z.enum(['text', 'markdown']).optional() }).strict()
    }, async ({ format }) => executeTool(() => session.read(format ?? 'text')))

    server.registerTool('status', {
        description: 'Show session status',
        inputSchema: z.object({}).strict()
    }, async () => executeTool(() => session.status()))

    server.registerTool('diff_last', {
        description: 'Compare the latest captured graph with the current page',
        inputSchema: z.object({}).strict()
    }, async () => executeTool(async () => {
        const previousGraph = session.getLastGraph()
        const currentGraph = await session.capture()
        return previousGraph ? diffGraphs(previousGraph, currentGraph) : null
    }))

    server.registerTool('frames_list', {
        description: 'List frames in the active tab',
        inputSchema: z.object({}).strict()
    }, async () => executeTool(() => session.listFrames()))

    server.registerTool('frame_switch', {
        description: 'Switch the capture target to a frame selected by CSS selector',
        inputSchema: z.object({ selector: z.string().min(1) }).strict()
    }, async ({ selector }) => executeTool(() => session.switchFrame(selector)))

    server.registerTool('frame_main', {
        description: 'Switch the capture target back to the main frame',
        inputSchema: z.object({}).strict()
    }, async () => executeTool(() => session.switchFrameMain()))

    server.registerTool('set_dialog_handler', {
        description: 'Configure how JavaScript dialogs are handled',
        inputSchema: z.object({
            accept: z.boolean(),
            promptText: z.string().optional()
        }).strict()
    }, async (handler) => executeTool(() => session.setDialogHandler(async () => handler)))

    return server
}

export async function runMcpServer(): Promise<void> {
    const session = new BrowserSession('mcp')
    let server: McpServer | null = null
    let connected = false
    const inputClosed = new Promise<void>((resolve) => {
        if (process.stdin.readableEnded) {
            resolve()
            return
        }
        process.stdin.once('end', resolve)
    })

    try {
        await session.start()
        server = createMcpServer(session)
        await server.connect(new StdioServerTransport())
        connected = true
        await inputClosed
    } finally {
        if (connected && server) {
            await server.close().catch(() => undefined)
        }
        await session.close()
    }
}
