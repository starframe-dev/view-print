import { spawn, execSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { getChildPids, getProcessTreePids, isProcessAlive, killProcessTree } from '../src/process-tree.js'

const spawned: ReturnType<typeof spawn>[] = []

/**
 * Spawns a long-running Node process that survives until explicitly killed.
 * Uses setInterval with no body — keeps the event loop busy without
 * requiring a readable stdin (which is unavailable with stdio: 'ignore').
 */
function spawnLongRunning(): ReturnType<typeof spawn> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: 'ignore',
        detached: false
    })
    spawned.push(child)
    return child
}

function spawnParentWithChild(): { parent: ReturnType<typeof spawn>; getChildPid: () => number | null } {
    const parent = spawn(process.execPath, ['-e', `
        const { spawn } = require('child_process')
        spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })
        setInterval(() => {}, 60000)
    `], { stdio: 'ignore' })
    spawned.push(parent)

    const getChildPid = (): number | null => {
        try {
            const output = execSync(`pgrep -P ${parent.pid}`, { encoding: 'utf-8' }).trim()
            const pid = parseInt(output.split('\n')[0], 10)
            return isNaN(pid) ? null : pid
        } catch {
            return null
        }
    }

    return { parent, getChildPid }
}

afterEach(async () => {
    for (const child of spawned.splice(0)) {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
    }
    // Give OS a moment to reap
    await new Promise((resolve) => setTimeout(resolve, 50))
})

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return true
        await sleep(50)
    }
    return predicate()
}

describe('process-tree', () => {
    it('isProcessAlive returns true for running process', () => {
        const child = spawnLongRunning()
        expect(isProcessAlive(child.pid!)).toBe(true)
    })

    it('isProcessAlive returns false after process exits', async () => {
        const child = spawnLongRunning()
        const pid = child.pid!
        child.kill('SIGKILL')
        const exited = await waitFor(() => !isProcessAlive(pid))
        expect(exited).toBe(true)
    })

    it('getChildPids returns direct children', async () => {
        const { parent, getChildPid } = spawnParentWithChild()
        const hasChild = await waitFor(() => getChildPid() !== null)
        expect(hasChild).toBe(true)
        const childPid = getChildPid()
        expect(childPid).not.toBeNull()

        const children = getChildPids(parent.pid!)
        expect(children).toContain(childPid)
    })

    it('getProcessTreePids returns descendants', async () => {
        const { parent, getChildPid } = spawnParentWithChild()
        const hasChild = await waitFor(() => getChildPid() !== null)
        expect(hasChild).toBe(true)
        const childPid = getChildPid()
        expect(childPid).not.toBeNull()

        const tree = getProcessTreePids(parent.pid!)
        expect(tree).toContain(childPid)
    })

    it('killProcessTree kills the entire tree', async () => {
        const { parent, getChildPid } = spawnParentWithChild()
        const hasChild = await waitFor(() => getChildPid() !== null)
        expect(hasChild).toBe(true)
        const childPid = getChildPid()!

        expect(isProcessAlive(parent.pid!)).toBe(true)
        expect(isProcessAlive(childPid)).toBe(true)

        killProcessTree(parent.pid!)

        const parentDead = await waitFor(() => !isProcessAlive(parent.pid!))
        const childDead = await waitFor(() => !isProcessAlive(childPid))
        expect(parentDead).toBe(true)
        expect(childDead).toBe(true)
    })

    it('getChildPids returns empty array for non-existent process', () => {
        const children = getChildPids(999999)
        expect(children).toEqual([])
    })
})
