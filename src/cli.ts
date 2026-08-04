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

function parseDepth(value: string): number {
    const n = parseInt(value, 10)
    if (Number.isNaN(n) || n < 1) {
        throw new Error('Invalid depth. Use an integer >= 1.')
    }
    return n
}

function parseExpand(value: string | undefined): string[] {
    if (!value) {
        return []
    }
    return value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        .map((id) => (id.startsWith('@') ? id.slice(1) : id))
}

function normalizeRef(elementId: string): string {
    return elementId.startsWith('@') ? elementId.slice(1) : elementId
}

program
    .command('capture [url]')
    .description('Capture lightweight layout graph as a tree. Uses current session URL if not provided.')
    .option('--viewport <size>', 'Viewport size WIDTHxHEIGHT', '1280x720')
    .option('--depth <n>', 'Tree depth to expand (default 1). Use a large number for full expansion.', '1')
    .option('--expand <ids>', 'Comma-separated element ids to expand fully (e.g. e3,e5 or @e3,@e5), regardless of depth.')
    .option('--query <selector>', 'CSS selector. Matching elements become tree roots (combined with --expand).')
    .option('--profile', 'Enable per-action profiling for this call and print summary to stderr')
    .option('--trace <path>', 'Also capture Chrome performance trace and write to <path>')
    .option('--skip-load', 'Skip page.goto if URL already matches the current page URL')
    .option('--no-goto', 'Do not navigate at all; capture the current page (URL is ignored)')
    .action(async (url: string | undefined, options: { viewport: string; depth: string; expand?: string; query?: string, profile?: boolean, trace?: string, skipLoad?: boolean, goto?: boolean }) => {
        const viewport = parseViewport(options.viewport)
        const depth = parseDepth(options.depth)
        const expand = parseExpand(options.expand)
        const client = await getClient()
        const session = getSessionName()
        const captureOptions = { skipLoad: options.skipLoad === true, noLoad: options.goto === false }
        if (captureOptions.noLoad && url) {
            process.stderr.write(`# capture --no-goto: URL "${url}" is ignored; using current page\n`)
        }
        let tracingActive = false
        try {
            if (options.profile) {
                await client.setProfiling(session, true)
            }
            if (options.trace) {
                await client.startTrace(session)
                tracingActive = true
            }
            const graph = await client.capture(session, url, viewport, depth, expand, options.query, captureOptions)
            console.log(JSON.stringify(graph, null, 2))
            if (options.profile) {
                const profile = await client.getProfile(session)
                process.stderr.write(`# profile: ${JSON.stringify(profile.report)}\n`)
            }
            if (options.trace) {
                const traceResult = await client.stopTrace(session, options.trace)
                process.stderr.write(`# trace: ${traceResult.eventCount} events, ${traceResult.sizeBytes} bytes -> ${traceResult.path}\n`)
                tracingActive = false
            }
            if (options.profile) {
                await client.clearProfile(session)
                await client.setProfiling(session, false)
            }
        } catch (err) {
            if (tracingActive) {
                try { await client.stopTrace(session) } catch { /* ignore */ }
            }
            throw err
        }
    })

program
    .command('snapshot [url]')
    .description('Capture accessibility tree with refs. Uses current session URL if not provided.')
    .option('--viewport <size>', 'Viewport size WIDTHxHEIGHT', '1280x720')
    .option('--depth <n>', 'Tree depth to expand (default 1). Use a large number for full expansion.', '1')
    .option('--expand <ids>', 'Comma-separated element ids to expand fully (e.g. e3,e5 or @e3,@e5), regardless of depth.')
    .option('--query <selector>', 'CSS selector. Matching elements become tree roots (combined with --expand).')
    .option('--skip-load', 'Skip page.goto if URL already matches the current page URL')
    .option('--no-goto', 'Do not navigate at all; snapshot the current page (URL is ignored)')
    .action(async (url: string | undefined, options: { viewport: string; depth: string; expand?: string; query?: string, skipLoad?: boolean, goto?: boolean }) => {
        const viewport = parseViewport(options.viewport)
        const depth = parseDepth(options.depth)
        const expand = parseExpand(options.expand)
        const client = await getClient()
        const snapshotOptions = { skipLoad: options.skipLoad === true, noLoad: options.goto === false }
        if (snapshotOptions.noLoad && url) {
            process.stderr.write(`# snapshot --no-goto: URL "${url}" is ignored; using current page\n`)
        }
        const snapshot = await client.snapshot(getSessionName(), url, viewport, depth, expand, options.query, snapshotOptions)
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
    .option('--padding <px>', 'Extra padding around element (only with --element, default 0)', '0')
    .action(async (path: string | undefined, options: { element?: string; padding?: string }) => {
        const client = await getClient()
        if (options.element) {
            const padding = parseInt(options.padding ?? '0', 10)
            const result = await client.screenshotElement(getSessionName(), options.element, padding, path)
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

const traceCmd = program
    .command('trace')
    .description('Chrome DevTools Protocol performance tracing')

traceCmd
    .command('start')
    .description('Start tracing on the session (must run capture/snapshot/etc. afterwards to generate events)')
    .option('--categories <list>', 'Comma-separated trace categories (overrides default)')
    .action(async (options: { categories?: string }) => {
        const client = await getClient()
        const categories = options.categories ? options.categories.split(',').map((c) => c.trim()) : undefined
        const result = await client.startTrace(getSessionName(), categories)
        console.log(JSON.stringify(result, null, 2))
    })

traceCmd
    .command('stop')
    .description('Stop tracing and write events to JSON file')
    .option('--output <path>', 'Output path for trace JSON (default: ~/.viewprint/traces/trace-<timestamp>.json)')
    .action(async (options: { output?: string }) => {
        const client = await getClient()
        const result = await client.stopTrace(getSessionName(), options.output)
        console.log(JSON.stringify(result, null, 2))
    })

traceCmd
    .command('run')
    .description('Start trace, execute a batch of commands, stop trace. Useful for profiling actions WITHOUT navigation.')
    .option('--actions <json>', 'JSON array of commands: [["click","@e3"],["fill","@e5","hi"]]. Or read from stdin if omitted.')
    .option('--output <path>', 'Output path for trace JSON (default: ~/.viewprint/traces/trace-<timestamp>.json)')
    .option('--categories <list>', 'Comma-separated trace categories (overrides default)')
    .action(async (options: { actions?: string, output?: string, categories?: string }) => {
        let actionsRaw = options.actions
        if (!actionsRaw) {
            // Read from stdin
            const chunks: Buffer[] = []
            for await (const chunk of process.stdin) {
                chunks.push(chunk as Buffer)
            }
            actionsRaw = Buffer.concat(chunks).toString('utf8').trim()
        }
        if (!actionsRaw) {
            console.error('trace run: --actions <json> is required (or pipe JSON via stdin)')
            process.exit(1)
        }
        let commands: unknown[]
        try {
            commands = JSON.parse(actionsRaw)
        } catch (err) {
            console.error(`trace run: invalid JSON: ${(err as Error).message}`)
            process.exit(1)
        }
        if (!Array.isArray(commands)) {
            console.error('trace run: --actions must be a JSON array')
            process.exit(1)
        }

        const client = await getClient()
        const session = getSessionName()
        const categories = options.categories ? options.categories.split(',').map((c) => c.trim()) : undefined

        try {
            const start = await client.startTrace(session, categories)
            process.stderr.write(`# trace: started (${start.categories.length} categories)\n`)
        } catch (err) {
            console.error(`trace run: failed to start trace: ${(err as Error).message}`)
            process.exit(1)
        }

        let traceResult: { eventCount: number, sizeBytes: number, path: string }
        try {
            const batchResult = await client.batch(session, commands)
            // Emit each result on its own line for clarity
            for (const result of batchResult.results) {
                console.log(JSON.stringify(result))
            }
            traceResult = await client.stopTrace(session, options.output)
            process.stderr.write(`# trace: ${traceResult.eventCount} events, ${traceResult.sizeBytes} bytes -> ${traceResult.path}\n`)
        } catch (err) {
            try { await client.stopTrace(session) } catch { /* ignore */ }
            console.error(`trace run: ${(err as Error).message}`)
            process.exit(1)
        }
    })

traceCmd
    .command('report')
    .description('Get current trace report (without writing)')
    .action(async () => {
        const client = await getClient()
        const result = await client.traceReport(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

const profileCmd = program
    .command('profile')
    .description('Per-action profiling of BrowserSession calls')

profileCmd
    .command('enable')
    .description('Enable per-action timing collection for this session')
    .action(async () => {
        const client = await getClient()
        const result = await client.setProfiling(getSessionName(), true)
        console.log(JSON.stringify(result, null, 2))
    })

profileCmd
    .command('disable')
    .description('Disable per-action timing collection')
    .action(async () => {
        const client = await getClient()
        const result = await client.setProfiling(getSessionName(), false)
        console.log(JSON.stringify(result, null, 2))
    })

profileCmd
    .command('show')
    .description('Show collected timings and aggregate report')
    .action(async () => {
        const client = await getClient()
        const result = await client.getProfile(getSessionName())
        console.log(JSON.stringify(result, null, 2))
    })

profileCmd
    .command('clear')
    .description('Clear collected timings')
    .action(async () => {
        const client = await getClient()
        const result = await client.clearProfile(getSessionName())
        console.log(JSON.stringify(result, null, 2))
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

program
    .command('reinstall')
    .description('Re-link the global viewprint binary to the current project. Kills the daemon so the next call picks up new code.')
    .action(async () => {
        const { execFileSync } = await import('node:child_process')
        const projectRoot = new URL('..', import.meta.url).pathname
        try {
            await stopDaemonProcess(getDaemonPort())
        } catch {
            // daemon may not be running — ignore
        }
        console.log('Reinstalling global @starframe/view-print from', projectRoot)
        execFileSync('pnpm', ['add', '-g', `file:${projectRoot}`, '--force'], { stdio: 'inherit' })
        console.log(JSON.stringify({ reinstalled: true, path: projectRoot }, null, 2))
    })

program.parse()
