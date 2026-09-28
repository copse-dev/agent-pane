import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TESTSET = dirname(fileURLToPath(import.meta.url))
// The regression set's anonymised machine: every case runs as this user in this checkout.
export { HOME, WORKSPACE } from '../regression/run.mjs'
