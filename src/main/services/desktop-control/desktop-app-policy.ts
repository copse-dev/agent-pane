/**
 * Which Mac apps computer use may touch, decided before the helper is asked to
 * read or drive anything.
 *
 * Three layers. A fixed block list covers apps that run code outside the shell
 * permission gate (terminals, script and automation tools), whose content is
 * credentials (password managers), whose UI is a security boundary (System
 * Settings, authentication prompts), or which would let the agent approve its
 * own requests (Copse). No approval or saved grant reaches a blocked app.
 * Cautioned apps can launch code indirectly (Finder opens scripts and apps the
 * agent wrote): they prompt with a warning every thread and are never saved as
 * "always allow". Everything else needs a per-app approval, which the user can
 * remember.
 *
 * Pure so the permission gate and the tools apply the same decision.
 */

export const DESKTOP_ALLOWED_APPS_SETTING = 'desktopControlAllowedApps'

interface BlockedApp {
  readonly reason: string
  readonly bundleIds: readonly string[]
}

const BLOCKED_APPS: readonly BlockedApp[] = [
  {
    reason: 'a terminal, where typing runs commands outside the shell permission gate',
    bundleIds: [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'com.mitchellh.ghostty',
      'dev.warp.Warp-Stable',
      'dev.warp.Warp',
      'net.kovidgoyal.kitty',
      'io.alacritty',
      'org.alacritty',
      'com.github.wez.wezterm',
      'co.zeit.hyper',
      'com.raphaelamorim.rio',
      'org.tabby',
    ],
  },
  {
    reason: 'a script or automation tool, which runs code outside the shell permission gate',
    bundleIds: ['com.apple.ScriptEditor2', 'com.apple.Automator', 'com.apple.shortcuts'],
  },
  {
    reason: 'System Settings, where privacy and security permissions are changed',
    bundleIds: ['com.apple.systempreferences'],
  },
  {
    reason: 'Copse itself, where the agent could approve its own requests',
    bundleIds: ['dev.copse.app', 'dev.copse.app-dev', 'dev.copse.desktop-control'],
  },
  {
    reason: 'a password manager or keychain',
    bundleIds: [
      'com.apple.keychainaccess',
      'com.apple.Passwords',
      'com.1password.1password',
      'com.agilebits.onepassword7',
      'com.bitwarden.desktop',
      'com.lastpass.LastPass',
      'com.dashlane.dashlanephonefinal',
      'in.sinew.Enpass-Desktop',
      'org.keepassxc.keepassxc',
    ],
  },
  {
    reason: 'a system security or authentication prompt',
    bundleIds: [
      'com.apple.SecurityAgent',
      'com.apple.loginwindow',
      'com.apple.LocalAuthentication.UIAgent',
      'com.apple.coreservices.uiagent',
      'com.apple.UserNotificationCenter',
    ],
  },
]

const BLOCK_REASON_BY_BUNDLE_ID: ReadonlyMap<string, string> = new Map(
  BLOCKED_APPS.flatMap(({ reason, bundleIds }) => bundleIds.map((id) => [id, reason] as const)),
)

/** Apps that can start code the agent wrote, mapped to the warning shown in the prompt. */
const CAUTION_BY_BUNDLE_ID: ReadonlyMap<string, string> = new Map([
  [
    'com.apple.finder',
    'Finder can open scripts and apps, including ones the agent wrote, and they run outside the shell permission gate.',
  ],
])

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/

export function isValidBundleId(bundleId: string): boolean {
  return BUNDLE_ID_PATTERN.test(bundleId)
}

export type DesktopAppDecision =
  | { action: 'deny'; reason: string }
  | { action: 'allow' }
  | { action: 'prompt'; caution?: string }

export function decideDesktopAppAccess(input: {
  bundleId: string
  allowedBundleIds: readonly string[]
  /** Apps approved for this thread without "always allow". */
  sessionBundleIds?: ReadonlySet<string> | undefined
}): DesktopAppDecision {
  const { bundleId } = input
  if (!isValidBundleId(bundleId)) return { action: 'deny', reason: 'not a valid bundle identifier' }
  const blocked = BLOCK_REASON_BY_BUNDLE_ID.get(bundleId)
  if (blocked) return { action: 'deny', reason: `${bundleId} is ${blocked}` }
  if (input.sessionBundleIds?.has(bundleId)) return { action: 'allow' }
  const caution = CAUTION_BY_BUNDLE_ID.get(bundleId)
  if (caution) return { action: 'prompt', caution }
  if (input.allowedBundleIds.includes(bundleId)) return { action: 'allow' }
  return { action: 'prompt' }
}
