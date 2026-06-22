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

export const GITHUB_LINK_STEERING_PROMPT = `When discussing pull requests or GitHub issues, link them in markdown ([#N](url) or [PR #N](url)). Use \`gh\` or the git remote to resolve URLs when you only have numbers.`
