import { dirname, resolve } from 'node:path'
import type { SkillMetadata } from '@shared/types/skills.ts'

/** Identity check only: this never grants activation or changes registry precedence. */
export function isSkillDependencyInScope(parent: SkillMetadata, candidate: SkillMetadata): boolean {
  return (
    parent.source === candidate.source &&
    parent.plugin === candidate.plugin &&
    dirname(resolve(parent.skillRoot)) === dirname(resolve(candidate.skillRoot))
  )
}
