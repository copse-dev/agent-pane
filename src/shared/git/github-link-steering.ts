/** Light steering: PR/issue discussion should link to GitHub in markdown. */
export function shouldSteerGithubLinks(userMessage: string): boolean {
  const text = userMessage.trim().toLowerCase()
  if (text.length < 15) return false
  return (
    /\bpull requests?\b/.test(text) ||
    /\bprs\b/.test(text) ||
    /\bgithub issues?\b/.test(text) ||
    /\b(?:gh|github)\s+(?:pr|issue)\b/.test(text) ||
    /\b(?:pr|issue)\s+#?\d+\b/.test(text) ||
    /\b(?:this|the|my|our|open|review|merge|close|create|file)\s+prs?\b/.test(text) ||
    (/\blinks?\b/.test(text) && /\b(?:for them|pull request|prs?|issues?|github)\b/.test(text))
  )
}

/** Parse `org/repo` from a GitHub remote URL, or null when not GitHub. */
export function parseGithubRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim()
  if (!trimmed) return null

  const scp = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (scp) {
    const owner = scp[1] ?? ''
    const repo = (scp[2] ?? '').replace(/\.git$/i, '')
    return `${owner}/${repo}`
  }

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
    'Markdown-link every PR/issue mention (tables and lists too) as `[text](full GitHub URL)`.'
  if (repoSlug) {
    return `${base} Repo: ${repoSlug}. Use gh_pr_list / gh_pr_view when you only have numbers.`
  }
  return `${base} Use gh_pr_list / gh_pr_view or the git remote when you only have numbers.`
}
