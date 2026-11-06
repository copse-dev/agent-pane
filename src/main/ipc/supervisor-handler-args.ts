import { z } from 'zod'
import { zNonEmptyString, zProjectId, zThreadId } from './ipc-guards.ts'

// Argument schemas for the `supervisor:*` and `background-tasks:logs` channels.
// They live apart from the handlers, which import Electron, so the parity tests
// in `ipc-handler.test.ts` check the schemas the channels use.

const zSupervisorId = zNonEmptyString.max(256)

/** `supervisor:list (projectId)`. */
export const supervisorListArgs = z.tuple([zSupervisorId])
/** `supervisor:cancel (projectId, taskId)`, parsed one argument at a time. */
export const supervisorCancelArgs = z.tuple([zSupervisorId, zSupervisorId])
/** `supervisor:get` and `supervisor:resume (projectId, threadId, taskId)`, parsed one argument at a time. */
export const supervisorTaskArgs = z.tuple([zSupervisorId, zSupervisorId, zSupervisorId])
/** `background-tasks:logs (projectId, threadId, taskId)`, parsed as one tuple. */
export const backgroundTaskLogsArgs = z.tuple([zProjectId, zThreadId, zNonEmptyString.max(256)])
