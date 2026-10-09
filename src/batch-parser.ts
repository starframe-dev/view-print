export function parseBatchCommands(commands: string[]): unknown[][] {
    return commands.map((cmd) => {
        const parts = cmd.match(/"[^"]+"|\S+/g) || []
        return parts.map((part) => {
            if (part.startsWith('"') && part.endsWith('"')) {
                return part.slice(1, -1)
            }
            try {
                return JSON.parse(part)
            } catch {
                return part
            }
        })
    })
}
