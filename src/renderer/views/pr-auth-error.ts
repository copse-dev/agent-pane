/** A GitHub organization SAML authorization link carried by a failed gh response. */
export function isGithubSamlError(message: string): boolean {
  return /organization SAML enforcement|SAML SSO/i.test(message)
}

export function githubSamlAuthorizationUrl(message: string, owner: string): string | null {
  if (!isGithubSamlError(message)) return null
  const match = message.match(/https:\/\/github\.com\/orgs\/[a-z\d-]+\/sso\?[^\s<>'"()]+/i)
  if (!match) return null
  try {
    const url = new URL(match[0].replace(/[.,;]+$/, ''))
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.pathname.toLowerCase() !== `/orgs/${owner.toLowerCase()}/sso` ||
      !url.search
    ) {
      return null
    }
    return url.href
  } catch {
    return null
  }
}
