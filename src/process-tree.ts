import { execSync } from 'node:child_process'

/**
 * Returns immediate child PIDs of the given parent PID.
 * Uses `pgrep -P` which is portable across macOS (BSD) and Linux.
 * Returns empty array on failure (e.g. process already dead, unsupported platform).
 */
export function getChildPids(pid: number): number[] {
    try {
        const output = execSync(`pgrep -P ${pid}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 2000
        })
        return output.trim().split('\n')
            .map((line) => parseInt(line.trim(), 10))
            .filter((p) => !isNaN(p) && p > 0)
    } catch {
        return []
    }
}

/**
 * Recursively collects all descendant PIDs (children, grandchildren, ...).
 * Bounded by `maxDepth` to prevent infinite loops.
 */
export function getProcessTreePids(pid: number, maxDepth = 10): number[] {
    const result: number[] = []
    const queue: Array<{ pid: number; depth: number }> = [{ pid, depth: 0 }]

    while (queue.length > 0) {
        const current = queue.shift()!
        const children = getChildPids(current.pid)
        for (const child of children) {
            result.push(child)
            if (current.depth < maxDepth) {
                queue.push({ pid: child, depth: current.depth + 1 })
            }
        }
    }

    return result
}

/**
 * Sends a signal to the given PID and all its descendants.
 * Children are killed first, then the parent.
 * Errors are swallowed (process may already be dead).
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    const descendants = getProcessTreePids(pid)
    for (const childPid of descendants) {
        try { process.kill(childPid, signal) } catch { /* ignore */ }
    }
    try { process.kill(pid, signal) } catch { /* ignore */ }
}

/**
 * Checks if a process is alive.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

/**
 * Returns PIDs of all chrome-headless-shell and Google Chrome processes
 * whose command line references the given userDataDir. Used as a last-resort
 * cleanup when browserPid is unknown (e.g. Playwright dropped Browser.process()).
 */
export function findChromeProcessesByUserDataDir(userDataDir: string): number[] {
    if (!userDataDir) {
        return []
    }
    try {
        const escaped = userDataDir.replace(/"/g, '\\"')
        const output = execSync(`ps -axo pid,command | grep -E "chrome-headless-shell|Google Chrome" | grep -F "${escaped}" | grep -v grep`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 2000
        })
        const pids: number[] = []
        for (const line of output.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            const pid = parseInt(trimmed.split(/\s+/)[0], 10)
            if (!isNaN(pid) && pid > 0) {
                pids.push(pid)
            }
        }
        return pids
    } catch {
        return []
    }
}

/**
 * Returns true if any chrome processes for the given userDataDir are still alive.
 */
export function hasOrphanedChromeProcesses(userDataDir: string): boolean {
    return findChromeProcessesByUserDataDir(userDataDir).length > 0
}

/**
 * Sends a signal to all chrome processes matching the given userDataDir.
 * Returns the number of processes that were signaled.
 */
export function killChromeProcessesByUserDataDir(userDataDir: string, signal: NodeJS.Signals = 'SIGTERM'): number {
    const pids = findChromeProcessesByUserDataDir(userDataDir)
    let killed = 0
    for (const pid of pids) {
        try {
            process.kill(pid, signal)
            killed++
        } catch {
            /* ignore */
        }
    }
    return killed
}
