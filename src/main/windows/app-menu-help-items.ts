import type { MenuItemConstructorOptions } from 'electron'

const NEW_ISSUE_URL = 'https://github.com/copse-dev/agent-pane/issues/new'

/**
 * The Platform options of the bug form (`.github/ISSUE_TEMPLATE/bug.yml`). A
 * prefilled dropdown only selects an option whose text matches exactly, so the
 * test holds these in step with the form.
 */
export const BUG_FORM_PLATFORMS = {
  macArm64: 'macOS 26+ Apple Silicon (arm64)',
  macX64: 'macOS 26+ Intel (x64)',
  macOlder: 'macOS older than 26 (unsupported)',
  linux: 'Linux (source / unsupported GA target)',
  windows: 'Windows (source / unsupported GA target)',
} as const

export interface ReportIssueContext {
  /** Copse's version (`getAppVersion()`), not Electron's. */
  version: string
  /** Whether this is a packaged release rather than a source build. */
  packaged: boolean
  /** Commit the bundle was built from; shown for source builds. */
  buildCommit?: string | null
  platform: NodeJS.Platform
  arch: string
  /** `process.getSystemVersion()`, e.g. `26.0.1` on macOS. */
  systemVersion: string
}

function bugFormPlatform(context: ReportIssueContext): string | undefined {
  switch (context.platform) {
    case 'darwin': {
      const major = Number.parseInt(context.systemVersion, 10)
      if (Number.isNaN(major)) return undefined
      if (major < 26) return BUG_FORM_PLATFORMS.macOlder
      if (context.arch === 'arm64') return BUG_FORM_PLATFORMS.macArm64
      if (context.arch === 'x64') return BUG_FORM_PLATFORMS.macX64
      return undefined
    }
    case 'linux':
      return BUG_FORM_PLATFORMS.linux
    case 'win32':
      return BUG_FORM_PLATFORMS.windows
    default:
      return undefined
  }
}

/**
 * The bug form on GitHub with the version and platform filled in. Nothing
 * about the user's workspace, threads, or settings goes into the URL; the user
 * reviews the form in their browser before anything is filed.
 */
export function reportIssueUrl(context: ReportIssueContext): string {
  const url = new URL(NEW_ISSUE_URL)
  url.searchParams.set('template', 'bug.yml')
  url.searchParams.set(
    'version',
    context.packaged
      ? context.version
      : `${context.version} (source build${context.buildCommit ? `, ${context.buildCommit.slice(0, 7)}` : ''})`,
  )
  const platform = bugFormPlatform(context)
  if (platform !== undefined) url.searchParams.set('platform', platform)
  return url.toString()
}

export interface AppHelpMenuActions {
  showKeyboardShortcuts(): void
  reportIssue(): void
}

export function buildAppHelpMenuItems(actions: AppHelpMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Keyboard Shortcuts',
      accelerator: 'CmdOrCtrl+/',
      click: (): void => {
        actions.showKeyboardShortcuts()
      },
    },
    { type: 'separator' },
    {
      label: 'Report an Issue…',
      click: (): void => {
        actions.reportIssue()
      },
    },
  ]
}
