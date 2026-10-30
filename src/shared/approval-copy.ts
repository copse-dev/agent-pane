/** Permission copy shared by prompt builders and browser-hosted visual fixtures. */
export const UNSANDBOXED_ACCESS_WARNING =
  'This runs with your user account’s access to files and the network, beyond the project sandbox.'

export function threadAccessApproval(access: 'read' | 'send'): ApprovalDetails & {
  title: string
  approveLabel: string
  allowRemember: boolean
} {
  return {
    title: access === 'read' ? 'Read your other threads?' : 'Send prompts to your other threads?',
    body: '',
    bodyAdvice:
      access === 'read'
        ? 'Allow this thread to read all your other conversations.'
        : 'Allow this thread to send prompts that run in your other conversations.',
    bodyFooter:
      'Applies only to this thread. Revoke it in the thread’s Context panel → Permissions.',
    approveLabel: access === 'read' ? 'Allow reading' : 'Allow sending',
    allowRemember: false,
  }
}

export interface ApprovalDetails {
  body: string
  bodyAdvice: string
  bodyFooter: string
}

export function webApprovalDetails(
  origin: string,
  url: string,
  allowRemember: boolean,
  context?: string,
): ApprovalDetails {
  return {
    body: url,
    bodyAdvice:
      `The agent wants to contact ${origin}. The site can see the request and any data in its URL.` +
      (context ? `\n\n${context}` : ''),
    bodyFooter: allowRemember
      ? 'Allow this request once. “Always allow” permits future requests to this origin, including other URLs, and is saved in Settings.'
      : 'Allow this request once. This does not add the origin to Settings.',
  }
}

export function browserApprovalDetails(
  origin: string,
  url: string,
  allowRemember: boolean,
): ApprovalDetails {
  return {
    body: url,
    bodyAdvice: `The agent wants to open a browser page on ${origin}. The site can see the request and any data in its URL.`,
    bodyFooter:
      'Approval allows navigation to this origin for this chat’s browser session.' +
      (allowRemember
        ? ' “Always allow” also permits future requests to this origin and is saved in Settings.'
        : ''),
  }
}

export function providerApprovalDetails(host: string, baseUrl: string): ApprovalDetails {
  return {
    body: baseUrl.trim(),
    bodyAdvice: `Your API key and prompts will be sent to ${host} at this base URL:`,
    bodyFooter:
      'Approval always allows this provider host, including other base URLs on it. The grant is saved in Settings.',
  }
}

/** The per-app prompt for a computer-use tool, before the agent reads or drives a Mac app. */
export function desktopAppApproval(input: {
  bundleId: string
  /** What the tool will do, phrased to follow "The agent wants to". */
  action: string
  /** Extra warning for an app that can launch code; such apps cannot be remembered. */
  caution?: string | undefined
  allowRemember: boolean
  /** False when the call has no thread, so the grant lasts for this call only. */
  threadScoped: boolean
}): ApprovalDetails & {
  title: string
  approveLabel: string
  allowRemember: boolean
  rememberLabel: string
} {
  const { bundleId, caution, threadScoped } = input
  const allowRemember = input.allowRemember && !caution
  const scope = threadScoped ? 'Applies to this thread.' : 'Applies to this request only.'
  return {
    title: `Let the agent use ${bundleId}?`,
    body: bundleId,
    bodyAdvice:
      `The agent wants to ${input.action}. It works in the background through Accessibility and can see anything this app shows, including signed-in accounts. Text it reads from the app is treated as untrusted.` +
      (caution ? `\n\n${caution}` : ''),
    bodyFooter: allowRemember
      ? `${scope} “Always allow” lets every thread use this app without asking and is saved in Settings.`
      : caution
        ? `${scope} This app is asked about in every thread and cannot be always allowed.`
        : scope,
    approveLabel: threadScoped ? 'Allow for this thread' : 'Allow once',
    allowRemember,
    rememberLabel: `Always allow ${bundleId}`,
  }
}
