import { z } from 'zod'
import { zPathString, zProjectId, zThreadId } from './ipc-guards.ts'

/** `(projectId, threadId, relPath)`, shared by the `fs:*` and `git:*` file channels. */
export const threadPathArgs = z.tuple([zProjectId, zThreadId, zPathString])
