#!/usr/bin/env node
import { Command } from 'commander'
import { createDaemonClient } from './daemon-client.js'
import {
    ensureDaemonRunning,
    getDaemonPort,
    isDaemonRunning,
    startDaemonProcess,
    stopDaemonProcess
} from './daemon-process.js'

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
    .command('inspect <elementId>')
    .description('Inspect full details of an element by viewprint ID')
    .action(async (elementId: string) => {
        const client = await getClient()
        const element = await client.inspect(getSessionName(), elementId)
        console.log(JSON.stringify(element, null, 2))
    })

program
    .command('click <elementId>')
    .description('Click element by viewprint ID')
    .action(async (elementId: string) => {
        const client = await getClient()
        const result = await client.click(getSessionName(), elementId)
        console.log(JSON.stringify(result, null, 2))
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

const daemon = program
    .command('daemon')
    .description('Manage viewprint daemon')

daemon
    .command('start')
    .description('Start viewprint daemon')
    .option('--port <number>', 'Daemon port', `${getDaemonPort()}`)
    .action(async (options: { port: string }) => {
        const port = parseInt(options.port, 10)
        if (await isDaemonRunning(port)) {
            console.log(JSON.stringify({ port, running: true }, null, 2))
            return
        }
        await startDaemonProcess(port)
        console.log(JSON.stringify({ port, started: true }, null, 2))
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
