import { execFileSync } from 'node:child_process'
import { E2E_GIT_BRANCH, writeE2eEnv } from './e2e-env.ts'
import { seedStableWorkspace } from './seed-config.ts'

/** Exercise branch IPC against a real, small checkout instead of this PR's repository. */
export function seedBranchWorkspace(): string {
  const root = seedStableWorkspace()
  execFileSync('git', ['checkout', '-q', '-b', E2E_GIT_BRANCH], { cwd: root })
  // Keep the same fixed branch labels as other captures, but resolve them from Git.
  writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: undefined })
  return root
}
