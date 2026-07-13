import { startDaemon } from './daemon.js'

const args = process.argv.slice(2)
const portArg = args.find((arg) => arg.startsWith('--port='))
const port = portArg ? parseInt(portArg.slice('--port='.length), 10) : parseInt(process.env.VIEWPRINT_PORT || '7345', 10)

async function main(): Promise<void> {
    const daemon = await startDaemon({ port })

    const cleanup = async (exitCode: number): Promise<void> => {
        await daemon.stop()
        process.exit(exitCode)
    }

    process.on('SIGTERM', () => { void cleanup(0) })
    process.on('SIGINT', () => { void cleanup(0) })
    process.on('uncaughtException', (error) => {
        console.error('Uncaught exception:', error)
        void cleanup(1)
    })
    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled rejection:', reason)
        void cleanup(1)
    })
}

main().catch((error) => {
    console.error('Daemon failed:', error)
    process.exit(1)
})
