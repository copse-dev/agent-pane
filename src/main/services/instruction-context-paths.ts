import { patchTouchedPaths } from '@shared/patch/apply-patch.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

/** Built-in file tools whose path establishes directory-scoped instruction context. */
const PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read_file: ['path'],
  list_dir: ['path'],
  search_code: ['path'],
  search_codebase: ['path'],
  read_staged_diff: ['path'],
  write_file: ['path'],
  str_replace: ['path'],
  delete_file: ['path'],
  rename_file: ['from', 'to'],
  make_directory: ['path'],
}

/** Shared by parent and delegated executors so neither bypasses scoped rules. */
export function instructionContextPathsForTool(name: string, args: unknown): string[] {
  if (name === 'apply_patch') return isRecord(args) ? patchTouchedPaths(args['input']) : []
  const fields = Object.hasOwn(PATH_FIELDS, name) ? PATH_FIELDS[name] : undefined
  if (!fields || !isRecord(args)) return []
  return fields.flatMap((field) => {
    const value = args[field]
    return typeof value === 'string' && value.trim() ? [value] : []
  })
}
