/** Permission copy shared by prompt builders and browser-hosted visual fixtures. */
export const UNSANDBOXED_ACCESS_WARNING =
  'This runs with your user account’s access to files and the network, beyond the project sandbox.'

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
