import type { ApiClient } from '../../../preload/api.d.ts'
import type { SettingsSnapshot } from '@shared/settings-contract.ts'
import {
  inputControl,
  selectControl,
  textareaControl,
  formDataString,
  parseWebAllowedOrigins,
  parseApprovedProviderHosts,
  wireSafetySliders,
} from './fields.ts'
import { DEFAULT_WEB_ALLOWED_ORIGINS } from '@shared/web-origins.ts'
import { sanitizeAutoApprovalLevel } from '@shared/auto-approval.ts'
import {
  formatTrustedCommands,
  parseTrustedCommands,
  sanitizeTrustedCommands,
} from '@shared/command-routing.ts'
import { parseTrustedSshHosts, sanitizeTrustedSshHosts } from '@shared/trusted-ssh-hosts.ts'
import { DEFAULT_SAFETY_MODEL } from '@shared/lm-studio-defaults.ts'

export interface SecuritySection {
  load(snapshot: SettingsSnapshot): void
  save(data: FormData, dirty: ReadonlySet<string>): Promise<void>
}

/** Guarded preferences remain on the dedicated security API. */
export function createSecuritySection(
  form: HTMLFormElement,
  api: ApiClient,
  readModels: () => { safetyModel: string; reviewModel: string },
  getLocalUrl: () => string,
): SecuritySection {
  wireSafetySliders(form)
  const names = [
    'localServerUrl',
    'safetyModel',
    'reviewModel',
    'safetyClassifierEnabled',
    'safetyExternalDenyThreshold',
    'autoRunSandboxCommands',
    'cursorHooksEnabled',
    'mcpAutoAllowReadOnly',
    'defaultReadonlyMode',
    'webAllowedOrigins',
    'webAllowUserApproval',
    'approvedProviderHosts',
    'providerAllowUserApproval',
    'trustedShellCommands',
    'shellAutoApprovalLevel',
  ]
  return {
    load(snapshot): void {
      textareaControl(form, 'webAllowedOrigins').value = (
        snapshot.webAllowedOrigins?.length
          ? snapshot.webAllowedOrigins
          : DEFAULT_WEB_ALLOWED_ORIGINS
      ).join('\n')
      textareaControl(form, 'approvedProviderHosts').value = (
        snapshot.approvedProviderHosts ?? []
      ).join('\n')
      textareaControl(form, 'trustedShellCommands').value = formatTrustedCommands(
        sanitizeTrustedCommands(snapshot.trustedShellCommands),
      )
      textareaControl(form, 'trustedSshHosts').value = sanitizeTrustedSshHosts(
        snapshot.trustedSshHosts,
      ).join('\n')
      selectControl(form, 'shellAutoApprovalLevel').value = sanitizeAutoApprovalLevel(
        snapshot.shellAutoApprovalLevel,
      )
      const output = form.querySelector<HTMLOutputElement>(
        'output[for="safetyExternalDenyThreshold"]',
      )
      if (output)
        output.textContent = Number(
          inputControl(form, 'safetyExternalDenyThreshold').value,
        ).toFixed(2)
    },
    async save(data, dirty): Promise<void> {
      if (names.some((name) => dirty.has(name))) {
        // Preserve security changes made while this dialog was open.
        const latest = await api.settings.getSnapshot(),
          routing = readModels()
        const checked = (name: string, fallback: boolean): boolean =>
          dirty.has(name) ? data.get(name) === 'on' : fallback
        await api.settings.setSecurity({
          localServerUrl: dirty.has('localServerUrl')
            ? getLocalUrl()
            : (latest.localServerUrl ?? ''),
          safetyModel: dirty.has('safetyModel')
            ? routing.safetyModel
            : (latest.safetyModel ?? DEFAULT_SAFETY_MODEL),
          reviewModel: dirty.has('reviewModel') ? routing.reviewModel : (latest.reviewModel ?? ''),
          safetyClassifierEnabled: checked(
            'safetyClassifierEnabled',
            latest.safetyClassifierEnabled ?? true,
          ),
          safetyExternalDenyThreshold: dirty.has('safetyExternalDenyThreshold')
            ? Number(formDataString(data, 'safetyExternalDenyThreshold'))
            : (latest.safetyExternalDenyThreshold ?? 1),
          autoRunSandboxCommands: checked(
            'autoRunSandboxCommands',
            latest.autoRunSandboxCommands ?? true,
          ),
          cursorHooksEnabled: checked('cursorHooksEnabled', latest.cursorHooksEnabled ?? false),
          mcpAutoAllowReadOnly: checked(
            'mcpAutoAllowReadOnly',
            latest.mcpAutoAllowReadOnly ?? false,
          ),
          defaultReadonlyMode: checked('defaultReadonlyMode', latest.defaultReadonlyMode ?? false),
          webAllowedOrigins: dirty.has('webAllowedOrigins')
            ? parseWebAllowedOrigins(data.get('webAllowedOrigins'))
            : (latest.webAllowedOrigins ?? [...DEFAULT_WEB_ALLOWED_ORIGINS]),
          webAllowUserApproval: checked(
            'webAllowUserApproval',
            latest.webAllowUserApproval ?? true,
          ),
          approvedProviderHosts: dirty.has('approvedProviderHosts')
            ? parseApprovedProviderHosts(data.get('approvedProviderHosts'))
            : (latest.approvedProviderHosts ?? []),
          providerAllowUserApproval: checked(
            'providerAllowUserApproval',
            latest.providerAllowUserApproval ?? true,
          ),
          trustedShellCommands: dirty.has('trustedShellCommands')
            ? parseTrustedCommands(formDataString(data, 'trustedShellCommands'))
            : (latest.trustedShellCommands ?? []),
          shellAutoApprovalLevel: dirty.has('shellAutoApprovalLevel')
            ? sanitizeAutoApprovalLevel(data.get('shellAutoApprovalLevel'))
            : sanitizeAutoApprovalLevel(latest.shellAutoApprovalLevel),
        })
      }
      if (dirty.has('trustedSshHosts'))
        await api.settings.set(
          'trustedSshHosts',
          parseTrustedSshHosts(formDataString(data, 'trustedSshHosts')),
        )
    },
  }
}
