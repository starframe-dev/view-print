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
