import { z } from 'zod'
import { parseThreadValue } from '@copse/thread-store/thread-boundary.ts'

export const REMOTE_INTERFACE_VERSION = 1

/** Deliberately reviewed reads, never the complete preload/IPC manifest. */
export const REMOTE_READ_CHANNELS = [
  'settings:get',
  'settings:available-providers',
  'storage:get',
  'main-window:get-navigation',
  'workspace:get',
  'workspace:is-trusted',
  'settings:model-pricing',
  'threads:load-project',
  'threads:load-messages',
  'agent:running-thread-ids',
  'agent:suggest-next-step',
  'agent:suggest-follow-ups',
  'agent:estimate-context',
  'skills:list',
  'agents:list',
  'open-router:models',
  'remote-agent:models',
  'lm-studio:models',
  'lm-studio:model-info',
  'chat-gpt-plan:models',
  'usage:get-plan-usage',
] as const

/** No credentials, command/environment configuration, trust or permission settings. */
export const REMOTE_SETTING_KEYS = [
  'model',
  'layout',
  'autoPortraitRightPanel',
  'rightPanelPosition',
  'sidebarThreadSort',
  'sidebarThreadSortReverse',
  'sidebarThreadGroup',
  'openLinksInBuiltInBrowser',
  'theme',
  'fontSize',
  'animateAgentAvatars',
  'conciseThreadsEnabled',
  'uiScale',
  'uiAccentColor',
  'uiTintColor',
  'uiTintStrength',
  'developerMode',
  'appearanceDefaultsMigrated',
  'conciseThreadsDefaultMigrated',
  'nextStepSuggestionEnabled',
  'followUpSuggestionsEnabled',
  'reasoningLevel',
  'modelClassifierEnabled',
  'blockedModelMakers',
  'recentModels',
  'favoriteModels',
] as const

export const remoteReadSchema = z.strictObject({
  version: z.literal(REMOTE_INTERFACE_VERSION),
  channel: z.enum(REMOTE_READ_CHANNELS),
  args: z.array(z.unknown()).max(8),
})
export type RemoteRead = z.infer<typeof remoteReadSchema>

export function remoteReadAllowed(request: RemoteRead): boolean {
  if (request.channel === 'storage:get')
    return (
      request.args.length === 1 &&
      ['projects', 'projectGroups', 'dismissedOrphanThreadStores'].some(
        (key) => key === request.args[0],
      )
    )
  if (request.channel !== 'settings:get') return true
  const [key] = request.args
  return request.args.length === 1 && REMOTE_SETTING_KEYS.some((allowed) => allowed === key)
}

export const remoteThreadSchema = z.unknown().transform((value, context) => {
  const thread = parseThreadValue(value)
  if (thread)
    return {
      id: thread.id,
      title: thread.title,
      status: thread.status,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      usage: thread.usage,
      messages: thread.messages,
      ...(thread.model === undefined ? {} : { model: thread.model }),
      ...(thread.todos === undefined ? {} : { todos: thread.todos }),
      ...(thread.messagesLoaded === undefined ? {} : { messagesLoaded: thread.messagesLoaded }),
    }
  context.addIssue({ code: 'custom', message: 'Invalid remote thread' })
  return z.NEVER
})

export const remoteViewSchema = z.strictObject({
  projectId: z.string().regex(/^[\w-]{1,128}$/),
  threads: z.array(remoteThreadSchema).max(5000),
})
export type RemoteView = z.infer<typeof remoteViewSchema>
export const remoteStateSchema = z.strictObject({
  version: z.literal(REMOTE_INTERFACE_VERSION),
  sessionId: z.uuid(),
  revision: z.number().int().nonnegative(),
  views: z.array(remoteViewSchema).max(100),
})
export type RemoteState = z.infer<typeof remoteStateSchema>

export const remoteReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ id: z.uuid(), ok: z.literal(true), value: z.unknown().optional() }),
  z.strictObject({ id: z.uuid(), ok: z.literal(false), error: z.string().max(2000) }),
])
export type RemoteReply = z.infer<typeof remoteReplySchema>
