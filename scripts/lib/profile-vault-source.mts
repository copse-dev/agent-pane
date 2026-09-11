import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function profileVaultSourceHash(root: string): string {
  const hash = createHash('sha256')
  for (const source of ['main.swift', 'policy.swift']) {
    hash
      .update(source)
      .update('\0')
      .update(readFileSync(join(root, 'native/profile-vault', source)))
  }
  return hash.digest('hex')
}
