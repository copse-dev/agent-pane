import {
  parseScreenshotManifest,
  serializeScreenshotManifest,
  changedManifestNames,
  SCREENSHOT_MANIFEST,
  SCREENSHOT_NAME,
  SCREENSHOT_PUBLIC_URL,
  screenshotObjectKey,
  type ScreenshotManifest,
  type ScreenshotEntry,
} from './screenshot-manifest.mts'

interface GitEntry {
  path: string
  mode: string
  type: string
  sha: string
}
export interface ScreenshotReviewGit {
  rest: {
    git: {
      getTree(args: {
        owner: string
        repo: string
        tree_sha: string
      }): Promise<{ data: { tree: GitEntry[]; truncated?: boolean } }>
      getBlob(args: {
        owner: string
        repo: string
        file_sha: string
      }): Promise<{ data: { content: string; encoding: string; size: number } }>
    }
  }
}

async function readTree(
  github: ScreenshotReviewGit,
  owner: string,
  repo: string,
  sha: string,
): Promise<Map<string, GitEntry>> {
  const { data } = await github.rest.git.getTree({ owner, repo, tree_sha: sha })
  if (data.truncated) throw new Error(`Tree ${sha} is truncated`)
  return new Map(data.tree.map((entry) => [entry.path, entry]))
}

async function readBlob(
  github: ScreenshotReviewGit,
  owner: string,
  repo: string,
  sha: string,
): Promise<ScreenshotManifest> {
  const { data } = await github.rest.git.getBlob({ owner, repo, file_sha: sha })
  if (data.encoding !== 'base64' || data.size > 2 * 1024 * 1024)
    throw new Error('Invalid screenshot manifest blob')
  return parseScreenshotManifest(Buffer.from(data.content, 'base64').toString('utf8'))
}

export async function readReviewManifest(
  github: ScreenshotReviewGit,
  owner: string,
  repo: string,
  tree: string,
): Promise<ScreenshotManifest> {
  let current = tree
  for (const name of ['tests', 'e2e', 'screenshots']) {
    const entry = (await readTree(github, owner, repo, current)).get(name)
    if (entry?.type !== 'tree' || entry.mode !== '040000')
      throw new Error('Missing screenshot manifest tree')
    current = entry.sha
  }
  const entry = (await readTree(github, owner, repo, current)).get('manifest.json')
  if (entry?.type !== 'blob' || entry.mode !== '100644')
    throw new Error('Screenshot manifest must be a regular file')
  return readBlob(github, owner, repo, entry.sha)
}

export async function validateManifestCompare(
  github: ScreenshotReviewGit,
  owner: string,
  repo: string,
  beforeTree: string,
  afterTree: string,
): Promise<{ before: ScreenshotManifest; after: ScreenshotManifest; changed: string[] }> {
  let before = beforeTree
  let after = afterTree
  const prefix: string[] = []
  let readmeBefore: GitEntry | undefined
  let readmeAfter: GitEntry | undefined
  const same = (a: GitEntry | undefined, b: GitEntry | undefined): boolean =>
    a?.mode === b?.mode && a?.type === b?.type && a?.sha === b?.sha
  for (const name of ['tests', 'e2e', 'screenshots', 'manifest.json']) {
    const [a, b] = await Promise.all([
      readTree(github, owner, repo, before),
      readTree(github, owner, repo, after),
    ])
    if (!prefix.length) {
      readmeBefore = a.get('README.md')
      readmeAfter = b.get('README.md')
    }
    for (const path of new Set([...a.keys(), ...b.keys()])) {
      if (
        !prefix.length &&
        path === 'README.md' &&
        readmeBefore?.mode === '100644' &&
        readmeBefore.type === 'blob' &&
        readmeAfter?.mode === '100644' &&
        readmeAfter.type === 'blob'
      )
        continue
      if (path !== name && !same(a.get(path), b.get(path)))
        throw new Error(
          `Compare commit changes \`${[...prefix, path].join('/')}\` outside ${SCREENSHOT_MANIFEST}`,
        )
    }
    const old = a.get(name)
    const next = b.get(name)
    const leaf = name === 'manifest.json'
    if (
      !old ||
      !next ||
      old.type !== (leaf ? 'blob' : 'tree') ||
      next.type !== old.type ||
      old.mode !== (leaf ? '100644' : '040000') ||
      next.mode !== old.mode
    )
      throw new Error('Invalid screenshot manifest tree')
    before = old.sha
    after = next.sha
    prefix.push(name)
  }
  const [a, b] = await Promise.all([
    readBlob(github, owner, repo, before),
    readBlob(github, owner, repo, after),
  ])
  const changed = changedManifestNames(a, b)
  if (!changed.length) throw new Error('Compare commit changes no screenshot')
  if (changed.some((name) => !Object.hasOwn(b.screenshots, name)))
    throw new Error('Compare commit removes a screenshot baseline')
  if (readmeBefore?.type === 'blob' && readmeAfter?.type === 'blob') {
    const beforeText = await readTextBlob(github, owner, repo, readmeBefore.sha)
    const afterText =
      readmeBefore.sha === readmeAfter.sha
        ? beforeText
        : await readTextBlob(github, owner, repo, readmeAfter.sha)
    if (afterText !== updateScreenshotReadme(beforeText, a, b))
      throw new Error('Compare README changes are not the accepted screenshot hash updates')
  }
  return { before: a, after: b, changed }
}

async function readTextBlob(
  github: ScreenshotReviewGit,
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  const { data } = await github.rest.git.getBlob({ owner, repo, file_sha: sha })
  if (data.encoding !== 'base64' || data.size > 2 * 1024 * 1024)
    throw new Error('Invalid README blob')
  return Buffer.from(data.content, 'base64').toString('utf8')
}

/** These doc references track their named baselines; all other prose stays byte-identical. */
export function updateScreenshotReadme(
  text: string,
  before: ScreenshotManifest,
  after: ScreenshotManifest,
): string {
  const name = 'landing-cupcake-changes.png'
  const old = before.screenshots[name]
  const next = after.screenshots[name]
  return old && next
    ? text.replaceAll(
        `${SCREENSHOT_PUBLIC_URL}/${screenshotObjectKey(old)}`,
        `${SCREENSHOT_PUBLIC_URL}/${screenshotObjectKey(next)}`,
      )
    : text
}

export async function selectedReadmeContent(
  github: ScreenshotReviewGit,
  owner: string,
  repo: string,
  tree: string,
  before: ScreenshotManifest,
  after: ScreenshotManifest,
): Promise<string | null> {
  const readme = (await readTree(github, owner, repo, tree)).get('README.md')
  if (!readme) return null
  if (readme.mode !== '100644' || readme.type !== 'blob')
    throw new Error('README must be a regular file')
  const text = await readTextBlob(github, owner, repo, readme.sha)
  const updated = updateScreenshotReadme(text, before, after)
  return updated === text ? null : updated
}

export function selectManifestEntries(
  before: ScreenshotManifest,
  after: ScreenshotManifest,
  names: string[],
): { name: string; sha256: string; bytes: number }[] {
  const changed = new Set(changedManifestNames(before, after))
  if (!names.length || new Set(names).size !== names.length)
    throw new Error('Empty or duplicate screenshot selection')
  return names.map((name) => {
    const entry = after.screenshots[name]
    if (!SCREENSHOT_NAME.test(name) || !entry || !changed.has(name))
      throw new Error(`${name} is not a changed screenshot candidate`)
    return { name, ...entry }
  })
}

export function selectedManifestContent(
  before: ScreenshotManifest,
  selected: { name: string; sha256: string; bytes: number }[],
): string {
  const partial = parseScreenshotManifest(
    JSON.stringify({
      version: 1,
      screenshots: Object.fromEntries(
        selected.map(({ name, sha256, bytes }) => [name, { sha256, bytes }]),
      ),
    }),
  )
  const screenshots: Record<string, ScreenshotEntry> = {
    ...before.screenshots,
    ...partial.screenshots,
  }
  return serializeScreenshotManifest({ version: 1, screenshots })
}
