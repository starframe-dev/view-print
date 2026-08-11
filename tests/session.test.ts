import { describe, expect, it, vi } from 'vitest'
import { exportSession, importSession, loadSession, renameSession, saveSession, sessionExists } from '../src/session.js'

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
            localStorage: { token: 'xyz' },
            sessionStorage: { csrf: '123' }
        }

        saveSession(state)
        const loaded = loadSession('test')

        expect(loaded.url).toBe('https://example.com')
        expect(loaded.viewport).toEqual({ width: 1920, height: 1080 })
        expect(loaded.cookies).toEqual([{ name: 'session', value: 'abc', domain: 'example.com', path: '/' }])
        expect(loaded.localStorage).toEqual({ token: 'xyz' })
        expect(loaded.sessionStorage).toEqual({ csrf: '123' })
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
        const state = {
            name: 'source',
            url: 'https://example.com',
            viewport: { width: 1440, height: 900 },
            cookies: [{ name: 'token', value: 'secret', domain: 'example.com', path: '/' }],
            localStorage: { theme: 'dark' },
            sessionStorage: { tab: 'home' }
        }

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

    it('rejects invalid imported state', async () => {
        const { vol } = await import('memfs')
        vol.reset()

        expect(() => importSession('invalid', { localStorage: { token: 123 } })).toThrow('localStorage.token')
        expect(() => importSession('invalid', { viewport: { width: 0, height: 100 } })).toThrow('Invalid viewport')
    })
})
