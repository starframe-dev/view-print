import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionState } from './types.js'

const sessionsDir = path.join(os.homedir(), '.viewprint', 'sessions')

export function getSessionPath(name: string): string {
    return path.join(sessionsDir, name, 'state.json')
}

export function loadSession(name: string): SessionState {
    const filePath = getSessionPath(name)
    if (!fs.existsSync(filePath)) {
        return { name, cookies: [], localStorage: {} }
    }

    const data = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(data) as SessionState
    return {
        name: parsed.name,
        url: parsed.url,
        cookies: parsed.cookies || [],
        localStorage: parsed.localStorage || {}
    }
}

export function saveSession(state: SessionState): void {
    const filePath = getSessionPath(state.name)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2))
}

export function deleteSession(name: string): void {
    const filePath = getSessionPath(name)
    if (fs.existsSync(filePath)) {
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true })
    }
}

export function listSessions(): string[] {
    if (!fs.existsSync(sessionsDir)) {
        return []
    }

    return fs
        .readdirSync(sessionsDir)
        .filter((name) => {
            const sessionPath = path.join(sessionsDir, name, 'state.json')
            return fs.statSync(path.join(sessionsDir, name)).isDirectory() && fs.existsSync(sessionPath)
        })
        .sort()
}
