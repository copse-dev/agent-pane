import { z } from 'zod'
import { zNonEmptyString } from './ipc-guards.ts'

// Argument schemas for the `memories:*` channels. They live apart from the
// handlers, which import Electron, so the parity tests in `ipc-handler.test.ts`
// check the schemas the channels use.

const zMemoryId = zNonEmptyString.max(128)
const zMemoryTitle = z.string().max(512)
const zMemoryBody = z.string().max(1_000_000)
const zMemoryTags = z.array(z.string().max(128)).max(64)

/** `memories:create (title, body, tags?)`, parsed one argument at a time. */
export const memoriesCreateArgs = z.tuple([zMemoryTitle, zMemoryBody, zMemoryTags.optional()])
/** `memories:update (id, title, body, tags?)`, parsed one argument at a time. */
export const memoriesUpdateArgs = z.tuple([
  zMemoryId,
  zMemoryTitle,
  zMemoryBody,
  zMemoryTags.optional(),
])
/** `memories:delete (id)`. */
export const memoriesDeleteArgs = z.tuple([zMemoryId])
