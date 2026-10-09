import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const rawPackageMetadata: unknown = require('../package.json')

function getVersion(metadata: unknown): string {
    if (typeof metadata !== 'object' || metadata === null || !('version' in metadata) || typeof metadata.version !== 'string') {
        throw new Error('Package metadata must contain a string version.')
    }
    return metadata.version
}

const packageVersion = getVersion(rawPackageMetadata)

export function getPackageVersion(): string {
    return packageVersion
}
