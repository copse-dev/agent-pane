import { getSetting, updateSetting } from '../storage/settings.ts'

const SETTING = 'portBindingAllowedRoots'

export function projectAllowsPortBinding(root: string): boolean {
  return getSetting<string[]>(SETTING, []).includes(root)
}

export async function rememberProjectPortBinding(root: string): Promise<void> {
  await updateSetting<string[]>(SETTING, [], (current) =>
    current.includes(root) ? current : [...current, root],
  )
}

/** Affects future starts; a running task retains its existing process sandbox. */
export async function revokeProjectPortBinding(root: string): Promise<void> {
  await updateSetting<string[]>(SETTING, [], (current) =>
    current.filter((candidate) => candidate !== root),
  )
}
