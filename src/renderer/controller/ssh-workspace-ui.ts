import type { ApiClient } from '../../preload/api.d.ts'

/** Best-effort read of sshWorkspaceEnabled; false when settings IPC is unavailable (tests). */
export async function isSshWorkspaceEnabled(api: ApiClient): Promise<boolean> {
  try {
    const settings = (api as Partial<ApiClient>).settings
    if (!settings?.get) return false
    return (await settings.get('sshWorkspaceEnabled')) === true
  } catch {
    return false
  }
}
