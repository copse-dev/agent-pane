import { z } from 'zod'
import { zPathString, zPrComposerCreateRequest, zProjectId, zThreadId } from './ipc-guards.ts'

// Argument schemas for the `gh:*` handlers in `gh-handlers.ts`, kept free of
// Electron so the parity tests can import them.

const zGhName = z.string().min(1).max(128)
const zPrNumber = z.number().int().positive()

/**
 * `owner, repo, number`. Each was parsed on its own with `parseIpcArgs`, so
 * handlers using it report only the first invalid one (`errors: 'per-argument'`).
 */
export const ghPrRefArgs = z.tuple([zGhName, zGhName, zPrNumber])
export const ghPrFileDiffArgs = z.tuple([zGhName, zGhName, zPrNumber, zPathString])
export const ghCreatePrForThreadArgs = z.tuple([zProjectId, zThreadId, zPrComposerCreateRequest])
