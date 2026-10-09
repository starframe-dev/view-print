import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionState, SessionTabState } from './types.js'

const rootDir = path.join(os.homedir(), '.viewprint')
const sessionsDir = path.join(rootDir, 'sessions')

type JsonRecord = Record<string, unknown>
type StringMap = Record<string, string>
type SessionCookie = SessionState['cookies'][number]

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStringMap(value: unknown, fieldName: string): StringMap {
    if (value === undefined || value === null) {
        return {}
    }
    if (!isRecord(value)) {
        throw new Error(`Invalid ${fieldName}. Must be an object of string values.`)
    }

    const result: StringMap = {}
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') {
            throw new Error(`Invalid ${fieldName}.${key}. Value must be a string.`)
        }
        result[key] = item
    }
    return result
}

function getLegacyOrigin(url: unknown): string | undefined {
    if (typeof url !== 'string') {
        return undefined
    }
    try {
        const parsed = new URL(url)
        return parsed.origin === 'null' ? undefined : parsed.origin
    } catch {
        return undefined
    }
}

function parseOriginStorage(value: unknown, legacyOrigin: string | undefined): SessionState['localStorage'] {
    if (value === undefined || value === null) {
        return {}
    }
    if (!isRecord(value)) {
        throw new Error('Invalid localStorage. Must be an object.')
    }

    const entries = Object.entries(value)
    if (entries.every(([, item]) => typeof item === 'string')) {
        if (!legacyOrigin || entries.length === 0) {
            return {}
        }
        return { [legacyOrigin]: parseStringMap(value, 'localStorage') }
    }
    if (entries.some(([, item]) => !isRecord(item))) {
        parseStringMap(value, 'localStorage')
        return {}
    }

    const result: SessionState['localStorage'] = {}
    for (const [origin, items] of entries) {
        try {
            if (new URL(origin).origin !== origin) {
                throw new Error()
            }
        } catch {
            throw new Error(`Invalid localStorage origin: ${origin}`)
        }
        result[origin] = parseStringMap(items, `localStorage.${origin}`)
    }
    return result
}

function parseSessionStorage(
    value: unknown,
    legacyOrigin: string | undefined,
    activeTabId: string
): SessionState['sessionStorage'] {
    if (value === undefined || value === null) {
        return {}
    }
    if (!isRecord(value)) {
        throw new Error('Invalid sessionStorage. Must be an object.')
    }

    const entries = Object.entries(value)
    if (entries.every(([, item]) => typeof item === 'string')) {
        if (!legacyOrigin || entries.length === 0) {
            return {}
        }
        return { [activeTabId]: { [legacyOrigin]: parseStringMap(value, 'sessionStorage') } }
    }
    if (entries.some(([, item]) => !isRecord(item))) {
        parseStringMap(value, 'sessionStorage')
        return {}
    }

    const result: SessionState['sessionStorage'] = {}
    for (const [tabId, origins] of entries) {
        if (!/^[a-zA-Z0-9_-]+$/.test(tabId) || !isRecord(origins)) {
            throw new Error(`Invalid sessionStorage tab: ${tabId}`)
        }
        const tabStorage: Record<string, StringMap> = {}
        for (const [origin, items] of Object.entries(origins)) {
            try {
                if (new URL(origin).origin !== origin) {
                    throw new Error()
                }
            } catch {
                throw new Error(`Invalid sessionStorage origin: ${origin}`)
            }
            tabStorage[origin] = parseStringMap(items, `sessionStorage.${tabId}.${origin}`)
        }
        result[tabId] = tabStorage
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

function parseTabs(value: unknown, legacyUrl: string | undefined): SessionTabState[] {
    if (value === undefined || value === null) {
        return legacyUrl ? [{ id: 'tab-1', url: legacyUrl }] : []
    }
    if (!Array.isArray(value)) {
        throw new Error('Invalid tabs. Must be an array.')
    }
    return value.map((tab, index) => {
        if (!isRecord(tab) || typeof tab.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(tab.id)
            || typeof tab.url !== 'string') {
            throw new Error(`Invalid tabs[${index}]. Required fields: id, url.`)
        }
        return { id: tab.id, url: tab.url }
    })
}

export function validateSessionName(name: string): void {
    if (name.length === 0 || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\0')) {
        throw new Error('Invalid session name.')
    }
}

export function getSessionPath(name: string): string {
    validateSessionName(name)
    return path.join(sessionsDir, name, 'state.json')
}

export function sessionExists(name: string): boolean {
    return fs.existsSync(getSessionPath(name))
}

export function normalizeSessionState(value: unknown, name: string): SessionState {
    validateSessionName(name)
    if (!isRecord(value)) {
        throw new Error('Invalid session state. Must be an object.')
    }
    if (value.url !== undefined && value.url !== null && typeof value.url !== 'string') {
        throw new Error('Invalid session state URL. Must be a string.')
    }

    const url = typeof value.url === 'string' ? value.url : undefined
    const legacyOrigin = getLegacyOrigin(url)
    const tabs = parseTabs(value.tabs, url)
    const activeTabId = typeof value.activeTabId === 'string'
        ? value.activeTabId
        : tabs[0]?.id
    if (activeTabId && !tabs.some((tab) => tab.id === activeTabId)) {
        throw new Error('Invalid activeTabId. It must reference a saved tab.')
    }

    return {
        name,
        url,
        viewport: parseViewport(value.viewport),
        cookies: parseCookies(value.cookies),
        localStorage: parseOriginStorage(value.localStorage, legacyOrigin),
        sessionStorage: parseSessionStorage(value.sessionStorage, legacyOrigin, activeTabId ?? 'tab-1'),
        tabs,
        activeTabId
    }
}

function ensurePrivateDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
}

export function loadSession(name: string): SessionState {
    const filePath = getSessionPath(name)
    if (!fs.existsSync(filePath)) {
        return normalizeSessionState({}, name)
    }

    const data = fs.readFileSync(filePath, 'utf-8')
    return normalizeSessionState(JSON.parse(data) as unknown, name)
}

export function saveSession(state: SessionState): void {
    const normalized = normalizeSessionState(state, state.name)
    const sessionDir = path.dirname(getSessionPath(normalized.name))
    ensurePrivateDirectory(rootDir)
    ensurePrivateDirectory(sessionsDir)
    ensurePrivateDirectory(sessionDir)

    const filePath = path.join(sessionDir, 'state.json')
    const temporaryPath = path.join(sessionDir, `state.${process.pid}.${Date.now()}.tmp`)
    const fileDescriptor = fs.openSync(temporaryPath, 'w', 0o600)
    try {
        fs.writeFileSync(fileDescriptor, JSON.stringify(normalized, null, 2))
        fs.fsyncSync(fileDescriptor)
    } finally {
        fs.closeSync(fileDescriptor)
    }
    fs.chmodSync(temporaryPath, 0o600)
    fs.renameSync(temporaryPath, filePath)
    fs.chmodSync(filePath, 0o600)
}

export function deleteSession(name: string): void {
    const filePath = getSessionPath(name)
    if (fs.existsSync(filePath)) {
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true })
    }
}

export function renameSession(name: string, newName: string): void {
    validateSessionName(name)
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

    return fs.readdirSync(sessionsDir)
        .filter((name) => {
            try {
                validateSessionName(name)
                const sessionPath = path.join(sessionsDir, name, 'state.json')
                return fs.statSync(path.join(sessionsDir, name)).isDirectory() && fs.existsSync(sessionPath)
            } catch {
                return false
            }
        })
        .sort()
}
