import { isNonEmptyString } from '@shared/nullish.ts'

/** Join truthy class-name fragments. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(isNonEmptyString).join(' ')
}
