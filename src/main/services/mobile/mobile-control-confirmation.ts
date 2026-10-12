import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'

/** Only an OS-native desktop confirmation can acknowledge a phone control grant. */
export async function confirmMobileControl(
  showConfirmation: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>,
  label: string,
  code?: string,
): Promise<boolean> {
  const result = await showConfirmation({
    type: 'question',
    title: 'Allow phone control',
    message: `Allow ${label} to control Copse?`,
    detail: `${code ? `Pairing code: ${code}\n\n` : ''}Control lets this phone send messages, start chats, stop runs, answer questions, and approve individual requests. Only grant control to a phone you hold. Install and trust the Copse Local Root on that phone first; its browser cannot report certificate trust settings to Copse.`,
    checkboxLabel: 'The Copse Local Root is installed and trusted on this phone',
    checkboxChecked: false,
    buttons: ['Cancel', 'Allow control'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return result.response === 1 && result.checkboxChecked
}
