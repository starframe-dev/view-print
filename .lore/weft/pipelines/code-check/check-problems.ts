import { runProblemCheck } from '@human-horizon/code-check'

export async function main(args: string[]): Promise<void> {
    const projectPath = args[0] ?? process.cwd()
    const result = await runProblemCheck(projectPath)
    if (!result.ok) {
        console.error(result.error.message)
        process.exit(1)
    }
    console.log(JSON.stringify(result.value, null, 2))
}

await main(process.argv.slice(2))