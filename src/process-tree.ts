import { execFileSync } from 'node:child_process'

export const SUPPORTED_PROCESS_PLATFORMS = ['darwin', 'linux'] as const

export function isProcessManagementSupported(platform: NodeJS.Platform = process.platform): boolean {
    return SUPPORTED_PROCESS_PLATFORMS.some((supported) => supported === platform)
}

export function assertSupportedProcessPlatform(): void {
    if (!isProcessManagementSupported()) {
        throw new Error(`Daemon process management is supported only on macOS and Linux; found ${process.platform}.`)
    }
}

function runProcessCommand(command: string, args: string[]): string {
    if (!isProcessManagementSupported()) {
        return ''
    }
    try {
        return execFileSync(command, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2_000
        })
    } catch {
        return ''
    }
}

export function getProcessCommand(pid: number): string | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return null
    }
    const command = runProcessCommand('ps', ['-p', String(pid), '-o', 'command=']).trim()
    return command || null
}

export function isViewPrintDaemonCommand(command: string, instanceId: string): boolean {
    return command.includes('daemon-entry.js') && command.includes(`--instance-id=${instanceId}`)
}

/** Returns immediate child PIDs using an argument-safe platform command. */
export function getChildPids(pid: number): number[] {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return []
    }
    const output = runProcessCommand('pgrep', ['-P', String(pid)])
    return output.split('\n')
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((childPid) => Number.isSafeInteger(childPid) && childPid > 0)
}

/** Recursively collects descendants without interpolating values into a shell. */
export function getProcessTreePids(pid: number, maxDepth = 10): number[] {
    const result: number[] = []
    const queue: Array<{ pid: number; depth: number }> = [{ pid, depth: 0 }]
    let queueIndex = 0

    while (queueIndex < queue.length) {
        const current = queue[queueIndex]
        queueIndex++
        if (!current) {
            continue
        }
        for (const childPid of getChildPids(current.pid)) {
            result.push(childPid)
            if (current.depth < maxDepth) {
                queue.push({ pid: childPid, depth: current.depth + 1 })
            }
        }
    }

    return result
}

/** Signals descendants before their parent. Callers must verify process ownership first. */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    const descendants = getProcessTreePids(pid)
    for (const childPid of descendants) {
        try { process.kill(childPid, signal) } catch { /* Process may have exited. */ }
    }
    try { process.kill(pid, signal) } catch { /* Process may have exited. */ }
}

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

export function findChromeProcessesByUserDataDir(userDataDir: string): number[] {
    if (!userDataDir || !isProcessManagementSupported()) {
        return []
    }
    const output = runProcessCommand('ps', ['-axo', 'pid,command'])
    const pids: number[] = []
    for (const line of output.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/)
        if (!match) {
            continue
        }
        const pid = Number.parseInt(match[1], 10)
        const command = match[2]
        if (Number.isSafeInteger(pid)
            && pid > 0
            && /chrom(e|ium)|headless/i.test(command)
            && command.includes(userDataDir)) {
            pids.push(pid)
        }
    }
    return pids
}

export function hasOrphanedChromeProcesses(userDataDir: string): boolean {
    return findChromeProcessesByUserDataDir(userDataDir).length > 0
}

export function killChromeProcessesByUserDataDir(userDataDir: string, signal: NodeJS.Signals = 'SIGTERM'): number {
    const pids = findChromeProcessesByUserDataDir(userDataDir)
    let killed = 0
    for (const pid of pids) {
        try {
            process.kill(pid, signal)
            killed++
        } catch {
            // Process may have exited.
        }
    }
    return killed
}
