import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionState } from './types.js'

const sessionsDir = path.join(os.homedir(), '.viewprint', 'sessions')

type JsonRecord = Record<string, unknown>

type SessionCookie = SessionState['cookies'][number]

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStringMap(value: unknown, fieldName: string): Record<string, string> {
    if (value === undefined || value === null) {
        return {}
    }
    if (!isRecord(value)) {
        throw new Error(`Invalid ${fieldName}. Must be an object of string values.`)
    }

    const result: Record<string, string> = {}
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') {
            throw new Error(`Invalid ${fieldName}.${key}. Value must be a string.`)
        }
        result[key] = item
    }
    return result
}

function parseViewport(value: unknown): SessionState['viewport'] {
    if (value === undefined || value === null) {
        return undefined
    }
    if (!isRecord(value) || typeof value.width !== 'number' || typeof value.height !== 'number'
        || !Number.isFinite(value.width) || !Number.isFinite(value.height)
        || value.width <= 0 || value.height <= 0) {
        throw new Error('Invalid viewport. Width and height must be positive numbers.')
    }
    return { width: value.width, height: value.height }
}

function parseCookie(value: unknown, index: number): SessionCookie {
    if (!isRecord(value)
        || typeof value.name !== 'string'
        || typeof value.value !== 'string'
        || typeof value.domain !== 'string'
        || typeof value.path !== 'string') {
        throw new Error(`Invalid cookies[${index}]. Required fields: name, value, domain, path.`)
    }

    if (value.expires !== undefined && typeof value.expires !== 'number') {
        throw new Error(`Invalid cookies[${index}].expires. Must be a number.`)
    }
    if (value.httpOnly !== undefined && typeof value.httpOnly !== 'boolean') {
        throw new Error(`Invalid cookies[${index}].httpOnly. Must be a boolean.`)
    }
    if (value.secure !== undefined && typeof value.secure !== 'boolean') {
        throw new Error(`Invalid cookies[${index}].secure. Must be a boolean.`)
    }
    if (value.sameSite !== undefined && value.sameSite !== 'Strict' && value.sameSite !== 'Lax' && value.sameSite !== 'None') {
        throw new Error(`Invalid cookies[${index}].sameSite. Must be Strict, Lax or None.`)
    }

    return {
        name: value.name,
        value: value.value,
        domain: value.domain,
        path: value.path,
        ...(value.expires === undefined ? {} : { expires: value.expires }),
        ...(value.httpOnly === undefined ? {} : { httpOnly: value.httpOnly }),
        ...(value.secure === undefined ? {} : { secure: value.secure }),
        ...(value.sameSite === undefined ? {} : { sameSite: value.sameSite })
    }
}

function parseCookies(value: unknown): SessionState['cookies'] {
    if (value === undefined || value === null) {
        return []
    }
    if (!Array.isArray(value)) {
        throw new Error('Invalid cookies. Must be an array.')
    }
    return value.map((cookie, index) => parseCookie(cookie, index))
}

function validateSessionName(name: string): void {
    if (name.length === 0 || name === '.' || name === '..' || /[\\/]/.test(name)) {
        throw new Error('Invalid session name.')
    }
}

export function getSessionPath(name: string): string {
    return path.join(sessionsDir, name, 'state.json')
}

export function sessionExists(name: string): boolean {
    return fs.existsSync(getSessionPath(name))
}

export function normalizeSessionState(value: unknown, name: string): SessionState {
    if (!isRecord(value)) {
        throw new Error('Invalid session state. Must be an object.')
    }
    if (value.url !== undefined && value.url !== null && typeof value.url !== 'string') {
        throw new Error('Invalid session state URL. Must be a string.')
    }

    validateSessionName(name)
    return {
        name,
        url: typeof value.url === 'string' ? value.url : undefined,
        viewport: parseViewport(value.viewport),
        cookies: parseCookies(value.cookies),
        localStorage: parseStringMap(value.localStorage, 'localStorage'),
        sessionStorage: parseStringMap(value.sessionStorage, 'sessionStorage')
    }
}

export function loadSession(name: string): SessionState {
    const filePath = getSessionPath(name)
    if (!fs.existsSync(filePath)) {
        return { name, cookies: [], localStorage: {}, sessionStorage: {} }
    }

    const data = fs.readFileSync(filePath, 'utf-8')
    return normalizeSessionState(JSON.parse(data), name)
}

export function saveSession(state: SessionState): void {
    const normalized = normalizeSessionState(state, state.name)
    const filePath = getSessionPath(normalized.name)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2))
}

export function deleteSession(name: string): void {
    const filePath = getSessionPath(name)
    if (fs.existsSync(filePath)) {
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true })
    }
}

export function renameSession(name: string, newName: string): void {
    validateSessionName(newName)
    if (!sessionExists(name)) {
        throw new Error(`Session not found: ${name}`)
    }
    if (sessionExists(newName)) {
        throw new Error(`Session already exists: ${newName}`)
    }

    const state = loadSession(name)
    state.name = newName
    saveSession(state)
    deleteSession(name)
}

export function importSession(name: string, value: unknown, force: boolean = false): void {
    validateSessionName(name)
    if (sessionExists(name) && !force) {
        throw new Error(`Session already exists: ${name}. Use --force to overwrite.`)
    }
    saveSession(normalizeSessionState(value, name))
}

export function exportSession(name: string): SessionState {
    if (!sessionExists(name)) {
        throw new Error(`Session not found: ${name}`)
    }
    return loadSession(name)
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
