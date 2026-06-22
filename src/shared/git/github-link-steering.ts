/** Light steering: PR/issue discussion should link to GitHub in markdown. */
export function shouldSteerGithubLinks(userMessage: string): boolean {
  const text = userMessage.trim().toLowerCase()
  if (text.length < 15) return false
  return (
    /\bpull requests?\b/.test(text) ||
    /\bgithub issues?\b/.test(text) ||
    /\b(?:gh|github)\s+(?:pr|issue)\b/.test(text) ||
    /\b(?:pr|issue)\s+#?\d+\b/.test(text) ||
    /\b(?:this|the|my|our|open|review|merge|close|create|file)\s+pr\b/.test(text)
  )
}

/** Parse `org/repo` from a GitHub remote URL, or null when not GitHub. */
export function parseGithubRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim()
  if (!trimmed) return null

  const scp = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (scp) return `${scp[1]}/${scp[2]!.replace(/\.git$/i, '')}`

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    if (url.hostname.replace(/^www\./i, '').toLowerCase() !== 'github.com') return null
    const [owner, repoRaw] = url.pathname.replace(/^\/+/, '').split('/')
    if (!owner || !repoRaw) return null
    const repo = repoRaw.replace(/\.git$/i, '')
    return repo ? `${owner}/${repo}` : null
  } catch {
    return null
  }
}

export function buildGithubLinkSteeringPrompt(repoSlug: string | null): string {
  const base =
    'When discussing pull requests or GitHub issues, link them in markdown with full GitHub URLs.'
  if (repoSlug) {
    return `${base} Repo: ${repoSlug}. Use \`gh\` when you only have numbers.`
  }
  return `${base} Use \`gh\` or the git remote when you only have numbers.`
}
