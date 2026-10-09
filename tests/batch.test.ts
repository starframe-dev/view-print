import { describe, expect, it } from 'vitest'
import { parseBatchCommands } from '../src/batch-parser.js'

describe('positional batch parser', () => {
    it('splits each command on whitespace', () => {
        expect(parseBatchCommands(['click @e2 now'])).toEqual([['click', '@e2', 'now']])
    })

    it('keeps quoted segments with spaces as one argument and strips the quotes', () => {
        expect(parseBatchCommands(['fill @e3 "hello world"'])).toEqual([['fill', '@e3', 'hello world']])
    })

    it('parses JSON-compatible tokens such as numbers and booleans', () => {
        expect(parseBatchCommands(['wait 500 true'])).toEqual([['wait', 500, true]])
    })

    it('keeps backslashes inside tokens literally', () => {
        expect(parseBatchCommands(['eval a\\b'])).toEqual([['eval', 'a\\b']])
    })

    it('returns an empty argument list for a blank command', () => {
        expect(parseBatchCommands(['   '])).toEqual([[]])
    })

    it('parses several commands independently', () => {
        expect(parseBatchCommands(['click @e1', 'fill @e2 "a b"'])).toEqual([
            ['click', '@e1'],
            ['fill', '@e2', 'a b']
        ])
    })
})
