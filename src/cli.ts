#!/usr/bin/env node
import { Command } from 'commander'
import { createDaemonClient } from './daemon-client.js'
import {
    ensureDaemonRunning,
    getDaemonPort,
    getIdleTimeoutFromEnv,
    isDaemonRunning,
    startDaemonProcess,
    stopDaemonProcess
} from './daemon-process.js'
import { runMcpServer } from './mcp.js'
import type { WaitCondition } from './browser.js'
import type { NetworkRoute } from './types.js'

const program = new Command()

program
    .name('viewprint')
    .description('AI tool for extracting precise layout graphs from web pages')
    .version('0.1.0')
    .option('-s, --session <name>', 'Session name')

function getSessionName(): string {
    const name = program.opts().session
    if (!name) {
        throw new Error('Session name is required. Use -s <name>')
    }
    return name as string
}

function getPort(): number {
    return getDaemonPort()
}

async function getClient(): Promise<ReturnType<typeof createDaemonClient>> {
    const port = getPort()
    await ensureDaemonRunning(port)
    return createDaemonClient({ port })
}

function parseViewport(value: string): { width: number; height: number } {
    const match = value.match(/^(\d+)x(\d+)$/)
    if (!match) {
        throw new Error('Invalid viewport format. Use WIDTHxHEIGHT, e.g. 1920x1080')
    }
    return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) }
}

function normalizeRef(elementId: string): string {
    return elementId.startsWith('@') ? elementId.slice(1) : elementId
}

program
    .command('capture [url]')
    .description('Capture lightweight layout graph. Uses current session URL if not provided.')
    .option('--viewport <size>', 'Viewport size WIDTHxHEIGHT', '1280x720')
    .action(async (url: string | undefined, options: { viewport: string }) => {
        const viewport = parseViewport(options.viewport)
        const client = await getClient()
        const graph = await client.capture(getSessionName(), url, viewport)
        console.log(JSON.stringify(graph, null, 2))
    })

program
    .command('snapshot [url]')
    .description('Capture accessibility tree with refs. Uses current session URL if not provided.')
    .option('--viewport <size>', 'Viewport size WIDTHxHEIGHT', '1280x720')
    .action(async (url: string | undefined, options: { viewport: string }) => {
        const viewport = parseViewport(options.viewport)
        const client = await getClient()
        const snapshot = await client.snapshot(getSessionName(), url, viewport)
        console.log(JSON.stringify(snapshot, null, 2))
    })

program
    .command('inspect <elementId>')
    .description('Inspect full details of an element by viewprint ID')
    .action(async (elementId: string) => {
        const client = await getClient()
        const element = await client.inspect(getSessionName(), normalizeRef(elementId))
        console.log(JSON.stringify(element, null, 2))
    })

program
    .command('click <elementId>')
    .description('Click element by viewprint ID')
    .action(async (elementId: string) => {
        const client = await getClient()
        const result = await client.click(getSessionName(), normalizeRef(elementId))
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('fill <elementId> <text>')
    .description('Clear and fill input element')
    .action(async (elementId: string, text: string) => {
        const client = await getClient()
        const result = await client.fill(getSessionName(), normalizeRef(elementId), text)
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('type <elementId> <text>')
    .description('Type text into element')
    .action(async (elementId: string, text: string) => {
        const client = await getClient()
        const result = await client.type(getSessionName(), normalizeRef(elementId), text)
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('hover <elementId>')
    .description('Hover element by viewprint ID')
    .action(async (elementId: string) => {
        const client = await getClient()
        const result = await client.hover(getSessionName(), normalizeRef(elementId))
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('focus <elementId>')
    .description('Focus element by viewprint ID')
    .action(async (elementId: string) => {
        const client = await getClient()
        const result = await client.focus(getSessionName(), normalizeRef(elementId))
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('press <key>')
    .description('Press key (Enter, Tab, Control+a, etc.)')
    .action(async (key: string) => {
        const client = await getClient()
        const result = await client.press(getSessionName(), key)
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('scroll <direction> [px]')
    .description('Scroll window or element (up/down/left/right)')
    .option('--elementId <id>', 'Scroll specific element by ref')
    .action(async (direction: string, px: string | undefined, options: { elementId?: string }) => {
        const validDirections = ['up', 'down', 'left', 'right']
        if (!validDirections.includes(direction)) {
            throw new Error(`Invalid direction: ${direction}. Use up, down, left, or right.`)
        }
        const amount = px ? parseInt(px, 10) : 300
        const client = await getClient()
        const result = await client.scroll(
            getSessionName(),
            direction as 'up' | 'down' | 'left' | 'right',
            amount,
            options.elementId ? normalizeRef(options.elementId) : undefined
        )
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('scrollintoview <elementId>')
    .description('Scroll element into view')
    .action(async (elementId: string) => {
        const client = await getClient()
        const result = await client.scrollIntoView(getSessionName(), normalizeRef(elementId))
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('wait')
    .description('Wait for condition')
    .option('--selector <sel>', 'Wait for selector to be visible')
    .option('--text <text>', 'Wait for text to appear in body')
    .option('--timeout <ms>', 'Wait for timeout in milliseconds')
    .option('--load-state <state>', 'Wait for load state (load/domcontentloaded/networkidle)')
    .option('--fn <expr>', 'Wait for JS function to return true')
    .action(async (options: {
        selector?: string
        text?: string
        timeout?: string
        loadState?: string
        fn?: string
    }) => {
        const condition: WaitCondition = {}
        if (options.selector) condition.selector = options.selector
        if (options.text) condition.text = options.text
        if (options.timeout) condition.timeout = parseInt(options.timeout, 10)
        if (options.loadState) condition.loadState = options.loadState as 'load' | 'domcontentloaded' | 'networkidle'
        if (options.fn) condition.fn = options.fn

        if (Object.keys(condition).length === 0) {
            throw new Error('Provide at least one wait condition')
        }

        const client = await getClient()
        const result = await client.wait(getSessionName(), condition)
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('eval <script>')
    .description('Evaluate JavaScript in the active page')
    .action(async (script: string) => {
        const client = await getClient()
        const result = await client.eval(getSessionName(), script)
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('batch [commands...]')
    .description('Execute multiple commands in one call. Use --json to read from stdin.')
    .option('--json', 'Read commands as JSON from stdin')
    .action(async (commands: string[], options: { json?: boolean }) => {
        const client = await getClient()

        let parsedCommands: unknown[]
        if (options.json) {
            const stdin = process.stdin
            stdin.setEncoding('utf8')
            let input = ''
            for await (const chunk of stdin) {
                input += chunk
            }
            parsedCommands = JSON.parse(input)
        } else {
            parsedCommands = commands.map((cmd) => {
                const parts = cmd.match(/"[^"]+"|\\S+/g) || []
                return parts.map((part) => {
                    if (part.startsWith('"') && part.endsWith('"')) {
                        return part.slice(1, -1)
                    }
                    try {
                        return JSON.parse(part)
                    } catch {
                        return part
                    }
                })
            })
        }

        const result = await client.batch(getSessionName(), parsedCommands)
        console.log(JSON.stringify(result, null, 2))
    })

const network = program
    .command('network')
    .description('Network interception and tracking')

network
    .command('requests')
    .description('List tracked network requests')
    .action(async () => {
        const client = await getClient()
        const result = await client.networkRequests(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

const networkTrack = network
    .command('track')
    .description('Start/stop network tracking')

networkTrack
    .command('start')
    .description('Start tracking network requests')
    .action(async () => {
        const client = await getClient()
        const result = await client.startNetworkTracking(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

networkTrack
    .command('stop')
    .description('Stop tracking network requests')
    .action(async () => {
        const client = await getClient()
        const result = await client.stopNetworkTracking(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

const networkHar = network
    .command('har')
    .description('HAR recording')

networkHar
    .command('start [path]')
    .description('Start HAR recording')
    .action(async (path: string | undefined) => {
        const client = await getClient()
        const result = await client.startHar(getSessionName(), path)
        console.log(JSON.stringify(result, null, 2))
    })

networkHar
    .command('stop [path]')
    .description('Stop HAR recording and save to file')
    .action(async (path: string | undefined) => {
        const client = await getClient()
        const result = await client.stopHar(getSessionName(), path)
        console.log(JSON.stringify(result, null, 2))
    })

network
    .command('route <url>')
    .description('Intercept and modify requests')
    .option('--abort', 'Abort matched requests')
    .option('--body <json>', 'Mock response body')
    .option('--status <n>', 'Mock response status', '200')
    .option('--content-type <type>', 'Mock response content type', 'application/json')
    .action(async (url: string, options: { abort?: boolean; body?: string; status: string; contentType: string }) => {
        const route: NetworkRoute = { url }
        if (options.abort) {
            route.abort = true
        } else if (options.body) {
            route.body = options.body
            route.status = parseInt(options.status, 10)
            route.contentType = options.contentType
        }
        const client = await getClient()
        const result = await client.route(getSessionName(), route)
        console.log(JSON.stringify(result, null, 2))
    })

network
    .command('unroute [url]')
    .description('Remove network route')
    .action(async (url: string | undefined) => {
        const client = await getClient()
        const result = await client.unroute(getSessionName(), url)
        console.log(JSON.stringify(result, null, 2))
    })

const cookies = program
    .command('cookies')
    .description('Cookie management')

cookies
    .command('get')
    .description('Get all cookies')
    .action(async () => {
        const client = await getClient()
        const result = await client.cookies(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

cookies
    .command('set <name> <value>')
    .description('Set cookie')
    .option('--domain <domain>', 'Cookie domain')
    .option('--path <path>', 'Cookie path', '/')
    .action(async (name: string, value: string, options: { domain?: string; path: string }) => {
        const client = await getClient()
        const result = await client.setCookie(getSessionName(), name, value, options.domain, options.path)
        console.log(JSON.stringify(result, null, 2))
    })

cookies
    .command('clear')
    .description('Clear all cookies')
    .action(async () => {
        const client = await getClient()
        const result = await client.clearCookies(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

const storage = program
    .command('storage')
    .description('Local and session storage management')

const storageLocal = storage
    .command('local')
    .description('Local storage')

storageLocal
    .command('get')
    .description('Get all localStorage entries')
    .action(async () => {
        const client = await getClient()
        const result = await client.getLocalStorage(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

storageLocal
    .command('set <key> <value>')
    .description('Set localStorage entry')
    .action(async (key: string, value: string) => {
        const client = await getClient()
        const result = await client.setLocalStorage(getSessionName(), key, value)
        console.log(JSON.stringify(result, null, 2))
    })

storageLocal
    .command('clear')
    .description('Clear localStorage')
    .action(async () => {
        const client = await getClient()
        const result = await client.clearLocalStorage(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

const storageSession = storage
    .command('session')
    .description('Session storage')

storageSession
    .command('get')
    .description('Get all sessionStorage entries')
    .action(async () => {
        const client = await getClient()
        const result = await client.getSessionStorage(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

storageSession
    .command('set <key> <value>')
    .description('Set sessionStorage entry')
    .action(async (key: string, value: string) => {
        const client = await getClient()
        const result = await client.setSessionStorage(getSessionName(), key, value)
        console.log(JSON.stringify(result, null, 2))
    })

storageSession
    .command('clear')
    .description('Clear sessionStorage')
    .action(async () => {
        const client = await getClient()
        const result = await client.clearSessionStorage(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

const tabs = program
    .command('tabs')
    .description('Browser tab management')

tabs
    .command('list')
    .description('List all browser tabs')
    .action(async () => {
        const client = await getClient()
        const result = await client.listTabs(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

tabs
    .command('new [url]')
    .description('Open a new browser tab (optionally navigating to URL)')
    .action(async (url?: string) => {
        const client = await getClient()
        const result = await client.newTab(getSessionName(), url)
        console.log(JSON.stringify(result, null, 2))
    })

tabs
    .command('switch <index>')
    .description('Switch to tab by index')
    .action(async (index: string) => {
        const client = await getClient()
        const result = await client.switchTab(getSessionName(), parseInt(index, 10))
        console.log(JSON.stringify(result, null, 2))
    })

tabs
    .command('close [index]')
    .description('Close tab by index (or last tab)')
    .action(async (index?: string) => {
        const client = await getClient()
        const idx = index ? parseInt(index, 10) : undefined
        const result = await client.closeTab(getSessionName(), idx)
        console.log(JSON.stringify(result, null, 2))
    })

const frames = program
    .command('frames')
    .description('Browser frame management')

frames
    .command('list')
    .description('List all browser frames')
    .action(async () => {
        const client = await getClient()
        const result = await client.listFrames(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

frames
    .command('switch <selector>')
    .description('Switch to frame matching selector')
    .action(async (selector: string) => {
        const client = await getClient()
        const result = await client.switchFrame(getSessionName(), selector)
        console.log(JSON.stringify(result, null, 2))
    })

frames
    .command('main')
    .description('Switch back to main frame')
    .action(async () => {
        const client = await getClient()
        const result = await client.switchFrameMain(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

program
    .command('screenshot')
    .description('Take screenshots')
    .argument('[path]', 'Output file path (default: ~/.viewprint/screenshots/...)')
    .option('--element <elementId>', 'Screenshot specific element instead of full page')
    .action(async (path: string | undefined, options: { element?: string }) => {
        const client = await getClient()
        if (options.element) {
            const result = await client.screenshotElement(getSessionName(), options.element, path)
            console.log(JSON.stringify(result, null, 2))
        } else {
            const result = await client.screenshotPage(getSessionName(), path)
            console.log(JSON.stringify(result, null, 2))
        }
    })

program
    .command('read')
    .description('Extract readable text or markdown from the current page')
    .option('--format <format>', 'text or markdown', 'text')
    .action(async (options: { format: string }) => {
        const client = await getClient()
        const result = await client.read(getSessionName(), options.format as 'text' | 'markdown')
        console.log(result.content)
    })

program
    .command('status')
    .description('Show current session URL and element count')
    .action(async () => {
        const client = await getClient()
        const status = await client.status(getSessionName())
        console.log(JSON.stringify(status, null, 2))
    })

program
    .command('close')
    .description('Close session and persist state')
    .action(async () => {
        const client = await getClient()
        await client.close(getSessionName())
        console.log(JSON.stringify({ session: getSessionName(), closed: true }, null, 2))
    })

program
    .command('mcp')
    .description('Run as Model Context Protocol (MCP) server on stdio')
    .action(async () => {
        await runMcpServer()
    })

const daemon = program
    .command('daemon')
    .description('Manage viewprint daemon')

daemon
    .command('start')
    .description('Start viewprint daemon')
    .option('--port <number>', 'Daemon port', `${getDaemonPort()}`)
    .option('--idle-timeout <ms>', 'Auto-shutdown after N ms of inactivity (0 to disable)')
    .action(async (options: { port: string; idleTimeout?: string }) => {
        const port = parseInt(options.port, 10)
        const idleTimeoutMs = options.idleTimeout !== undefined
            ? parseInt(options.idleTimeout, 10)
            : getIdleTimeoutFromEnv()
        if (await isDaemonRunning(port)) {
            console.log(JSON.stringify({ port, running: true, idleTimeoutMs: idleTimeoutMs ?? null }, null, 2))
            return
        }
        await startDaemonProcess({ port, idleTimeoutMs })
        console.log(JSON.stringify({ port, started: true, idleTimeoutMs: idleTimeoutMs ?? null }, null, 2))
    })

daemon
    .command('stop')
    .description('Stop viewprint daemon')
    .action(async () => {
        await stopDaemonProcess(getDaemonPort())
        console.log(JSON.stringify({ stopped: true }, null, 2))
    })

daemon
    .command('status')
    .description('Show daemon status')
    .action(async () => {
        const running = await isDaemonRunning(getDaemonPort())
        console.log(JSON.stringify({ port: getDaemonPort(), running }, null, 2))
    })

program.parse()
