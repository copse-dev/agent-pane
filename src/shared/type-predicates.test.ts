import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RIGHT_PANEL_POSITIONS,
  THEME_PREFERENCES,
  isRightPanelPosition,
  isThemePreference,
} from './types/state.ts'
import { REMOTE_AGENT_PROVIDERS, isRemoteAgentProvider } from './remote-agent.ts'
import { ROADMAP_REVIEW_VERDICTS, isRoadmapReviewVerdict } from './roadmap/review.ts'
import { ROADMAP_COMPLEXITIES, isRoadmapComplexity } from './roadmap/complexity.ts'
import { ROADMAP_FITS, isRoadmapFit } from './roadmap/fit.ts'
import { APP_ICON_VARIANTS, isAppIconVariant } from './app-icon-variants.ts'
import { CURSOR_PERMISSION_HOOK_EVENTS, isCursorPermissionHookEvent } from './types/cursor-hooks.ts'
import type { CursorHookEvent } from './types/cursor-hooks.ts'
import { RemoteAgentStreamError, isRemoteAgentStreamError } from './remote-agent-stream.ts'
import { isRecord, matchesFallbackType } from './unknown-value.ts'

/**
 * Contract tests for the exported type predicates.
 *
 * A predicate is the one assertion TypeScript never checks: nothing verifies
 * that `x is T` is actually implied by the body, so `return true` type-checks.
 * With `any`, `!` and the `no-unsafe-type-assertion` baseline all at zero,
 * these are the widest remaining unverified claims in the codebase (#1330).
 *
 * The membership predicates are all backed by a `const` tuple, so the cases are
 * **derived from that tuple** rather than written out. Adding a member extends
 * the test automatically, and a predicate that stops agreeing with its own
 * source list fails here — which is the drift this is really guarding against.
 */

/** Values no string-membership predicate should ever accept. */
const NON_MEMBERS: readonly unknown[] = [
  undefined,
  null,
  '',
  ' ',
  0,
  1,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  {},
  [],
  ['low'],
  { toString: (): string => 'low' },
  (): string => 'low',
  // Prototype keys — a predicate backed by a plain object lookup rather than a
  // list would wrongly accept these.
  '__proto__',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
]

/** Near-misses derived from a real member: the mistakes that actually happen. */
function nearMisses(member: string): readonly string[] {
  return [
    member.toUpperCase(),
    ` ${member}`,
    `${member} `,
    `${member}x`,
    member.slice(0, -1),
    `${member}\n`,
  ].filter((v) => v !== member)
}

const MEMBERSHIP_PREDICATES: ReadonlyArray<{
  readonly label: string
  readonly predicate: (value: unknown) => boolean
  readonly members: readonly string[]
}> = [
  {
    label: 'isRightPanelPosition',
    predicate: isRightPanelPosition,
    members: RIGHT_PANEL_POSITIONS,
  },
  { label: 'isThemePreference', predicate: isThemePreference, members: THEME_PREFERENCES },
  {
    label: 'isRemoteAgentProvider',
    predicate: isRemoteAgentProvider,
    members: REMOTE_AGENT_PROVIDERS,
  },
  {
    label: 'isRoadmapReviewVerdict',
    predicate: isRoadmapReviewVerdict,
    members: ROADMAP_REVIEW_VERDICTS,
  },
  { label: 'isRoadmapComplexity', predicate: isRoadmapComplexity, members: ROADMAP_COMPLEXITIES },
  { label: 'isRoadmapFit', predicate: isRoadmapFit, members: ROADMAP_FITS },
  { label: 'isAppIconVariant', predicate: isAppIconVariant, members: APP_ICON_VARIANTS },
]

describe('membership type predicates', () => {
  for (const { label, predicate, members } of MEMBERSHIP_PREDICATES) {
    describe(label, () => {
      it('has a non-empty source list to check against', () => {
        // Guards the whole table: an empty list would make every other
        // assertion below vacuously pass.
        assert.ok(members.length > 0, `${label} has no members to test`)
      })

      it('accepts every member of its own source list', () => {
        for (const member of members) {
          assert.equal(predicate(member), true, `${label} rejected its own member "${member}"`)
        }
      })

      it('rejects non-members', () => {
        for (const value of NON_MEMBERS) {
          assert.equal(predicate(value), false, `${label} accepted ${JSON.stringify(value)}`)
        }
      })

      it('rejects near-misses of its members', () => {
        for (const member of members) {
          for (const miss of nearMisses(member)) {
            assert.equal(predicate(miss), false, `${label} accepted near-miss "${miss}"`)
          }
        }
      })
    })
  }
})

describe('isCursorPermissionHookEvent', () => {
  // Typed to take a CursorHookEvent, so the interesting axis is which events it
  // selects, not what junk it rejects.
  it('accepts exactly the permission-gating events', () => {
    for (const event of CURSOR_PERMISSION_HOOK_EVENTS) {
      assert.equal(isCursorPermissionHookEvent(event), true, `rejected ${event}`)
    }
  })

  it('rejects hook events outside the permission set', () => {
    const nonPermission: readonly CursorHookEvent[] = ['afterFileEdit', 'stop']
    for (const event of nonPermission) {
      assert.equal(isCursorPermissionHookEvent(event), false, `accepted ${event}`)
    }
  })
})

describe('isRemoteAgentStreamError', () => {
  it('accepts the error class it names', () => {
    assert.equal(
      isRemoteAgentStreamError(new RemoteAgentStreamError('rate_limit', 'slow down')),
      true,
    )
  })

  it('rejects other errors and error-shaped values', () => {
    assert.equal(isRemoteAgentStreamError(new Error('boom')), false)
    assert.equal(isRemoteAgentStreamError(new TypeError('boom')), false)
    // Structurally similar but not an instance — the case a duck-typed check
    // would wrongly accept.
    assert.equal(isRemoteAgentStreamError({ code: 'rate_limit', fatal: true, message: 'x' }), false)
    assert.equal(isRemoteAgentStreamError(null), false)
    assert.equal(isRemoteAgentStreamError('RemoteAgentStreamError'), false)
  })
})

describe('isRecord', () => {
  it('accepts plain objects', () => {
    assert.equal(isRecord({}), true)
    assert.equal(isRecord({ a: 1 }), true)
    // `Object.create` returns `any`; widening to `unknown` needs no assertion.
    const nullPrototype: unknown = Object.create(null)
    assert.equal(isRecord(nullPrototype), true)
  })

  it('rejects null, arrays and primitives', () => {
    for (const value of [null, undefined, [], [1], '', 'x', 0, 1, true, false, Number.NaN]) {
      assert.equal(isRecord(value), false, `accepted ${JSON.stringify(value)}`)
    }
  })

  it('accepts class instances and boxed objects (documents the actual contract)', () => {
    // `isRecord` is a typeof/null/array check, not a plain-object check. These
    // pass, and callers rely on that for error objects — pinning it so the
    // behaviour cannot change silently.
    assert.equal(isRecord(new Error('x')), true)
    assert.equal(isRecord(new Date()), true)
  })
})

describe('matchesFallbackType', () => {
  it('matches primitives by typeof', () => {
    assert.equal(matchesFallbackType('x', 'fallback'), true)
    assert.equal(matchesFallbackType(1, 0), true)
    assert.equal(matchesFallbackType(true, false), true)
    assert.equal(matchesFallbackType('x', 0), false)
    assert.equal(matchesFallbackType(1, 'fallback'), false)
  })

  it('matches arrays only against array fallbacks', () => {
    assert.equal(matchesFallbackType([1], []), true)
    assert.equal(matchesFallbackType({}, []), false)
    assert.equal(matchesFallbackType([], {}), false)
  })

  it('matches records only against record fallbacks', () => {
    assert.equal(matchesFallbackType({ a: 1 }, {}), true)
    assert.equal(matchesFallbackType(null, {}), false)
  })

  it('treats a null fallback as matching only null', () => {
    assert.equal(matchesFallbackType(null, null), true)
    assert.equal(matchesFallbackType({}, null), false)
    assert.equal(matchesFallbackType(undefined, null), false)
  })
})
