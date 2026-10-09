import { parse } from 'shell-quote'

/** Explain only a single, literal, recognized invocation; never infer script effects. */
export function githubShellActionAdvice(command: string): string | null {
  if (/[\r\n$`]/.test(command)) return null
  const tokens = parse(command)
  if (!tokens.every((token) => typeof token === 'string')) return null
  if (tokens[0] !== 'gh' || tokens[1] !== 'pr' || tokens[2] !== 'create') return null
  const values = new Map<string, string>()
  let draft = false
  const options = new Map([
    ['--title', 'title'],
    ['-t', 'title'],
    ['--body', 'body'],
    ['-b', 'body'],
    ['--base', 'base'],
    ['-B', 'base'],
    ['--head', 'head'],
    ['-H', 'head'],
    ['--repo', 'repo'],
    ['-R', 'repo'],
  ])
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--draft' || token === '-d') {
      if (draft) return null
      draft = true
      continue
    }
    if (!token) return null
    const key = options.get(token)
    const value = tokens[index + 1]
    if (!key || !value || value.startsWith('-') || values.has(key)) return null
    values.set(key, value)
    index += 1
  }
  const title = values.get('title')
  // Interactive/fill/body-file modes may publish contents we cannot summarize.
  if (!title || !values.has('body')) return null
  return [
    `This may push the selected branch and publishes a ${draft ? 'draft ' : ''}pull request on GitHub. Its title and body will be visible to people with access to the repository.`,
    `• Repository: ${values.get('repo') ?? 'current repository'}`,
    `• Title: ${title}`,
    `• Head: ${values.get('head') ?? 'current branch'}`,
    `• Base: ${values.get('base') ?? 'repository default branch'}`,
  ].join('\n')
}
