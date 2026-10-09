import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'view-print-package-smoke-'))
const packDirectory = path.join(temporaryDirectory, 'pack')
const consumerDirectory = path.join(temporaryDirectory, 'consumer')
fs.mkdirSync(packDirectory)
fs.mkdirSync(consumerDirectory)

function run(command, args, options = {}) {
    try {
        return execFileSync(command, args, {
            cwd: options.cwd ?? projectRoot,
            env: options.env ?? process.env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: options.timeout ?? 60_000
        })
    } catch (error) {
        const stdout = error.stdout?.toString() ?? ''
        const stderr = error.stderr?.toString() ?? ''
        throw new Error(`${command} ${args.join(' ')} failed.\n${stdout}\n${stderr}`, { cause: error })
    }
}

function parseJson(text, label) {
    try {
        return JSON.parse(text)
    } catch (error) {
        throw new Error(`${label} did not return valid JSON.`, { cause: error })
    }
}

async function availablePort() {
    const server = createServer()
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
    })
    return address.port
}

async function startFixture() {
    const scriptPath = path.join(temporaryDirectory, 'fixture-server.mjs')
    fs.writeFileSync(scriptPath, [
        "import http from 'node:http'",
        "const server = http.createServer((_request, response) => {",
        "    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })",
        "    response.end('<!doctype html><html><head><title>Package smoke</title></head><body><main>Smoke page</main></body></html>')",
        '})',
        "server.listen(0, '127.0.0.1', () => console.log(server.address().port))"
    ].join('\n') + '\n')
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    const port = await new Promise((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => reject(new Error('Fixture server failed to start.')), 5_000)
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
            output += chunk
            const parsedPort = Number(output.trim())
            if (Number.isInteger(parsedPort) && parsedPort > 0) {
                clearTimeout(timeout)
                resolve(parsedPort)
            }
        })
        child.once('error', (error) => {
            clearTimeout(timeout)
            reject(error)
        })
        child.once('exit', (code) => {
            clearTimeout(timeout)
            reject(new Error(`Fixture server exited before startup with code ${code}.`))
        })
    })
    return { child, url: `http://127.0.0.1:${port}/` }
}

async function main() {
    const packOutput = run('pnpm', ['pack', '--pack-destination', packDirectory])
    const tarballs = fs.readdirSync(packDirectory).filter((filename) => filename.endsWith('.tgz'))
    assert.equal(tarballs.length, 1, `Expected one packed tarball. pnpm output: ${packOutput}`)
    const tarballPath = path.join(packDirectory, tarballs[0])
    const entries = run('tar', ['-tzf', tarballPath]).trim().split('\n').filter(Boolean)
    const allowedEntry = /^package\/(?:package\.json|README\.md|LICENSE|dist\/(?:package\.json|src\/[^/]+\.(?:js|d\.ts)))$/
    const unexpectedEntries = entries.filter((entry) => !allowedEntry.test(entry))
    assert.deepEqual(unexpectedEntries, [], 'Tarball contains files outside the publish manifest.')

    fs.writeFileSync(path.join(consumerDirectory, 'package.json'), JSON.stringify({
        name: 'view-print-smoke-consumer',
        private: true,
        type: 'module'
    }, null, 2) + '\n')
    run('pnpm', ['add', tarballPath], { cwd: consumerDirectory, timeout: 120_000 })

    const importCheck = run(process.execPath, ['--input-type=module', '-e', [
        "import * as viewprint from '@starframe/view-print'",
        "if (typeof viewprint.ViewPrintDaemon !== 'function' || typeof viewprint.DaemonClient !== 'function') throw new Error('Missing public exports')",
        "console.log('library import ok')"
    ].join('; ')], { cwd: consumerDirectory })
    assert.match(importCheck, /library import ok/)

    const help = run('pnpm', ['exec', 'viewprint', '--help'], { cwd: consumerDirectory })
    assert.match(help, /Usage: viewprint/)
    assert.match(run('pnpm', ['exec', 'viewprint', '--version'], { cwd: consumerDirectory }).trim(), /^\d+\.\d+\.\d+/)

    const directLibraryCheck = run(process.execPath, ['--input-type=module', '-e', [
        "import { ViewPrintDaemon, DaemonClient } from '@starframe/view-print'",
        'const daemon = new ViewPrintDaemon({ port: 0, idleTimeoutMs: 0 })',
        'await daemon.start()',
        'const client = new DaemonClient({ port: daemon.getPort(), token: daemon.getToken() })',
        'const status = await client.healthStatus()',
        "if (!status.ok || status.instanceId !== daemon.getInstanceId()) throw new Error('Library daemon health check failed')",
        'await daemon.stop()',
        "console.log('library daemon lifecycle ok')"
    ].join('; ')], { cwd: consumerDirectory, timeout: 30_000 })
    assert.match(directLibraryCheck, /library daemon lifecycle ok/)

    const port = await availablePort()
    const session = `package-smoke-${process.pid}-${Date.now()}`
    const environment = { ...process.env, VIEWPRINT_PORT: String(port), VIEWPRINT_IDLE_TIMEOUT_MS: '0' }
    let fixture
    try {
        fixture = await startFixture()
        const cli = (args) => run('pnpm', ['exec', 'viewprint', ...args], {
            cwd: consumerDirectory,
            env: environment,
            timeout: 30_000
        })

        const started = parseJson(cli(['daemon', 'start', '--port', String(port), '--idle-timeout', '0']), 'daemon start')
        assert.equal(started.started, true)
        assert.equal(parseJson(cli(['daemon', 'status', '--port', String(port)]), 'daemon status').running, true)

        const firstCapture = parseJson(cli(['-s', session, 'capture', fixture.url, '--depth', '3']), 'initial capture')
        assert.equal(firstCapture.url, fixture.url)
        cli(['-s', session, 'storage', 'session', 'set', 'recovery-key', 'recovered-value'])
        cli(['-s', session, 'dialog', '--accept', '--prompt-text', 'smoke-response'])
        cli(['-s', session, 'eval', 'document.body.insertAdjacentHTML("beforeend", "<div>Added for diff</div>")'])
        const diff = parseJson(cli(['-s', session, 'diff', 'last']), 'diff last')
        assert.ok(diff.diff?.added.length > 0)
        const prompt = parseJson(cli(['-s', session, 'eval', 'prompt("Continue?")']), 'dialog handling')
        assert.equal(prompt.result, 'smoke-response')
        cli(['-s', session, 'close'])

        const restarted = parseJson(cli(['daemon', 'restart', '--port', String(port), '--idle-timeout', '0']), 'daemon restart')
        assert.equal(restarted.restarted, true)
        assert.equal(parseJson(cli(['daemon', 'status', '--port', String(port)]), 'post-restart status').running, true)

        const recoveredCapture = parseJson(cli(['-s', session, 'capture', '--depth', '3']), 'recovery capture')
        assert.equal(recoveredCapture.url, fixture.url)
        const recoveredStorage = parseJson(cli(['-s', session, 'storage', 'session', 'get']), 'session storage recovery')
        assert.equal(recoveredStorage.data['recovery-key'], 'recovered-value')
        cli(['-s', session, 'close'])

        const stopped = parseJson(cli(['daemon', 'stop', '--port', String(port)]), 'daemon stop')
        assert.equal(stopped.stopped, true)
        assert.equal(parseJson(cli(['daemon', 'status', '--port', String(port)]), 'final daemon status').running, false)

        run(process.execPath, ['--input-type=module', '-e', `import { deleteSession } from '@starframe/view-print'; deleteSession(${JSON.stringify(session)})`], {
            cwd: consumerDirectory
        })
    } finally {
        try {
            run('pnpm', ['exec', 'viewprint', 'daemon', 'stop', '--port', String(port)], {
                cwd: consumerDirectory,
                env: environment,
                timeout: 20_000
            })
        } catch {
            // The daemon may already have stopped.
        }
        if (fixture) {
            fixture.child.kill('SIGTERM')
            await new Promise((resolve) => fixture.child.once('exit', resolve))
        }
    }

    console.log('Package smoke passed: tarball, import, CLI, library daemon, recovery, diff, dialog, restart.')
}

main()
    .catch((error) => {
        console.error(error)
        process.exitCode = 1
    })
    .finally(() => {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    })
