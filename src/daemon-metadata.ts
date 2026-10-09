import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface DaemonMetadata {
    pid: number
    port: number
    startedAt: string
    token: string
    instanceId: string
}

const metadataDir = path.join(os.homedir(), '.viewprint', 'daemons')

export function getDaemonMetadataPath(port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid daemon port: ${port}`)
    }
    return path.join(metadataDir, `daemon-${port}.json`)
}

export function readDaemonMetadata(port: number): DaemonMetadata | null {
    const filePath = getDaemonMetadataPath(port)
    if (!fs.existsSync(filePath)) {
        return null
    }
    try {
        const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return null
        }
        const metadata = value as Record<string, unknown>
        if (!Number.isSafeInteger(metadata.pid) || Number(metadata.pid) <= 0
            || metadata.port !== port
            || typeof metadata.startedAt !== 'string'
            || typeof metadata.token !== 'string' || metadata.token.length < 32
            || typeof metadata.instanceId !== 'string' || metadata.instanceId.length < 16) {
            return null
        }
        return {
            pid: Number(metadata.pid),
            port,
            startedAt: metadata.startedAt,
            token: metadata.token,
            instanceId: metadata.instanceId
        }
    } catch {
        return null
    }
}

export function writeDaemonMetadata(metadata: DaemonMetadata): void {
    const filePath = getDaemonMetadataPath(metadata.port)
    fs.mkdirSync(metadataDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(metadataDir, 0o700)
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    const descriptor = fs.openSync(temporaryPath, 'w', 0o600)
    try {
        fs.writeFileSync(descriptor, JSON.stringify(metadata, null, 2))
        fs.fsyncSync(descriptor)
    } finally {
        fs.closeSync(descriptor)
    }
    fs.chmodSync(temporaryPath, 0o600)
    fs.renameSync(temporaryPath, filePath)
    fs.chmodSync(filePath, 0o600)
}

export function removeDaemonMetadata(port: number, instanceId: string): void {
    const filePath = getDaemonMetadataPath(port)
    const metadata = readDaemonMetadata(port)
    if (metadata?.instanceId === instanceId && fs.existsSync(filePath)) {
        fs.rmSync(filePath)
    }
}
