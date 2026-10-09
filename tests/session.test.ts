import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { deleteSession, exportSession, getSessionPath, importSession, loadSession, normalizeSessionState, renameSession, saveSession, sessionExists } from '../src/session.js'

vi.mock('node:fs', async () => {
    const { vol } = await import('memfs')
    return { default: vol }
})

vi.mock('node:os', async () => {
    return { default: { homedir: () => '/home/test' } }
})

describe('session', () => {
    it('loads default session when file does not exist', async () => {
        const { vol } = await import('memfs')
        vol.reset()

        const session = loadSession('test')

        expect(session.name).toBe('test')
        expect(session.cookies).toEqual([])
        expect(session.localStorage).toEqual({})
        expect(session.sessionStorage).toEqual({})
        expect(session.url).toBeUndefined()
    })

    it('saves and loads session state', async () => {
        const { vol } = await import('memfs')
        vol.reset()

        const state = {
            name: 'test',
            url: 'https://example.com',
            viewport: { width: 1920, height: 1080 },
            cookies: [{ name: 'session', value: 'abc', domain: 'example.com', path: '/' }],
            localStorage: { 'https://example.com': { token: 'xyz' } },
            sessionStorage: { 'tab-1': { 'https://example.com': { csrf: '123' } } },
            tabs: [{ id: 'tab-1', url: 'https://example.com' }],
            activeTabId: 'tab-1'
        }

        saveSession(state)
        const loaded = loadSession('test')

        expect(loaded.url).toBe('https://example.com')
        expect(loaded.viewport).toEqual({ width: 1920, height: 1080 })
        expect(loaded.cookies).toEqual([{ name: 'session', value: 'abc', domain: 'example.com', path: '/' }])
        expect(loaded.localStorage).toEqual({ 'https://example.com': { token: 'xyz' } })
        expect(loaded.sessionStorage).toEqual({ 'tab-1': { 'https://example.com': { csrf: '123' } } })
    })

    it('handles missing fields gracefully', async () => {
        const { vol, fs } = await import('memfs')
        vol.reset()
        fs.mkdirSync('/home/test/.viewprint/sessions/test', { recursive: true })
        fs.writeFileSync(
            '/home/test/.viewprint/sessions/test/state.json',
            JSON.stringify({ name: 'test' })
        )

        const loaded = loadSession('test')

        expect(loaded.cookies).toEqual([])
        expect(loaded.localStorage).toEqual({})
        expect(loaded.sessionStorage).toEqual({})
    })

    it('renames, exports and imports complete state', async () => {
        const { vol } = await import('memfs')
        vol.reset()
        const legacyState = {
            name: 'source',
            url: 'https://example.com',
            viewport: { width: 1440, height: 900 },
            cookies: [{ name: 'token', value: 'secret', domain: 'example.com', path: '/' }],
            localStorage: { theme: 'dark' },
            sessionStorage: { tab: 'home' }
        }
        const state = normalizeSessionState(legacyState, 'source')

        saveSession(state)
        renameSession('source', 'renamed')

        expect(sessionExists('source')).toBe(false)
        expect(sessionExists('renamed')).toBe(true)
        expect(exportSession('renamed')).toEqual({ ...state, name: 'renamed' })

        importSession('imported', exportSession('renamed'))
        expect(exportSession('imported')).toEqual({ ...state, name: 'imported' })
        expect(() => importSession('imported', state)).toThrow('Use --force to overwrite')
        importSession('imported', state, true)
        expect(exportSession('imported')).toEqual({ ...state, name: 'imported' })
    })

    it('migrates legacy flat storage into origin and tab scoped state', () => {
        const migrated = normalizeSessionState({
            url: 'https://example.com/path',
            localStorage: { token: 'secret' },
            sessionStorage: { tab: 'home' }
        }, 'legacy')

        expect(migrated.localStorage).toEqual({ 'https://example.com': { token: 'secret' } })
        expect(migrated.sessionStorage).toEqual({ 'tab-1': { 'https://example.com': { tab: 'home' } } })
        expect(migrated.tabs).toEqual([{ id: 'tab-1', url: 'https://example.com/path' }])
    })

    it('rejects invalid imported state', async () => {
        const { vol } = await import('memfs')
        vol.reset()

        expect(() => importSession('invalid', { localStorage: { token: 123 } })).toThrow('localStorage.token')
        expect(() => importSession('invalid', { viewport: { width: 0, height: 100 } })).toThrow('Invalid viewport')
    })

    it.each(['../x', '/tmp/x', 'foo/bar', 'foo\\bar'])('rejects session path traversal name %s', (name) => {
        expect(() => getSessionPath(name)).toThrow('Invalid session name')
        expect(() => sessionExists(name)).toThrow('Invalid session name')
        expect(() => deleteSession(name)).toThrow('Invalid session name')
    })

    it('writes private directories and state files atomically', async () => {
        const { vol } = await import('memfs')
        vol.reset()
        saveSession(normalizeSessionState({ url: 'https://example.com' }, 'private'))

        const rootMode = fs.statSync('/home/test/.viewprint').mode & 0o777
        const sessionsMode = fs.statSync('/home/test/.viewprint/sessions').mode & 0o777
        const sessionMode = fs.statSync('/home/test/.viewprint/sessions/private').mode & 0o777
        const stateMode = fs.statSync(getSessionPath('private')).mode & 0o777

        expect(rootMode).toBe(0o700)
        expect(sessionsMode).toBe(0o700)
        expect(sessionMode).toBe(0o700)
        expect(stateMode).toBe(0o600)
        expect(fs.readdirSync('/home/test/.viewprint/sessions/private')).toEqual(['state.json'])
    })
})
