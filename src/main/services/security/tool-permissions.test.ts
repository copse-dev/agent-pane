import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { z } from 'zod'
import type { McpServerStatus } from '@shared/types/mcp.ts'
import { mcpToolName } from '../mcp/mcp-config.ts'
import { setCustomToolRequiresApprovalForTests } from '../mcp/custom-tools-registry.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { ToolRegistry } from '../tool-registry.ts'
import {
  clearMcpToolPermissionTargets,
  copseToolPermissionId,
  listToolPermissionCatalog,
  mcpToolPermissionId,
  migrateLegacyMcpToolGrants,
  registerMcpToolPermissionTarget,
  resetToolPermissions,
  resolveToolPermission,
  setToolPermissionForExecution,
  updateToolPermissions,
  type McpPermissionTarget,
} from './tool-permissions.ts'

const OVERRIDES_KEY = 'toolPermissionOverrides'
const LEGACY_GRANTS_KEY = 'mcp-remembered-grants'

function registerTool(
  registry: ToolRegistry,
  name: string,
  description = `${name} description`,
): void {
  registry.register({
    name,
    description,
    parameters: z.object({}),
    execute: async () => 'ok',
  })
}

function connectedStatus(
  name: string,
  tools: string[],
  source = `/workspace/${name}.json`,
): McpServerStatus {
  return {
    name,
    transport: 'stdio',
    state: 'connected',
    toolCount: tools.length,
    tools,
    source,
    origin: 'project',
    originDetail: '.mcp.json',
    userEnabled: true,
    configDisabled: false,
  }
}

function overrides(): Record<string, 'allow' | 'ask' | 'block'> {
  return getSetting(OVERRIDES_KEY, {})
}

describe('tool permissions', () => {
  beforeEach(async () => {
    clearMcpToolPermissionTargets()
    setCustomToolRequiresApprovalForTests('custom__deploy', false)
    storageSet(LEGACY_GRANTS_KEY, [])
    await setSetting(OVERRIDES_KEY, {})
  })

  it('persists an explicit override and reports it in a fresh catalog', async () => {
    const registry = new ToolRegistry()
    registerTool(registry, 'read_file')
    const id = copseToolPermissionId('read_file')

    await updateToolPermissions(registry, [], { toolIds: [id], policy: 'ask' })

    assert.deepEqual(overrides(), { [id]: 'ask' })
    const tool = listToolPermissionCatalog(registry, []).groups[0]?.tools[0]
    assert.ok(tool)
    assert.equal(tool.id, id)
    assert.equal(tool.policy, 'ask')
    assert.equal(tool.overridden, true)
  })

  it('migrates only uniquely registered legacy MCP grants without overwriting an override', async () => {
    const target: McpPermissionTarget = {
      serverName: 'mail',
      toolName: 'list',
      origin: 'user',
      source: '/user/mcp.json',
    }
    const id = registerMcpToolPermissionTarget(target)
    const executionName = mcpToolName(target.serverName, target.toolName)
    await setSetting(OVERRIDES_KEY, { [id]: 'block' })
    storageSet(LEGACY_GRANTS_KEY, [executionName, 'mcp__missing__tool'])

    await migrateLegacyMcpToolGrants()

    assert.deepEqual(overrides(), { [id]: 'block' })
    assert.deepEqual(storageGet(LEGACY_GRANTS_KEY), ['mcp__missing__tool'])
  })

  it('migrates a unique legacy grant to an allow override', async () => {
    const target: McpPermissionTarget = {
      serverName: 'calendar',
      toolName: 'events',
      origin: 'plugin',
      source: '/plugins/calendar/mcp.json',
      originDetail: 'Calendar plugin',
    }
    const id = registerMcpToolPermissionTarget(target)
    const executionName = mcpToolName(target.serverName, target.toolName)
    storageSet(LEGACY_GRANTS_KEY, [executionName])

    await migrateLegacyMcpToolGrants()

    assert.deepEqual(overrides(), { [id]: 'allow' })
    assert.deepEqual(storageGet(LEGACY_GRANTS_KEY), [])
    assert.deepEqual(resolveToolPermission(executionName), { id, policy: 'allow' })
  })

  it('uses source-scoped stable identities and fails closed on execution-name collisions', async () => {
    const first: McpPermissionTarget = {
      serverName: 'a__b',
      toolName: 'c',
      origin: 'project',
      source: '/workspace/one/.mcp.json',
    }
    const second: McpPermissionTarget = {
      serverName: 'a',
      toolName: 'b__c',
      origin: 'project',
      source: '/workspace/two/.mcp.json',
    }
    const firstId = registerMcpToolPermissionTarget(first)
    const secondId = registerMcpToolPermissionTarget(second)
    assert.notEqual(firstId, secondId)
    assert.notEqual(
      mcpToolPermissionId({ ...first, source: '/workspace/three/.mcp.json' }),
      firstId,
    )
    await setSetting(OVERRIDES_KEY, { [firstId]: 'allow', [secondId]: 'block' })

    const collidingExecutionName = mcpToolName(first.serverName, first.toolName)
    assert.equal(collidingExecutionName, mcpToolName(second.serverName, second.toolName))
    assert.equal(resolveToolPermission(collidingExecutionName), null)
    assert.equal(await setToolPermissionForExecution(collidingExecutionName, 'allow'), false)
  })

  it('bulk updates only explicit known IDs and does not grant subsequently discovered tools', async () => {
    const registry = new ToolRegistry()
    registerTool(registry, 'read_file')
    registerTool(registry, 'write_file')
    const readId = copseToolPermissionId('read_file')
    const writeId = copseToolPermissionId('write_file')

    await updateToolPermissions(registry, [], {
      toolIds: [readId, readId, 'copse:unknown'],
      policy: 'block',
    })

    assert.deepEqual(overrides(), { [readId]: 'block' })
    registerTool(registry, 'new_tool')
    const catalog = listToolPermissionCatalog(registry, [])
    const tools = catalog.groups[0]?.tools ?? []
    const writeTool = tools.find((tool) => tool.id === writeId)
    const newTool = tools.find((tool) => tool.id === copseToolPermissionId('new_tool'))
    assert.ok(writeTool)
    assert.ok(newTool)
    assert.equal(writeTool.overridden, false)
    assert.equal(newTool.overridden, false)
  })

  it('resets only the requested explicit IDs', async () => {
    const registry = new ToolRegistry()
    registerTool(registry, 'read_file')
    registerTool(registry, 'write_file')
    const readId = copseToolPermissionId('read_file')
    const writeId = copseToolPermissionId('write_file')
    await setSetting(OVERRIDES_KEY, { [readId]: 'block', [writeId]: 'ask' })

    const catalog = await resetToolPermissions(registry, [], {
      toolIds: [readId, 'copse:unknown'],
    })

    assert.deepEqual(overrides(), { [writeId]: 'ask' })
    const readTool = catalog.groups[0]?.tools.find((tool) => tool.id === readId)
    assert.ok(readTool)
    assert.equal(readTool.overridden, false)
    assert.equal(readTool.policy, readTool.defaultPolicy)
  })

  it('serializes concurrent updates without dropping overrides', async () => {
    const registry = new ToolRegistry()
    for (const name of ['read_file', 'write_file', 'list_dir']) registerTool(registry, name)
    const ids = ['read_file', 'write_file', 'list_dir'].map(copseToolPermissionId)

    await Promise.all(
      ids.map((id, index) =>
        updateToolPermissions(registry, [], {
          toolIds: [id],
          policy: index === 0 ? 'ask' : 'block',
        }),
      ),
    )

    assert.deepEqual(overrides(), {
      [ids[0] ?? '']: 'ask',
      [ids[1] ?? '']: 'block',
      [ids[2] ?? '']: 'block',
    })
  })

  it('exposes and enforces catalog restrictions for tools that must always ask', async () => {
    const registry = new ToolRegistry()
    registerTool(registry, 'prepare_worktree')
    const id = copseToolPermissionId('prepare_worktree')

    const initial = listToolPermissionCatalog(registry, []).groups[0]?.tools[0]
    assert.ok(initial)
    assert.deepEqual(initial.disabledPolicies, ['allow'])
    assert.match(initial.disabledReason ?? '', /every invocation/u)

    const afterAllow = await updateToolPermissions(registry, [], {
      toolIds: [id],
      policy: 'allow',
    })
    assert.deepEqual(overrides(), {})
    assert.equal(afterAllow.groups[0]?.tools[0]?.overridden, false)

    await updateToolPermissions(registry, [], { toolIds: [id], policy: 'block' })
    assert.deepEqual(overrides(), { [id]: 'block' })
  })

  it('requires approval for pull-request creation and rejects an allow update', async () => {
    const registry = new ToolRegistry()
    registerTool(registry, 'gh_pr_create')
    const id = copseToolPermissionId('gh_pr_create')
    const initial = listToolPermissionCatalog(registry, []).groups[0]?.tools[0]

    assert.ok(initial)
    assert.equal(initial.defaultPolicy, 'ask')
    assert.deepEqual(initial.disabledPolicies, ['allow'])
    assert.match(initial.disabledReason ?? '', /remote state/u)

    await setSetting(OVERRIDES_KEY, { [id]: 'allow' })
    const hardened = listToolPermissionCatalog(registry, []).groups[0]?.tools[0]
    assert.ok(hardened)
    assert.equal(hardened.policy, 'ask')
    assert.deepEqual(resolveToolPermission('gh_pr_create'), { id, policy: 'ask' })
    await setSetting(OVERRIDES_KEY, {})

    await updateToolPermissions(registry, [], { toolIds: [id], policy: 'allow' })
    assert.deepEqual(overrides(), {})
    assert.equal(await setToolPermissionForExecution('gh_pr_create', 'allow'), false)
  })

  it('defaults custom tools to ask and disables allow when the tool requires approval', async () => {
    const registry = new ToolRegistry()
    registerTool(registry, 'custom__lookup')
    registerTool(registry, 'custom__deploy')
    setCustomToolRequiresApprovalForTests('custom__deploy', true)
    const lookupId = copseToolPermissionId('custom__lookup')
    const deployId = copseToolPermissionId('custom__deploy')
    const tools = listToolPermissionCatalog(registry, []).groups[0]?.tools ?? []
    const lookup = tools.find((tool) => tool.id === lookupId)
    const deploy = tools.find((tool) => tool.id === deployId)

    assert.ok(lookup)
    assert.ok(deploy)
    assert.equal(lookup.defaultPolicy, 'ask')
    assert.equal(lookup.disabledPolicies, undefined)
    assert.equal(deploy.defaultPolicy, 'ask')
    assert.deepEqual(deploy.disabledPolicies, ['allow'])
    assert.match(deploy.disabledReason ?? '', /every invocation/u)

    await updateToolPermissions(registry, [], {
      toolIds: [lookupId, deployId],
      policy: 'allow',
    })
    assert.deepEqual(overrides(), { [lookupId]: 'allow' })
    assert.equal(await setToolPermissionForExecution('custom__deploy', 'allow'), false)
  })

  it('builds MCP catalog entries from status metadata without connecting a server', () => {
    const registry = new ToolRegistry()
    const status = connectedStatus('mail', ['list_messages'])
    const executionName = mcpToolName('mail', 'list_messages')
    registerTool(registry, executionName, '[MCP:mail] List messages in the inbox')

    const group = listToolPermissionCatalog(registry, [status]).groups[0]
    assert.ok(group)
    assert.equal(group.kind, 'mcp')
    assert.equal(group.origin, 'project')
    assert.equal(group.status, 'connected')
    const tool = group.tools[0]
    assert.ok(tool)
    assert.equal(tool.description, 'List messages in the inbox')
    assert.equal(tool.defaultPolicy, 'ask')
  })
})
