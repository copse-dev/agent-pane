import { syncMachineService } from '../services/machines/machine-service.ts'
import { REMOTE_SYSTEM_ONE_MODELS_SETTING } from '@shared/machines.ts'
import {
  getSettingsSnapshot,
  settingsUpdateSchema,
  updateSettings,
} from '../services/storage/settings-transaction.ts'
import { settingsConsentDetail } from '../services/storage/settings-consent.ts'
import { confirmNativeAction } from '../services/native-human-confirmation.ts'
import { modelInvalidationService } from '../services/providers/model-invalidation.ts'
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import {
  assertMainFrameSender,
  IpcValidationError,
  keyProviderSchema,
  modelCardIdsSchema,
  setKeyOptionsSchema,
  parseIpcArgs,
  zNonEmptyString,
} from './ipc-guards.ts'
import {
  getSetting,
  setSetting,
  hasApiKey,
  resolveApiKey,
  setApiKey,
  isApiKeyEncrypted,
} from '../services/storage/settings.ts'
import { refreshNeedsInputBadge } from '../services/user-alerts-electron.ts'
import { scanEnvForKeys, maskSecret } from '../services/providers/env-key-detection.ts'
import {
  assertEnvKeyDetectionConsent,
  importDetectedEnvKeys,
  EnvKeyImportConsentError,
} from '../services/providers/env-key-import.ts'
import {
  isRendererWritableSettingKey,
  isSecretSettingKey,
  parseRendererWritableSetting,
  securitySettingsSchema,
} from '../services/storage/settings-writable.ts'
import {
  isRegisteredSettingKey,
  storedExtraProviderSchema,
} from '../services/storage/settings-schema.ts'
import {
  getResolvedExtraProviders,
  saveExtraProvider,
  deleteExtraProvider,
  refreshHuggingFaceModels,
  HUGGINGFACE_SLUG,
} from '../services/providers/extra-providers-store.ts'
import {
  invalidateOpenAiModelAvailability,
  isOpenAiModelAvailable,
} from '../services/providers/openai-model-availability.ts'
import { resolveModelPricing } from '../services/providers/model-pricing-store.ts'
import { fetchOpenAiCompatibleModelsForSettings } from '../services/providers/provider-models.ts'
import { resolveBestValueChatModel } from '../services/providers/best-value-model.ts'
import { resolveDynamicModelId } from '../services/providers/dynamic-model.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'
import { initSkillsRegistry } from '../services/skills/skills-registry.ts'
import {
  registerSkillTools,
  syncModelClassifierTools,
  syncOrchestrationStrategyTools,
  syncImageGenerationTools,
  syncWebSearchTools,
  syncReadTerminalTools,
} from '../services/registry-bootstrap.ts'
import { READ_TERMINAL_ENABLED_SETTING } from '@shared/terminal/read-terminal.ts'
import { MODEL_CLASSIFIER_ENABLED_SETTING } from '../services/providers/model-classifier.ts'
import { ORCHESTRATION_STRATEGY_ENABLED_SETTING } from '../services/orchestration-strategy.ts'
import { applyAppIcon } from '../app-icon.ts'
import {
  createMainWindow,
  getFocusedMainWindow,
  getMainWindow,
} from '../windows/create-main-window.ts'
import { buildAppMenu } from '../windows/app-menu.ts'
import { DEVELOPER_MODE_SETTING } from '@shared/developer-mode.ts'
import { validateApiKey } from '../services/providers/validate-api-key.ts'
import {
  invalidateProviderKeyStatus,
  isProviderKeyUsable,
  recordProviderKeyValidation,
} from '../services/providers/provider-key-status.ts'
import {
  fetchLiveIntellectModels,
  invalidateLiveIntellectCache,
} from '../services/providers/aa-live-intellect.ts'
import {
  resolveModelCard,
  type ResolvedModelCard,
} from '../services/providers/model-card-resolver.ts'
import { invalidateCursorCloudModelsCache } from '../services/remote/cursor-cloud-models.ts'

const SKILLS_RELOAD_KEYS = new Set([
  'skillsEnabled',
  'bundledCursorSkillsEnabled',
  'bundledSkillPluginOverrides',
  'skillPluginPaths',
])

export function registerSettingsHandlers(win: BrowserWindow, registry: ToolRegistry): void {
  ipcMain.handle('settings:get', (event, key: unknown) => {
    assertMainFrameSender(event, win)
    const k = parseIpcArgs(zNonEmptyString.max(128), [key])
    // Never hand stored API-key records back to the renderer — it only needs the
    // boolean `settings:get-key`. Reading `apiKey.*` here would expose the key
    // (base64 plaintext when the OS keyring is unavailable).
    if (isSecretSettingKey(k)) {
      throw new IpcValidationError(`Setting key not readable from renderer: ${k}`)
    }
    // An unregistered key cannot survive this read: `getSetting` falls back to a
    // type-check against the fallback, and `null` matches only `null`, so the
    // renderer would receive `null` whatever is stored — and then write that
    // emptied value back on the next save (#1804). Fail the read instead of
    // silently serving a default, so a key added without a schema is found the
    // first time it is read rather than after it has eaten someone's settings.
    if (!isRegisteredSettingKey(k)) {
      throw new IpcValidationError(
        `Setting key has no registered schema, so it cannot be read from the renderer: ${k}. ` +
          'Register it in settings-schema.ts.',
      )
    }
    return getSetting(k, null)
  })
  async function syncChangedSettings(changedKeys: ReadonlySet<string>): Promise<void> {
    if (changedKeys.has(REMOTE_SYSTEM_ONE_MODELS_SETTING)) await syncMachineService()
    if (changedKeys.has('alertOnInteraction')) refreshNeedsInputBadge()
    if ([...changedKeys].some((key) => SKILLS_RELOAD_KEYS.has(key))) {
      await initSkillsRegistry()
      registerSkillTools(registry)
    }
    if (changedKeys.has(READ_TERMINAL_ENABLED_SETTING)) syncReadTerminalTools(registry)
    if (changedKeys.has('webSearchProvider')) syncWebSearchTools(registry)
    if (changedKeys.has(MODEL_CLASSIFIER_ENABLED_SETTING)) syncModelClassifierTools(registry)
    if (changedKeys.has(ORCHESTRATION_STRATEGY_ENABLED_SETTING))
      syncOrchestrationStrategyTools(registry)
    if (changedKeys.has(DEVELOPER_MODE_SETTING)) {
      const win = getMainWindow()
      if (win)
        buildAppMenu(
          { getFocusedWindow: getFocusedMainWindow, createWindow: createMainWindow },
          getSetting(DEVELOPER_MODE_SETTING, false),
        )
    }
  }

  ipcMain.handle('settings:get-snapshot', (event) => {
    assertMainFrameSender(event, win)
    return getSettingsSnapshot()
  })
  ipcMain.handle('settings:update', async (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = settingsUpdateSchema.parse(raw)
    const consent = settingsConsentDetail(parsed)
    if (consent && !(await confirmNativeAction(event.sender, {
      title: 'Change Copse settings?',
      detail: consent,
    }))) throw new IpcValidationError('Setting change was not confirmed')
    const changes = await updateSettings(parsed)
    await syncChangedSettings(new Set(Object.keys(changes)))
  })
  ipcMain.handle('settings:set', async (event, key: unknown, value: unknown) => {
    assertMainFrameSender(event, win)
    const k = parseIpcArgs(zNonEmptyString.max(128), [key])
    if (!isRendererWritableSettingKey(k)) {
      throw new IpcValidationError(`Setting key not writable from renderer: ${k}`)
    }
    const parsed = parseRendererWritableSetting(k, value)
    const consent = settingsConsentDetail({ [k]: parsed })
    if (consent && !(await confirmNativeAction(event.sender, {
      title: 'Change Copse setting?',
      detail: consent,
    }))) throw new IpcValidationError('Setting change was not confirmed')
    await setSetting(k, parsed)
    await syncChangedSettings(new Set([k]))
  })
  ipcMain.handle('settings:set-security', async (event, raw: unknown) => {
    assertMainFrameSender(event, win)
    const prefs = securitySettingsSchema.parse(raw)
    const consent = settingsConsentDetail(prefs)
    if (consent && !(await confirmNativeAction(event.sender, {
      title: 'Change security settings?',
      detail: consent,
    }))) throw new IpcValidationError('Security setting change was not confirmed')
    await Promise.all(
      Object.entries(prefs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => setSetting(k, v)),
    )
  })
  ipcMain.handle('settings:get-key', (event, provider: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(keyProviderSchema, [provider])
    return hasApiKey(p)
  })
  // Live Artificial Analysis feed for the model value map. Key-gated (empty
  // result without a stored 'artificial-analysis' key); the renderer's anchor
  // gate decides whether the returned cohort is on the canonical scale.
  ipcMain.handle('intellect:live-models', (event) => {
    assertMainFrameSender(event, win)
    return fetchLiveIntellectModels()
  })
  // Model-card links for the value map. Batched because the panel warms every
  // plotted model at once; the resolver's URL cache makes repeat calls free.
  ipcMain.handle('model-cards:resolve', async (event, modelIds: unknown) => {
    assertMainFrameSender(event, win)
    const ids = parseIpcArgs(modelCardIdsSchema, [modelIds])
    const out: Record<string, ResolvedModelCard | null> = {}
    await Promise.all(
      ids.map(async (id) => {
        try {
          out[id] = await resolveModelCard(id)
        } catch {
          // A probe failure is "no link", never a broken settings panel.
          out[id] = null
        }
      }),
    )
    return out
  })
  // At-rest state for a provider's stored key: true = OS-encrypted, false = base64
  // plaintext fallback, null = no key stored. Lets the Settings UI flag the
  // plaintext-at-rest condition instead of leaving it to a console.warn.
  ipcMain.handle('settings:get-key-encrypted', (event, provider: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(keyProviderSchema, [provider])
    return isApiKeyEncrypted(p)
  })
  ipcMain.handle('settings:set-key', (event, provider: unknown, key: unknown, opts: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(keyProviderSchema, [provider])
    const apiKey = parseIpcArgs(z.string().max(8192), [key])
    const options = parseIpcArgs(setKeyOptionsSchema, [opts])
    const result = setApiKey(p, apiKey, options)
    // Encryption unavailable: nothing was stored. The result distinguishes the
    // default-off plaintext policy from the per-save consent step so the
    // renderer never offers a retry the process is not allowed to perform.
    if (!result.ok) return result
    invalidateProviderKeyStatus(p)
    if (p === 'openai') {
      invalidateOpenAiModelAvailability()
      syncImageGenerationTools(registry)
    }
    if (p === 'cursor') invalidateCursorCloudModelsCache()
    // The live Intelligence Index feed caches its result (successes AND failures)
    // for hours, so a stored 403/empty would otherwise survive the user fixing
    // their key. Drop it here so the next value-map open re-fetches with the new
    // key.
    if (p === 'artificial-analysis') invalidateLiveIntellectCache()
    if (p === 'parallel' || p === 'tavily') syncWebSearchTools(registry)
    // Saving an HF token auto-populates its priced, provider-pinned model list so
    // the picker and cost estimate work without a manual fetch (fire-and-forget).
    if (p === HUGGINGFACE_SLUG && apiKey.trim()) {
      void refreshHuggingFaceModels(apiKey).catch(() => {})
    }
    return result
  })
  ipcMain.handle('settings:available-providers', async () => {
    const available: Record<string, boolean> = {
      anthropic: await isProviderKeyUsable('anthropic'),
      openai: await isProviderKeyUsable('openai'),
      cursor: await isProviderKeyUsable('cursor'),
      openrouter: await isProviderKeyUsable('openrouter'),
    }
    // Astra rolls out by account. Do not offer a static picker row merely
    // because an OpenAI key works — the account's model list is authoritative.
    const openAiKey = resolveApiKey('openai')
    available['openai:gpt-6-astra'] =
      available['openai'] === true && typeof openAiKey === 'string'
        ? await isOpenAiModelAvailable(openAiKey, 'gpt-6-astra')
        : false
    for (const provider of getResolvedExtraProviders()) {
      // Local servers need no API key, so treat them as available; their models
      // only surface in the picker once the user fetches/saves them anyway.
      available[provider.id] = provider.local ? true : await isProviderKeyUsable(provider.id)
    }
    return available
  })
  ipcMain.handle('settings:validate-key', async (event, provider: unknown, key: unknown) => {
    assertMainFrameSender(event, win)
    const p = parseIpcArgs(keyProviderSchema, [provider])
    const apiKey = parseIpcArgs(z.string().max(8192), [key])
    // Empty means "the key already in use" (see the `settings:validate-key`
    // contract): resolve it here so the stored secret never crosses to the
    // renderer just to be handed straight back.
    const candidate = apiKey.trim() ? apiKey : (resolveApiKey(p) ?? '')
    if (!candidate) return { ok: false, error: 'No key configured for this provider' }
    const result = await validateApiKey(p, candidate)
    recordProviderKeyValidation(p, candidate, result.ok)
    return result
  })
  // Opt-in environment scan: look for provider API keys the user already has
  // exported (process.env + well-known shell files) and offer to import them.
  // Raw secrets stay in the main process — the renderer only sees the masked
  // preview. Both handlers re-scan on each call and both are gated on the
  // persisted consent flag set when the user approves the scan.
  ipcMain.handle('settings:scan-env-keys', (event) => {
    assertMainFrameSender(event, win)
    try {
      assertEnvKeyDetectionConsent()
    } catch (err) {
      if (err instanceof EnvKeyImportConsentError) throw new IpcValidationError(err.message)
      throw err
    }
    return scanEnvForKeys().map((d) => ({
      provider: d.provider,
      envVar: d.envVar,
      source: d.source,
      masked: maskSecret(d.value),
      alreadyConfigured: hasApiKey(d.provider),
    }))
  })
  ipcMain.handle('settings:import-env-keys', (event, rawProviders?: unknown) => {
    assertMainFrameSender(event, win)
    const providers = parseIpcArgs(z.array(z.string().max(64)).max(32).optional(), [rawProviders])
    try {
      return importDetectedEnvKeys(providers ? { providers } : {})
    } catch (err) {
      if (err instanceof EnvKeyImportConsentError) throw new IpcValidationError(err.message)
      throw err
    }
  })
  ipcMain.handle('models:best-value-default', () => resolveBestValueChatModel())
  ipcMain.handle(
    'models:invalidations',
    (event, rawThreadModel: unknown, rawFreshLocal: unknown) => {
      assertMainFrameSender(event, win)
      const [model, fresh] = parseIpcArgs(
        z.tuple([z.string().max(512).optional(), z.boolean().optional()]),
        [rawThreadModel, rawFreshLocal],
      )
      return modelInvalidationService.report(model, fresh)
    },
  )
  ipcMain.handle(
    'models:recover-setting',
    (event, rawTarget: unknown, rawExpected: unknown, rawFallback: unknown) => {
      assertMainFrameSender(event, win)
      const [target, expected, fallback] = parseIpcArgs(
        z.tuple([z.string().max(512), z.string().max(512), z.string().max(512)]),
        [rawTarget, rawExpected, rawFallback],
      )
      return modelInvalidationService.recover(target, expected, fallback)
    },
  )
  // What a dynamic selection (`auto:…`) resolves to right now. Settings uses it
  // to show the concrete model behind a rule; a pinned id round-trips unchanged.
  ipcMain.handle('models:resolve-dynamic', (_event, rawValue: unknown) => {
    const value = parseIpcArgs(z.string().trim().max(256), [rawValue])
    return resolveDynamicModelId(value)
  })
  ipcMain.handle('settings:extra-providers', () => getResolvedExtraProviders())
  ipcMain.handle('settings:model-pricing', () => resolveModelPricing())
  ipcMain.handle('settings:save-extra-provider', async (event, record: unknown) => {
    assertMainFrameSender(event, win)
    const parsed = parseIpcArgs(storedExtraProviderSchema.partial({ slug: true }), [record])
    if (!(await confirmNativeAction(event.sender, {
      title: 'Save model provider?',
      detail: `Save this provider configuration? Requests to its endpoint may include prompts and its stored API key.\n\n${JSON.stringify(parsed, null, 2)}`,
      approveLabel: 'Save provider',
    }))) throw new IpcValidationError('Provider configuration was not confirmed')
    const provider: Parameters<typeof saveExtraProvider>[0] = {}
    if (parsed.slug !== undefined) provider.slug = parsed.slug
    if (parsed.label !== undefined) provider.label = parsed.label
    if (parsed.baseUrl !== undefined) provider.baseUrl = parsed.baseUrl
    if (parsed.keyPrefix !== undefined) provider.keyPrefix = parsed.keyPrefix
    if (parsed.apiStyle !== undefined) provider.apiStyle = parsed.apiStyle
    if (parsed.models !== undefined) {
      provider.models = parsed.models.map((model) => {
        const result: NonNullable<Parameters<typeof saveExtraProvider>[0]['models']>[number] = {
          id: model.id,
        }
        if (model.contextWindow !== undefined) result.contextWindow = model.contextWindow
        if (model.inputPricePerMTok !== undefined) {
          result.inputPricePerMTok = model.inputPricePerMTok
        }
        if (model.outputPricePerMTok !== undefined) {
          result.outputPricePerMTok = model.outputPricePerMTok
        }
        return result
      })
    }
    if (parsed.fallbackContextWindow !== undefined) {
      provider.fallbackContextWindow = parsed.fallbackContextWindow
    }
    if (parsed.includeUsage !== undefined) provider.includeUsage = parsed.includeUsage
    if (parsed.extraBody !== undefined) provider.extraBody = parsed.extraBody
    return saveExtraProvider(provider)
  })
  ipcMain.handle('settings:delete-extra-provider', async (event, slug: unknown) => {
    assertMainFrameSender(event, win)
    const s = parseIpcArgs(keyProviderSchema, [slug])
    return deleteExtraProvider(s)
  })
  ipcMain.handle(
    'settings:fetch-provider-models',
    async (event, baseUrl: unknown, key: unknown) => {
      assertMainFrameSender(event, win)
      const url = parseIpcArgs(z.string().max(2048), [baseUrl])
      const apiKey = parseIpcArgs(z.string().max(8192).optional(), [key])
      return fetchOpenAiCompatibleModelsForSettings(url, apiKey)
    },
  )
  ipcMain.handle('settings:refresh-hugging-face-models', async (event, key: unknown) => {
    assertMainFrameSender(event, win)
    const apiKey = parseIpcArgs(z.string().max(8192).optional(), [key])
    return refreshHuggingFaceModels(apiKey)
  })
  ipcMain.handle('app-icon:apply', () => {
    const mainWin = getMainWindow()
    applyAppIcon(mainWin && !mainWin.isDestroyed() ? [mainWin] : [])
  })
}
