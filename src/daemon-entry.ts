import { startDaemon } from './daemon.js'

const args = process.argv.slice(2)
const portArg = args.find((arg) => arg.startsWith('--port='))
const port = portArg ? parseInt(portArg.slice('--port='.length), 10) : parseInt(process.env.VIEWPRINT_PORT || '7345', 10)

async function main(): Promise<void> {
    const daemon = await startDaemon({ port })

    process.on('SIGTERM', async () => {
        await daemon.stop()
        process.exit(0)
    })

    process.on('SIGINT', async () => {
        await daemon.stop()
        process.exit(0)
    })
}

main().catch((error) => {
    console.error('Daemon failed:', error)
    process.exit(1)
})
