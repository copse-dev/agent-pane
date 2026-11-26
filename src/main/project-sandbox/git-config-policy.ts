/**
 * Which repository git config a contained command may change.
 *
 * Copse leaves a checkout's `.git/config` writable to contained commands
 * (`allowGitConfig: true`) so ordinary git work keeps running in the sandbox:
 * `git push -u`, `git branch --set-upstream-to`, `git remote add`,
 * `git submodule init`, `git lfs install --local`. Many other keys name a
 * program that git starts later, outside the sandbox, when the user or an
 * approved command runs git in the same checkout (`core.fsmonitor`,
 * `core.hooksPath`, `core.sshCommand`, `alias.*` with `!`, filter and diff
 * drivers, credential helpers, `include.path` …).
 *
 * The policy is an allowlist: a key is inert only when this file names it.
 * Anything else, including keys a future git adds, counts as able to run a
 * program, so `workspace-integrity.ts` reverts a contained change to it.
 */

/** Keys (`section.name`, lower case) with no subsection that never select a program. */
const INERT_PLAIN_KEYS = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'core.autocrlf',
  'core.eol',
  'core.safecrlf',
  'core.sparsecheckout',
  'core.sparsecheckoutcone',
  'core.splitindex',
  'core.untrackedcache',
  'core.commitgraph',
  'core.multipackindex',
  'core.quotepath',
  'core.compression',
  'core.loosecompression',
  'core.abbrev',
  'core.checkstat',
  'core.trustctime',
  'core.preloadindex',
  'core.longpaths',
  'core.fscache',
  'core.whitespace',
  'core.warnambiguousrefs',
  'core.commentchar',
  'core.commentstring',
  'core.hidedotfiles',
  'core.filesreflocktimeout',
  'core.packedrefstimeout',
  'core.deltabasecachelimit',
  'core.bigfilethreshold',
  'core.excludesfile',
  'core.attributesfile',
  'user.name',
  'user.email',
  'user.useconfigonly',
  'extensions.worktreeconfig',
  'extensions.objectformat',
  'extensions.refstorage',
  'extensions.partialclone',
  'extensions.noop',
  'pull.rebase',
  'pull.ff',
  'push.default',
  'push.autosetupremote',
  'push.followtags',
  'fetch.prune',
  'fetch.prunetags',
  'fetch.recursesubmodules',
  'fetch.writecommitgraph',
  'fetch.parallel',
  'init.defaultbranch',
  'merge.conflictstyle',
  'merge.ff',
  'merge.log',
  'merge.renames',
  'merge.renamelimit',
  'merge.autostash',
  'commit.verbose',
  'commit.cleanup',
  'commit.status',
  'commit.gpgsign',
  'commit.template',
  'diff.algorithm',
  'diff.renames',
  'diff.renamelimit',
  'diff.colormoved',
  'diff.mnemonicprefix',
  'diff.noprefix',
  'diff.context',
  'diff.interhunkcontext',
  'diff.submodule',
  'diff.ignoresubmodules',
  'diff.statgraphwidth',
  'diff.wserrorhighlight',
  'diff.indentheuristic',
  'diff.relative',
  'submodule.active',
])

/**
 * Sections in which no key, with or without a subsection, names a program.
 * Keep this list to sections audited in full: one executable key anywhere in a
 * section rules it out.
 */
const INERT_SECTIONS = new Set([
  'advice',
  'am',
  'apply',
  'blame',
  'branch',
  'checkout',
  'clone',
  'color',
  'column',
  'feature',
  'gc',
  'grep',
  'i18n',
  'index',
  'log',
  'pack',
  'rebase',
  'rerere',
  'stash',
  'status',
  'tag',
  'versionsort',
  'worktree',
])

/** `remote.<name>.<key>` keys that only name refs and URLs. */
const INERT_REMOTE_KEYS = new Set([
  'url',
  'pushurl',
  'fetch',
  'push',
  'tagopt',
  'prune',
  'prunetags',
  'mirror',
  'skipdefaultupdate',
  'skipfetchall',
  'promisor',
  'partialclonefilter',
])

/** `submodule.<name>.<key>` keys `git submodule init/update/add` write. */
const INERT_SUBMODULE_KEYS = new Set([
  'url',
  'active',
  'branch',
  'fetchrecursesubmodules',
  'ignore',
  'shallow',
])

/** `submodule.<name>.update` may be `!command`; only the built-in modes are inert. */
const INERT_SUBMODULE_UPDATE_MODES = new Set(['checkout', 'rebase', 'merge', 'none'])

/** Exactly what `git lfs install --local` writes. */
const LFS_FILTER_VALUES = new Map<string, string>([
  ['clean', 'git-lfs clean -- %f'],
  ['smudge', 'git-lfs smudge -- %f'],
  ['process', 'git-lfs filter-process'],
  ['required', 'true'],
])

export interface GitConfigEntry {
  /** As `git config --list` prints it: section and name lower case, subsection as written. */
  readonly key: string
  /** `null` for a bare boolean key (`[core] bare`). */
  readonly value: string | null
}

function splitKey(key: string): { section: string; subsection: string | null; name: string } {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  if (first < 0) return { section: key, subsection: null, name: '' }
  return {
    section: key.slice(0, first).toLowerCase(),
    subsection: first === last ? null : key.slice(first + 1, last),
    name: key.slice(last + 1).toLowerCase(),
  }
}

/** Whether git never runs a program because of this entry, whoever runs git later. */
export function isInertGitConfigEntry(entry: GitConfigEntry): boolean {
  const { section, subsection, name } = splitKey(entry.key)
  if (INERT_SECTIONS.has(section)) return true
  if (section === 'lfs') {
    // `lfs.url`, `lfs.<url>.access` and the like. Custom transfer agents and
    // extensions name programs.
    return subsection === null || !/^(customtransfer|extension)\./i.test(subsection)
  }
  if (subsection === null) return INERT_PLAIN_KEYS.has(`${section}.${name}`)
  switch (section) {
    case 'remote':
      return INERT_REMOTE_KEYS.has(name)
    case 'submodule':
      if (name === 'update') {
        return entry.value !== null && INERT_SUBMODULE_UPDATE_MODES.has(entry.value)
      }
      return INERT_SUBMODULE_KEYS.has(name)
    case 'filter':
      return subsection === 'lfs' && LFS_FILTER_VALUES.get(name) === entry.value
    default:
      return false
  }
}

/** Parse `git config --null --list` output. */
export function parseGitConfigList(stdout: string): GitConfigEntry[] {
  const entries: GitConfigEntry[] = []
  for (const record of stdout.split('\0')) {
    if (record === '') continue
    const newline = record.indexOf('\n')
    entries.push(
      newline < 0
        ? { key: record, value: null }
        : { key: record.slice(0, newline), value: record.slice(newline + 1) },
    )
  }
  return entries
}

/**
 * The entries of `config` that could run a program, as a sorted multiset of
 * `key=value` strings: two configs with equal results start the same programs.
 */
export function executableGitConfigEntries(entries: readonly GitConfigEntry[]): string[] {
  return entries
    .filter((entry) => !isInertGitConfigEntry(entry))
    .map((entry) => (entry.value === null ? entry.key : `${entry.key}=${entry.value}`))
    .sort()
}

/** Keys whose executable entries differ between two parsed configs, for the audit trail. */
export function changedExecutableGitConfigKeys(
  before: readonly GitConfigEntry[],
  after: readonly GitConfigEntry[],
): string[] {
  const values = (entries: readonly GitConfigEntry[]): Map<string, string[]> => {
    const map = new Map<string, string[]>()
    for (const entry of entries) {
      if (isInertGitConfigEntry(entry)) continue
      const list = map.get(entry.key) ?? []
      list.push(entry.value ?? '')
      map.set(entry.key, list)
    }
    return map
  }
  const a = values(before)
  const b = values(after)
  const keys = new Set([...a.keys(), ...b.keys()])
  return [...keys]
    .filter((key) => JSON.stringify(a.get(key) ?? []) !== JSON.stringify(b.get(key) ?? []))
    .sort()
}
