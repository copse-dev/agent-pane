// Contract test: the `copse.background-tasks` first-party pack (issue #1190).
//
// Landing invariants pinned here (mirrors advisor-strategy-pack.test.ts, plus
// the permission / sandbox relaxation this pack DECLARES):
//
// 1. **The pack is registered** in `FIRST_PARTY_PACKS` with id
//    `copse.background-tasks` and trust `first-party`, and its manifest +
//    contributions declare the `run_background` native tool AND the
//    `loopback-bind` permission relaxation.
// 2. **No double-registration.** Historically the tool was gated by the
//    top-level `backgroundTasksEnabled` boolean, which is deleted in the same
//    change (`registry-bootstrap.ts` no longer reads it; the
//    `settings-writable.ts` schema no longer accepts it) — the pack registry is
//    the single source of truth. `run_background` appears exactly once in
//    `activeToolNames()` and `loopback-bind` exactly once in
//    `activePermissions()`.
// 3. **Atomicity of disable.** One flag flip drops the tool from
//    `activeToolNames()` AND revokes the permission from
//    `isPermissionDeclared('loopback-bind')`, so the permission-gate stops
//    honouring the loopback relaxation the moment the pack is disabled.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  backgroundTasksPack,
  BACKGROUND_TASKS_PACK_ID,
  BACKGROUND_TASKS_TOOL_NAME,
  LOOPBACK_BIND_PERMISSION,
} from './background-tasks-pack.ts'
import { createFirstPartyPackRegistry, FIRST_PARTY_PACKS } from './first-party-packs.ts'

describe('copse.background-tasks pack', () => {
  it('is registered as a stable first-party pack', () => {
    assert.equal(backgroundTasksPack.id, BACKGROUND_TASKS_PACK_ID)
    assert.equal(backgroundTasksPack.trust, 'first-party')
    assert.equal(backgroundTasksPack.manifest.stability, 'stable')
    assert.ok(
      FIRST_PARTY_PACKS.some((pack) => pack.id === BACKGROUND_TASKS_PACK_ID),
      'background-tasks pack must be part of the shipped first-party pack list',
    )
  })

  it('declares the run_background tool, the loopback-bind permission, and no hook contributions', () => {
    assert.deepEqual(backgroundTasksPack.manifest.tools?.native, [BACKGROUND_TASKS_TOOL_NAME])
    assert.deepEqual(backgroundTasksPack.contributions.toolNames, [BACKGROUND_TASKS_TOOL_NAME])

    // The permission / sandbox relaxation the pack DECLARES (issue #1190).
    assert.deepEqual(backgroundTasksPack.manifest.permissions, [
      {
        name: LOOPBACK_BIND_PERMISSION,
        title: 'Bind a loopback port',
        description: backgroundTasksPack.manifest.permissions?.[0]?.description,
        scope: 'project',
      },
    ])
    const [contributedPermission] = backgroundTasksPack.contributions.permissions
    assert.ok(contributedPermission)
    assert.equal(contributedPermission.name, LOOPBACK_BIND_PERMISSION)
    assert.equal(contributedPermission.scope, 'project')
    assert.equal(LOOPBACK_BIND_PERMISSION, 'loopback-bind')

    // The tool is an inline registration site, not a static hook, so the pack
    // contributes nothing to the function-hook / prompt / ui lists.
    assert.deepEqual(backgroundTasksPack.contributions.blockingHooks, [])
    assert.deepEqual(backgroundTasksPack.contributions.asyncHooks, [])
    assert.deepEqual(backgroundTasksPack.contributions.promptBlocks, [])
    assert.deepEqual(backgroundTasksPack.contributions.uiContributions, [])
    assert.deepEqual(backgroundTasksPack.contributions.capabilities, [])
  })

  it('contributes run_background and loopback-bind exactly once across all first-party packs', () => {
    const toolOccurrences = FIRST_PARTY_PACKS.flatMap(
      (pack) => pack.contributions.toolNames,
    ).filter((name) => name === BACKGROUND_TASKS_TOOL_NAME)
    assert.equal(toolOccurrences.length, 1)

    const permOccurrences = FIRST_PARTY_PACKS.flatMap((pack) =>
      pack.contributions.permissions.map((p) => p.name),
    ).filter((name) => name === LOOPBACK_BIND_PERMISSION)
    assert.equal(permOccurrences.length, 1)
  })

  it('atomically drops the tool AND revokes the loopback-bind permission on disable', () => {
    const registry = createFirstPartyPackRegistry()
    assert.equal(registry.isEnabled(BACKGROUND_TASKS_PACK_ID), true)
    assert.ok(registry.activeToolNames().includes(BACKGROUND_TASKS_TOOL_NAME))
    assert.equal(registry.isPermissionDeclared(LOOPBACK_BIND_PERMISSION), true)

    registry.disable(BACKGROUND_TASKS_PACK_ID)
    assert.equal(registry.isEnabled(BACKGROUND_TASKS_PACK_ID), false)
    assert.ok(
      !registry.activeToolNames().includes(BACKGROUND_TASKS_TOOL_NAME),
      'run_background must leave activeToolNames() the moment the pack is disabled',
    )
    assert.equal(
      registry.isPermissionDeclared(LOOPBACK_BIND_PERMISSION),
      false,
      'loopback-bind must be revoked in the same flag flip that drops the tool',
    )

    registry.enable(BACKGROUND_TASKS_PACK_ID)
    assert.ok(registry.activeToolNames().includes(BACKGROUND_TASKS_TOOL_NAME))
    assert.equal(registry.isPermissionDeclared(LOOPBACK_BIND_PERMISSION), true)
  })
})
