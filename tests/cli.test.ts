import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDaemonMetadataPath, readDaemonMetadata } from '../src/daemon-metadata.js'
import { getPackageVersion } from '../src/version.js'

const cliPath = path.resolve(__dirname, '../dist/src/cli.js')

function runCli(args: string[], port = 65_534) {
    return spawnSync(process.execPath, [cliPath, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, VIEWPRINT_PORT: String(port) }
    })
}

async function getAvailablePort(): Promise<number> {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
        throw new Error('Failed to allocate a test port.')
    }
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
    })
    return address.port
}

describe('CLI entry point', () => {
    it('uses the package version in --version output', () => {
        const result = runCli(['--version'])
        expect(result.status).toBe(0)
        expect(result.stdout.trim()).toBe(getPackageVersion())
    })

    it('lists diff, dialog, and daemon restart commands', () => {
        const result = runCli(['--help'])
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('diff')
        expect(result.stdout).toContain('dialog')
        expect(result.stdout).toContain('daemon')

        const daemonHelp = runCli(['daemon', '--help'])
        expect(daemonHelp.stdout).toContain('restart')
    })

    it('waits for async actions and reports invalid capture arguments with non-zero exit', () => {
        const result = runCli(['-s', 'cli-test', 'capture', '--depth', '2invalid'])
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('Invalid depth')
    })

    it('starts, reports, restarts, and stops an authenticated managed daemon', async () => {
        const port = await getAvailablePort()
        try {
            const started = runCli(['daemon', 'start', '--port', String(port), '--idle-timeout', '0'], port)
            expect(started.status).toBe(0)
            expect(JSON.parse(started.stdout)).toMatchObject({ port, started: true })

            const metadata = readDaemonMetadata(port)
            expect(metadata?.instanceId).toBeTruthy()
            expect((fs.statSync(getDaemonMetadataPath(port)).mode & 0o777)).toBe(0o600)

            const status = runCli(['daemon', 'status', '--port', String(port)], port)
            expect(JSON.parse(status.stdout)).toMatchObject({ port, running: true })

            const restarted = runCli(['daemon', 'restart', '--port', String(port), '--idle-timeout', '0'], port)
            expect(restarted.status).toBe(0)
            expect(JSON.parse(restarted.stdout)).toMatchObject({ port, restarted: true })

            const stopped = runCli(['daemon', 'stop', '--port', String(port)], port)
            expect(stopped.status).toBe(0)
            expect(readDaemonMetadata(port)).toBeNull()

            const stoppedStatus = runCli(['daemon', 'status', '--port', String(port)], port)
            expect(JSON.parse(stoppedStatus.stdout)).toMatchObject({ port, running: false })
        } finally {
            runCli(['daemon', 'stop', '--port', String(port)], port)
        }
    }, 30_000)
})
