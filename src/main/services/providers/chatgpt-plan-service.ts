import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { runSerialized } from '../storage/write-queue.ts'
import { getExplicitSettingsProfile } from '../storage/settings-context.ts'
import {
  authorizeChatGpt,
  CHATGPT_RESOURCE,
  refreshChatGptTokens,
  revokeChatGptTokens,
  type ChatGptOAuthDependencies,
} from './chatgpt-plan-oauth.ts'
import {
  createChatGptPlanStore,
  chatGptPlanStatus,
  type ChatGptPlanStore,
  type ChatGptRegistration,
} from './chatgpt-plan-store.ts'
import type { ChatGptPlanModel, ChatGptPlanStatus } from '@shared/types/chatgpt-plan.ts'

const modelCatalogSchema = z.object({
  models: z.array(
    z.object({ slug: z.string().min(1), display_name: z.string(), visibility: z.string() }),
  ),
})

export class ChatGptPlanService {
  private pending: AbortController | null = null
  private readonly queueKey = `chatgpt-plan:${Math.random().toString(36)}`
  private readonly catalogs = new Map<string, { expiresAt: number; models: ChatGptPlanModel[] }>()
  private readonly requests = new Map<string, AbortController>()

  private readonly store: ChatGptPlanStore
  private readonly dependencies: ChatGptOAuthDependencies

  constructor(store: ChatGptPlanStore, dependencies: ChatGptOAuthDependencies) {
    this.store = store
    this.dependencies = dependencies
  }

  status(): ChatGptPlanStatus {
    return chatGptPlanStatus(this.store.read())
  }

  async signIn(clientId?: string): Promise<ChatGptPlanStatus> {
    if (this.pending) throw new Error('A ChatGPT sign-in is already in progress.')
    const controller = new AbortController()
    this.pending = controller
    try {
      return await runSerialized(this.queueKey, async () => {
        const state = this.store.read()
        const existing = clientId
          ? state.accounts.find((entry) => entry.clientId === clientId)
          : undefined
        if (clientId && !existing) throw new Error('Unknown ChatGPT account.')
        // Persist the stable host identifier before the first authorization.
        this.store.write(state)
        const result = await authorizeChatGpt(
          {
            hostId: state.hostId,
            ...(clientId ? { clientId } : {}),
            ...(existing?.credentials ? { idTokenHint: existing.credentials.idToken } : {}),
            signal: controller.signal,
            onRegistration: (issued) => {
              if (!state.accounts.some((entry) => entry.clientId === issued)) {
                state.accounts.push({
                  clientId: issued,
                  subject: null,
                  label: 'Incomplete ChatGPT connection',
                  credentials: null,
                })
                this.store.write(state)
              }
            },
          },
          this.dependencies,
        )
        const registered = state.accounts.find((entry) => entry.clientId === result.clientId)
        if (registered?.subject && registered.subject !== result.subject)
          throw new Error('ChatGPT signed in to a different account. Add it as a new connection.')
        const { access_token, refresh_token, id_token, expires_in, scope } = result.tokens
        if (!refresh_token || !id_token)
          throw new Error('ChatGPT did not issue renewable credentials.')
        const account: ChatGptRegistration = {
          clientId: result.clientId,
          subject: result.subject,
          label: result.label,
          credentials: {
            accessToken: access_token,
            refreshToken: refresh_token,
            idToken: id_token,
            expiresAt: Date.now() + expires_in * 1000,
            scopes: scope?.split(/\s+/).filter(Boolean) ?? [],
          },
        }
        state.accounts = state.accounts.map((entry) =>
          entry.clientId === account.clientId ? account : entry,
        )
        state.activeClientId = account.clientId
        this.store.write(state)
        this.catalogs.delete(account.clientId)
        this.requests.get(account.clientId)?.abort()
        this.requests.delete(account.clientId)
        return chatGptPlanStatus(state)
      })
    } finally {
      this.pending = null
    }
  }

  cancelSignIn(): void {
    this.pending?.abort()
  }

  /** Abort plan streams for this registration on sign-out or reauthorization. */
  requestSignal(clientId: string): AbortSignal {
    let controller = this.requests.get(clientId)
    if (!controller) {
      controller = new AbortController()
      this.requests.set(clientId, controller)
    }
    return controller.signal
  }

  selectAccount(clientId: string): Promise<ChatGptPlanStatus> {
    return runSerialized(this.queueKey, () => {
      const state = this.store.read()
      if (!state.accounts.some((entry) => entry.clientId === clientId))
        throw new Error('Unknown ChatGPT account.')
      state.activeClientId = clientId
      this.store.write(state)
      return chatGptPlanStatus(state)
    })
  }

  signOut(clientId: string): Promise<{ status: ChatGptPlanStatus; revoked: boolean }> {
    this.cancelSignIn()
    this.requests.get(clientId)?.abort()
    return runSerialized(this.queueKey, async () => {
      const state = this.store.read()
      const account = state.accounts.find((entry) => entry.clientId === clientId)
      if (!account) throw new Error('Unknown ChatGPT account.')
      const revoked = account.credentials
        ? await revokeChatGptTokens(
            clientId,
            account.credentials.refreshToken,
            this.dependencies.fetch,
          )
        : true
      account.credentials = null
      this.catalogs.delete(clientId)
      this.store.write(state)
      return { status: chatGptPlanStatus(state), revoked }
    })
  }

  async refreshAccount(clientId: string): Promise<ChatGptPlanStatus> {
    await this.credentials(clientId, true)
    return this.status()
  }

  /** Main-process only. Pin the registration rather than looking up the active account. */
  credentials(
    clientId: string,
    forceRefresh = false,
  ): Promise<NonNullable<ChatGptRegistration['credentials']>> {
    // Headless ACP/eval hosts bypass Electron's per-profile single-instance lock.
    // Until cross-process token rotation is supported, keep this prototype desktop-only.
    if (process.argv.includes('--acp') || process.env['COPSE_AGENT_EVAL'] === '1')
      throw new Error('ChatGPT plan connections are available only in the Copse desktop client.')
    if (getExplicitSettingsProfile())
      throw new Error('ChatGPT plan credentials are unavailable in an explicit settings profile.')
    return runSerialized(this.queueKey, async () => {
      const state = this.store.read()
      const account = state.accounts.find((entry) => entry.clientId === clientId)
      if (!account?.credentials)
        throw new Error('Reconnect this ChatGPT account in Settings → Providers → OpenAI.')
      if (!account.credentials.scopes.includes('chatgpt.tokens.use.direct'))
        throw new Error(
          'ChatGPT plan permission was not granted. Continue with ChatGPT to enable it.',
        )
      if (forceRefresh || account.credentials.expiresAt <= Date.now() + 60_000) {
        const replacement = await refreshChatGptTokens(
          clientId,
          account.credentials.refreshToken,
          this.dependencies.fetch,
        )
        account.credentials = {
          ...account.credentials,
          accessToken: replacement.access_token,
          refreshToken: replacement.refresh_token ?? account.credentials.refreshToken,
          expiresAt: Date.now() + replacement.expires_in * 1000,
          scopes:
            replacement.scope === undefined
              ? account.credentials.scopes
              : replacement.scope.split(/\s+/).filter(Boolean),
        }
        this.store.write(state)
        this.catalogs.delete(clientId)
        if (!account.credentials.scopes.includes('chatgpt.tokens.use.direct'))
          throw new Error('ChatGPT plan permission was removed. Reconnect this account.')
      }
      return { ...account.credentials }
    })
  }

  async models(
    clientId: string | null = this.store.read().activeClientId,
  ): Promise<{ clientId: string | null; models: ChatGptPlanModel[] }> {
    if (!clientId) return { clientId: null, models: [] }
    const account = this.store.read().accounts.find((entry) => entry.clientId === clientId)
    if (!account?.credentials?.scopes.includes('chatgpt.tokens.use.direct'))
      return { clientId, models: [] }
    const credentials = await this.credentials(clientId)
    const cached = this.catalogs.get(clientId)
    if (cached && cached.expiresAt > Date.now()) return { clientId, models: cached.models }
    const response = await this.dependencies.fetch(`${CHATGPT_RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok)
      throw new Error(
        `ChatGPT model discovery failed (HTTP ${String(response.status)}). Reconnect or check your plan access.`,
      )
    const catalog = safeJsonParse(await response.text(), decodeWithSchema(modelCatalogSchema))
    if (!catalog) throw new Error('ChatGPT returned an invalid model catalog.')
    const models = catalog.models
      .filter((entry) => entry.visibility === 'list')
      .map((entry) => ({ slug: entry.slug, displayName: entry.display_name }))
    // A sign-out that finished while the request was running must not repopulate its cache.
    if (
      this.store.read().accounts.find((entry) => entry.clientId === clientId)?.credentials
        ?.accessToken !== credentials.accessToken
    )
      throw new Error('The ChatGPT connection changed. Refresh the model list.')
    this.catalogs.set(clientId, { expiresAt: Date.now() + 60_000, models })
    return { clientId, models }
  }
}

let service: ChatGptPlanService | undefined

/** Lazy construction respects the host's persistent-store and secure-storage boot order. */
export function getChatGptPlanService(): ChatGptPlanService {
  service ??= new ChatGptPlanService(createChatGptPlanStore(), {
    fetch: (...args): Promise<Response> => fetch(...args),
    openBrowser: async (url): Promise<void> => {
      const { shell } = await import('electron')
      await shell.openExternal(url)
    },
  })
  return service
}
