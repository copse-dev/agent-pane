import { z } from 'zod'
import { classifierProfileSchema } from '@copse/llm/classifiers/schemas.ts'
import { TOOL_PERMISSION_POLICIES } from '@shared/types/tool-permissions.ts'
import { keyProviderSchema } from './ipc-guards.ts'

// Argument schemas for the environment-setup, tool-permissions and classifier
// channels. They live apart from the handlers, which import Electron, so the
// parity tests in `ipc-handler.test.ts` check the schemas the channels use.

/** `environment-setup:apply (reviewId, ids)`. */
export const environmentSetupApplyArgs = z.tuple([z.uuid(), z.array(z.uuid()).max(64)])
/** `environment-setup:undo (applyId)`. */
export const environmentSetupUndoArgs = z.tuple([z.uuid()])
/** `environment-setup:dismiss (dismissed)`. */
export const environmentSetupDismissArgs = z.tuple([z.boolean()])

const zToolIds = z.array(z.string().min(1).max(8192)).max(2_000)
/** `tool-permissions:set ({ toolIds, policy })`. */
export const toolPermissionsSetArgs = z.tuple([
  z.object({ toolIds: zToolIds, policy: z.enum(TOOL_PERMISSION_POLICIES) }),
])
/** `tool-permissions:reset ({ toolIds })`. */
export const toolPermissionsResetArgs = z.tuple([z.object({ toolIds: zToolIds })])

const zClassifierId = keyProviderSchema.max(53)
/** `classifiers:save (profile)`. */
export const classifierSaveArgs = z.tuple([classifierProfileSchema])
/** `classifiers:remove`, `classifiers:test` and every `local-classifiers:*` action `(id)`. */
export const classifierIdArgs = z.tuple([zClassifierId])
/** `classifiers:set-screening` and `classifiers:set-background (id | null)`. */
export const classifierIdOrNullArgs = z.tuple([zClassifierId.nullable()])
