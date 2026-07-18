import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

// First-party skills that ship with Copse itself (e.g. `/checkup`). They live in
// the repo under `assets/skills/<name>/SKILL.md`, which the build copies to
// `dist/assets/skills` (see scripts/build.mts / scripts/dev.mts), so a single
// path resolved from the bundled main entry works in both dev and packaged runs.
// Unlike the fetched Cursor bundled skills, these are committed and always
// present, giving every workspace a built-in `/checkup` command.

let builtinRootOverride: string | null | undefined

/** Resolve the directory that holds first-party SKILL.md folders, or null. */
export function getBuiltinSkillsRoot(): string | null {
  if (builtinRootOverride !== undefined) return builtinRootOverride

  const candidates = [
    join(__dirname, '../assets/skills'), // dist/main -> dist/assets/skills (dev + packaged)
    join(__dirname, '../../assets/skills'), // repo root fallback (unbundled ts-run)
  ]
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK)
      return candidate
    } catch {
      // try next candidate
    }
  }
  return null
}

/** Test hook — pin the builtin skills root (null disables discovery). */
export function setBuiltinSkillsRootForTest(root: string | null): void {
  builtinRootOverride = root
}

/** Test hook — restore real resolution. */
export function resetBuiltinSkillsRootForTest(): void {
  builtinRootOverride = undefined
}
