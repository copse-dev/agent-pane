import { isAbsolute } from 'node:path'
import { z } from 'zod'

/** Persist only explicitly chosen absolute directories; no permission is granted. */
export const skillRootsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((path) => isAbsolute(path) && !path.includes('\0'), 'Use an absolute folder path'),
  )
  .max(64)
  .transform((roots) => [...new Set(roots)])
