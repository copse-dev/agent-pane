import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideThreadWorktreePolicy,
  settledCheckoutMode,
  threadWorktreeBranchName,
  type WorktreePolicyInput,
} from './worktree-policy.ts'

const supported: WorktreePolicyInput = {
  choice: 'automatic',
  isLocal: true,
  isGitRepository: true,
  currentBranch: 'main',
  defaultBranch: 'main',
  isDirty: false,
  hasSubmodules: false,
}

describe('decideThreadWorktreePolicy', () => {
  it('pins the automatic policy matrix', () => {
    const rows: Array<{
      patch: Partial<WorktreePolicyInput>
      mode: 'shared' | 'worktree'
      reason: string
    }> = [
      { patch: {}, mode: 'worktree', reason: 'project-always' },
      { patch: { isDirty: true }, mode: 'worktree', reason: 'project-always' },
      // The previous thread leaving the project checkout on its own branch no
      // longer drags the next thread back into the shared checkout.
      {
        patch: { currentBranch: 'copse/previous-thread' },
        mode: 'worktree',
        reason: 'project-always',
      },
      { patch: { isGitRepository: false }, mode: 'shared', reason: 'not-git' },
      {
        patch: { defaultBranch: null },
        mode: 'shared',
        reason: 'default-branch-unresolved',
      },
      { patch: { currentBranch: null }, mode: 'shared', reason: 'detached-head' },
      { patch: { hasSubmodules: true }, mode: 'shared', reason: 'submodules-unsupported' },
      { patch: { isLocal: false }, mode: 'shared', reason: 'not-local' },
      { patch: { projectMode: 'always' }, mode: 'worktree', reason: 'project-always' },
      { patch: { projectMode: 'never' }, mode: 'shared', reason: 'project-disabled' },
    ]

    for (const row of rows) {
      const decision = decideThreadWorktreePolicy({ ...supported, ...row.patch })
      assert.equal(decision.checkoutMode, row.mode)
      assert.equal(decision.reason, row.reason)
    }
  })

  it('honors explicit shared and supported worktree choices', () => {
    assert.deepEqual(decideThreadWorktreePolicy({ ...supported, choice: 'shared' }), {
      checkoutMode: 'shared',
      reason: 'explicit-shared',
      seededFromDirtyProject: false,
    })
    assert.deepEqual(
      decideThreadWorktreePolicy({
        ...supported,
        choice: 'worktree',
        projectMode: 'never',
        isDirty: true,
      }),
      {
        checkoutMode: 'worktree',
        reason: 'explicit-worktree',
        seededFromDirtyProject: true,
      },
    )
  })

  it('only seeds dirty project work when the checkout shares the worktree base', () => {
    const onDefault = decideThreadWorktreePolicy({ ...supported, isDirty: true })
    assert.equal(onDefault.seededFromDirtyProject, true)

    // The edits belong to `feature`, but the worktree is cut from `main`.
    // Restoring them over it would mix two unrelated trees.
    const offDefault = decideThreadWorktreePolicy({
      ...supported,
      isDirty: true,
      currentBranch: 'feature',
    })
    assert.equal(offDefault.checkoutMode, 'worktree')
    assert.equal(offDefault.seededFromDirtyProject, false)
  })

  it('blocks an explicit worktree choice in unsupported repositories', () => {
    const decision = decideThreadWorktreePolicy({
      ...supported,
      choice: 'worktree',
      hasSubmodules: true,
    })
    assert.deepEqual(decision, {
      checkoutMode: 'blocked',
      reason: 'submodules-unsupported',
      seededFromDirtyProject: false,
    })
  })
})

describe('threadWorktreeBranchName', () => {
  it('uses a prompt slug, stable thread suffix, and deterministic collision suffix', () => {
    assert.equal(
      threadWorktreeBranchName('Fix the flicker, please!', 'thread-a1b2'),
      'copse/fix-the-flicker-please-ada1b2',
    )
    assert.equal(
      threadWorktreeBranchName('Fix the flicker, please!', 'thread-a1b2', 1),
      'copse/fix-the-flicker-please-ada1b2-2',
    )
  })

  it('falls back safely when prompt and id have no slug characters', () => {
    assert.equal(threadWorktreeBranchName('✨', '---'), 'copse/thread-thread')
  })
})

type Inspection = Omit<WorktreePolicyInput, 'choice' | 'projectMode'>

/** Every repository shape the policy can be handed, as a cross product. */
const INSPECTIONS: Inspection[] = ((): Inspection[] => {
  const out: Inspection[] = []
  for (const isLocal of [true, false])
    for (const isGitRepository of [true, false])
      for (const currentBranch of ['main', 'feature', null])
        for (const defaultBranch of ['main', null])
          for (const isDirty of [true, false])
            for (const hasSubmodules of [true, false])
              out.push({
                isLocal,
                isGitRepository,
                currentBranch,
                defaultBranch,
                isDirty,
                hasSubmodules,
              })
  return out
})()

const CHOICES: Array<WorktreePolicyInput['choice']> = [undefined, 'automatic', 'shared', 'worktree']
const PROJECT_MODES: Array<WorktreePolicyInput['projectMode']> = [
  undefined,
  'from-default-branch',
  'always',
  'never',
]

/** The policy's own view of a (choice, projectMode) pair, before any inspection. */
function settledFor(
  choice: WorktreePolicyInput['choice'],
  projectMode: WorktreePolicyInput['projectMode'],
): ReturnType<typeof settledCheckoutMode> {
  return settledCheckoutMode({
    ...(choice !== undefined ? { choice } : {}),
    ...(projectMode !== undefined ? { projectMode } : {}),
  })
}

/** Build an input without writing `undefined` into an optional property. */
function policyInput(
  choice: WorktreePolicyInput['choice'],
  projectMode: WorktreePolicyInput['projectMode'],
  inspection: Inspection,
): WorktreePolicyInput {
  return {
    ...(choice !== undefined ? { choice } : {}),
    ...(projectMode !== undefined ? { projectMode } : {}),
    ...inspection,
  }
}

// `settledCheckoutMode` lets the checkout preview skip inspecting the repository
// (four Git queries, one of which can reach the network) when the answer cannot
// depend on what it would find. That shortcut is only sound while the two stay
// in lockstep, and nothing else would catch them drifting apart — so pin it from
// both sides: never wrong when it settles, never needlessly shy when it doesn't.
describe('settledCheckoutMode', () => {
  it('matches decideThreadWorktreePolicy for every repository shape when it settles', () => {
    for (const choice of CHOICES) {
      for (const projectMode of PROJECT_MODES) {
        const settled = settledFor(choice, projectMode)
        if (settled === null) continue
        for (const inspection of INSPECTIONS) {
          const actual = decideThreadWorktreePolicy(
            policyInput(choice, projectMode, inspection),
          ).checkoutMode
          assert.equal(
            actual,
            settled,
            `choice=${String(choice)} projectMode=${String(projectMode)} ${JSON.stringify(inspection)}`,
          )
        }
      }
    }
  })

  it('declines to settle exactly the pairs whose mode depends on the repository', () => {
    for (const choice of CHOICES) {
      for (const projectMode of PROJECT_MODES) {
        if (settledFor(choice, projectMode) !== null) continue
        const modes = new Set(
          INSPECTIONS.map(
            (inspection) =>
              decideThreadWorktreePolicy(policyInput(choice, projectMode, inspection)).checkoutMode,
          ),
        )
        assert.ok(
          modes.size > 1,
          `choice=${String(choice)} projectMode=${String(projectMode)} always yields ${[...modes].join()} — it could be settled without inspecting`,
        )
      }
    }
  })
})
