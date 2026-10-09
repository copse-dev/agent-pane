/** Host-only authentication. Never follow the authenticated request's redirect. */
export async function requestGithubArchiveUrl(
  repository: string,
  commit: string,
  signal: AbortSignal,
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/tarball/${commit}`, {
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  await response.body?.cancel()
  if (response.status !== 302)
    throw new Error(
      `GitHub archive request failed (HTTP ${String(response.status)}). Check repository access and fetch origin.`,
    )
  const location = response.headers.get('location')
  if (!location) throw new Error('GitHub did not return an archive download URL.')
  let url: URL
  try {
    url = new URL(location)
  } catch {
    throw new Error('GitHub returned an invalid archive download destination.')
  }
  if (
    url.href.length > 8192 ||
    url.protocol !== 'https:' ||
    url.hostname !== 'codeload.github.com' ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/`)
  )
    throw new Error('GitHub returned an unsupported archive download destination.')
  return url.href
}
