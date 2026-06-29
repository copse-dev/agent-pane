import type * as Monaco from 'monaco-editor'
import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GhCliStatus, GhPrChecksState, GhPrDetails, GhPrSummary } from '@shared/types/git.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import { extractGithubPrUrls, githubPrKey } from '@shared/git/github-pr-url.ts'
import { renderMarkdown } from '../markdown/renderer.ts'
import { sanitizeRenderedMarkdown } from '../markdown/sanitize.ts'
import { bindBrowserLinkClicks } from '../markdown/browser-links.ts'
import {
  createGitChangesDiffEditor,
  disposeDiffModels,
  observeDiffHostLayout,
  setGitFileDiffModel,
} from '../monaco/git-diff-viewer.ts'

interface PrRef {
  owner: string
  repo: string
  number: number
}

const STATUS_LABEL: Record<string, string> = {
  added: 'A',
  modified: 'M',
  removed: 'D',
  renamed: 'R',
}

function prsModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'prs'
}

function collectLinkedPrs(store: AppStore): PrRef[] {
  const thread = getActiveThread(store)
  if (!thread) return []
  const seen = new Set<string>()
  const refs: PrRef[] = []
  for (const message of thread.messages) {
    for (const parsed of extractGithubPrUrls(message.content)) {
      const key = githubPrKey(parsed)
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({ owner: parsed.owner, repo: parsed.repo, number: parsed.number })
    }
  }
  return refs
}

function mergePrLists(linked: PrRef[], pools: GhPrSummary[][]): GhPrSummary[] {
  const seen = new Set<string>()
  const merged: GhPrSummary[] = []
  const known = pools.flat()
  for (const ref of linked) {
    const key = githubPrKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    const fromPools = known.find(
      (pr) => pr.owner === ref.owner && pr.repo === ref.repo && pr.number === ref.number,
    )
    merged.push(
      fromPools ?? {
        ...ref,
        title: `PR #${ref.number}`,
        url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
        state: 'OPEN',
      },
    )
  }
  for (const pool of pools) {
    for (const pr of pool) {
      const key = githubPrKey(pr)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(pr)
    }
  }
  return merged
}

export function mountPrPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
  monaco: typeof Monaco,
): () => void {
  const listHeader = el('div', { class: 'git-changes-header' })
  listHeader.append(
    el('span', { class: 'git-changes-title' }, 'Pull requests'),
    el(
      'button',
      {
        type: 'button',
        class: 'git-changes-refresh-btn pr-pane-refresh-btn',
        'aria-label': 'Refresh pull requests',
        title: 'Refresh',
      },
      '↻',
    ),
  )
  const refreshBtn = listHeader.querySelector('.pr-pane-refresh-btn') as HTMLButtonElement
  const listBody = el('div', { class: 'git-changes-list pr-list-body' })
  listRoot.append(listHeader, listBody)

  const metaHost = el('div', { class: 'pr-viewer-meta' })
  const descriptionHost = el('div', { class: 'pr-viewer-description message-text' })
  const filesHost = el('div', { class: 'pr-viewer-files' })
  const diffWrap = el('div', { class: 'git-diff-editor-wrap' })
  const emptyState = el('div', { class: 'panel-empty' }, 'Select a pull request')
  viewerRoot.append(metaHost, descriptionHost, filesHost, diffWrap, emptyState)

  let ghStatus: GhCliStatus | null = null
  let linkedRefs: PrRef[] = []
  let myPrs: GhPrSummary[] = []
  let workspacePrs: GhPrSummary[] = []
  let prList: GhPrSummary[] = []
  let selectedPr: PrRef | null = null
  let prDetails: GhPrDetails | null = null
  let selectedFile: string | null = null
  let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null
  let selectRequestId = 0
  let diffLoadQueue: Promise<void> = Promise.resolve()
  let pendingOpen: PrRef | null = null

  // Cross-repo "your PRs" are lazy: not queried until the section is expanded,
  // so the default view costs only the workspace + chat-linked lookups.
  let otherExpanded = false
  let otherLoaded = false
  let otherLoading = false

  // Per-PR CI rollup. Workspace summaries arrive with `checks` already set;
  // chat-linked / cross-repo rows are filled in lazily and cached by PR key.
  // `ciGen` invalidates in-flight fetches across refreshes / workspace switches.
  const checksCache = new Map<string, GhPrChecksState>()
  const checksInFlight = new Set<string>()
  let ciEls = new Map<string, HTMLElement>()
  let ciGen = 0

  const CI_LABEL: Record<GhPrChecksState | 'loading', string> = {
    loading: 'Checking CI…',
    pending: 'CI running',
    success: 'CI passing',
    failure: 'CI failing',
    no_checks: 'No CI checks',
  }

  function knownChecks(pr: GhPrSummary): GhPrChecksState | undefined {
    return pr.checks ?? checksCache.get(githubPrKey(pr))
  }

  function applyCiClass(node: HTMLElement, state: GhPrChecksState | 'loading'): void {
    node.className = `pr-list-ci pr-list-ci-${state}`
    node.title = CI_LABEL[state]
  }

  function ensureCheck(pr: GhPrSummary): void {
    const key = githubPrKey(pr)
    if (knownChecks(pr) || checksInFlight.has(key)) return
    if (!ghStatus?.authenticated) return
    checksInFlight.add(key)
    const gen = ciGen
    void api.gh
      .prChecks(pr.owner, pr.repo, pr.number)
      .then((state) => {
        checksCache.set(key, state ?? 'no_checks')
      })
      .catch(() => {
        checksCache.set(key, 'no_checks')
      })
      .finally(() => {
        checksInFlight.delete(key)
        if (gen !== ciGen) return
        const node = ciEls.get(key)
        if (node) applyCiClass(node, checksCache.get(key) ?? 'no_checks')
      })
  }

  function ensureDiffEditor(): Monaco.editor.IStandaloneDiffEditor {
    if (!diffEditor) {
      const theme = store.getState().theme === 'dark' ? 'vs-dark' : 'vs'
      diffEditor = createGitChangesDiffEditor(diffWrap, monaco, store.getState().fontSize, theme)
    }
    return diffEditor
  }

  function renderGhUnavailable(): void {
    clear(listBody)
    const message =
      ghStatus?.message ??
      (ghStatus?.installed
        ? 'Sign in with `gh auth login` to browse pull requests here.'
        : 'Install GitHub CLI (`gh`) to browse pull requests in Copse.')
    listBody.append(el('div', { class: 'git-changes-empty pr-empty-state' }, message))
    clear(metaHost)
    clear(descriptionHost)
    clear(filesHost)
    diffWrap.hidden = true
    emptyState.hidden = false
    emptyState.textContent = ghStatus?.installed
      ? 'GitHub CLI is not authenticated'
      : 'GitHub CLI is not available'
  }

  function renderPrRow(
    pr: GhPrSummary,
    section: 'linked' | 'workspace' | 'mine',
  ): HTMLButtonElement {
    const isSelected =
      selectedPr?.owner === pr.owner &&
      selectedPr.repo === pr.repo &&
      selectedPr.number === pr.number
    const ci = el('span', {})
    const state = knownChecks(pr)
    applyCiClass(ci, state ?? 'loading')
    ciEls.set(githubPrKey(pr), ci)
    const row = el(
      'button',
      {
        type: 'button',
        class: `git-change-row pr-list-row${isSelected ? ' is-selected' : ''}`,
        'data-pr-section': section,
      },
      el('span', { class: 'pr-list-number' }, `#${pr.number}`),
      el('span', { class: 'git-change-path pr-list-title' }, pr.title),
      ci,
    )
    row.addEventListener('click', () => void selectPr(pr))
    if (!state) ensureCheck(pr)
    return row
  }

  function renderList(): void {
    clear(listBody)
    ciEls = new Map()

    const linkedKeys = new Set(linkedRefs.map((ref) => githubPrKey(ref)))
    const workspaceKeys = new Set(workspacePrs.map((pr) => githubPrKey(pr)))
    const linkedPrs = prList.filter((pr) => linkedKeys.has(githubPrKey(pr)))
    const repoPrs = prList.filter(
      (pr) => !linkedKeys.has(githubPrKey(pr)) && workspaceKeys.has(githubPrKey(pr)),
    )
    const otherPrs = prList.filter(
      (pr) => !linkedKeys.has(githubPrKey(pr)) && !workspaceKeys.has(githubPrKey(pr)),
    )

    if (!ghStatus?.installed || !ghStatus.authenticated) {
      if (linkedPrs.length === 0) {
        renderGhUnavailable()
        return
      }
      listBody.append(
        el(
          'div',
          { class: 'git-changes-empty pr-empty-state' },
          ghStatus?.message ??
            (ghStatus?.installed
              ? 'Sign in with `gh auth login` to load diffs and your open PRs.'
              : 'Install GitHub CLI (`gh`) to load diffs and your open PRs.'),
        ),
      )
    }

    if (linkedPrs.length > 0) {
      const section = el('div', { class: 'git-changes-section' })
      section.append(
        el('div', { class: 'git-changes-section-title' }, `From chat (${linkedPrs.length})`),
      )
      for (const pr of linkedPrs) section.append(renderPrRow(pr, 'linked'))
      listBody.append(section)
    }

    if (repoPrs.length > 0 && ghStatus?.authenticated) {
      const slug = `${repoPrs[0]!.owner}/${repoPrs[0]!.repo}`
      const section = el('div', { class: 'git-changes-section' })
      section.append(
        el(
          'div',
          { class: 'git-changes-section-title', title: `Open pull requests in ${slug}` },
          `${slug} (${repoPrs.length})`,
        ),
      )
      for (const pr of repoPrs) section.append(renderPrRow(pr, 'workspace'))
      listBody.append(section)
    }

    // "Your (other) open PRs" — collapsed by default and queried only on expand,
    // so we never spend a cross-repo search just to show a count.
    if (ghStatus?.authenticated) {
      const title =
        repoPrs.length > 0 || linkedPrs.length > 0 ? 'Your other open PRs' : 'Your open PRs'
      const section = el('div', { class: 'git-changes-section' })
      const header = el(
        'button',
        {
          type: 'button',
          class: 'git-changes-section-title pr-other-toggle',
          'aria-expanded': String(otherExpanded),
        },
        el('span', { class: 'pr-other-chevron' }, otherExpanded ? '▾' : '▸'),
        el('span', {}, title),
      )
      header.addEventListener('click', () => void toggleOther())
      section.append(header)
      if (otherExpanded) {
        if (otherLoading) {
          section.append(el('div', { class: 'git-changes-empty' }, 'Loading…'))
        } else if (otherPrs.length > 0) {
          for (const pr of otherPrs) section.append(renderPrRow(pr, 'mine'))
        } else {
          section.append(el('div', { class: 'git-changes-empty' }, 'No other open pull requests'))
        }
      }
      listBody.append(section)
    }
  }

  async function toggleOther(): Promise<void> {
    otherExpanded = !otherExpanded
    if (otherExpanded && !otherLoaded && !otherLoading) {
      otherLoading = true
      renderList()
      try {
        myPrs = (await api.gh.listMyOpenPrs()) ?? []
      } catch {
        myPrs = []
      }
      otherLoaded = true
      otherLoading = false
      prList = mergePrLists(linkedRefs, [workspacePrs, myPrs])
    }
    renderList()
  }

  function renderMeta(): void {
    clear(metaHost)
    if (!prDetails || !selectedPr) return
    const openBtn = el(
      'button',
      {
        type: 'button',
        class: 'pr-open-external-btn',
        title: 'Open on GitHub',
      },
      'Open on GitHub ↗',
    )
    const prUrl = prDetails.url
    openBtn.addEventListener('click', () => {
      void api.shell.openExternal(prUrl)
    })

    const stats: string[] = []
    if (typeof prDetails.changedFiles === 'number') stats.push(`${prDetails.changedFiles} files`)
    if (typeof prDetails.additions === 'number' || typeof prDetails.deletions === 'number') {
      stats.push(`+${prDetails.additions ?? 0} -${prDetails.deletions ?? 0}`)
    }
    if (prDetails.headRefName && prDetails.baseRefName) {
      stats.push(`${prDetails.headRefName} → ${prDetails.baseRefName}`)
    }

    metaHost.append(
      el(
        'div',
        { class: 'pr-viewer-title-row' },
        el('h3', { class: 'pr-viewer-title' }, prDetails.title),
      ),
      el(
        'div',
        { class: 'pr-viewer-subtitle' },
        `#${prDetails.number} · ${prDetails.owner}/${prDetails.repo}`,
        stats.length > 0 ? ` · ${stats.join(' · ')}` : '',
      ),
      el('div', { class: 'pr-viewer-actions' }, openBtn),
    )
  }

  function renderDescription(): void {
    clear(descriptionHost)
    if (!prDetails?.body.trim()) {
      descriptionHost.hidden = true
      return
    }
    descriptionHost.hidden = false
    descriptionHost.innerHTML = sanitizeRenderedMarkdown(renderMarkdown(prDetails.body))
  }

  function renderFiles(): void {
    clear(filesHost)
    if (!prDetails) {
      filesHost.hidden = true
      return
    }
    filesHost.hidden = false
    const header = el(
      'div',
      { class: 'pr-files-header' },
      `Changed files (${prDetails.files.length})`,
    )
    const list = el('div', { class: 'pr-files-list' })
    for (const file of prDetails.files) {
      const isSelected = selectedFile === file.path
      const row = el(
        'button',
        {
          type: 'button',
          class: `git-change-row pr-file-row${isSelected ? ' is-selected' : ''}`,
        },
        el(
          'span',
          { class: `git-change-status git-change-status-${file.status}` },
          STATUS_LABEL[file.status] ?? 'M',
        ),
        el('span', { class: 'git-change-path' }, file.path),
      )
      row.addEventListener('click', () => void selectFile(file.path))
      list.append(row)
    }
    filesHost.append(header, list)
  }

  function clearDiff(): void {
    selectRequestId++
    selectedFile = null
    diffWrap.hidden = true
    emptyState.hidden = false
    emptyState.textContent = prDetails ? 'Select a changed file' : 'Select a pull request'
    if (diffEditor) disposeDiffModels(diffEditor)
  }

  async function selectFile(path: string): Promise<void> {
    if (!selectedPr) return
    const requestId = ++selectRequestId
    selectedFile = path
    renderFiles()
    const diff = await api.gh.prFileDiff(selectedPr.owner, selectedPr.repo, selectedPr.number, path)
    if (requestId !== selectRequestId || selectedFile !== path) return
    if (!diff) {
      emptyState.hidden = false
      emptyState.textContent = 'Could not load diff'
      diffWrap.hidden = true
      return
    }
    diffLoadQueue = diffLoadQueue
      .catch(() => undefined)
      .then(async () => {
        if (requestId !== selectRequestId || selectedFile !== path) return
        emptyState.hidden = true
        diffWrap.hidden = false
        if (diff.deleted) {
          // Show a "deleted" badge instead of an empty diff for deleted files.
          clearDiff()
          emptyState.hidden = false
          emptyState.textContent = 'File was deleted in this pull request'
          return
        }
        await setGitFileDiffModel(ensureDiffEditor(), monaco, diff, viewerRoot)
      })
    await diffLoadQueue
  }

  async function selectPr(ref: PrRef | GhPrSummary): Promise<void> {
    selectedPr = { owner: ref.owner, repo: ref.repo, number: ref.number }
    prDetails = null
    selectedFile = null
    renderList()

    if (!ghStatus?.installed || !ghStatus.authenticated) {
      renderMeta()
      renderDescription()
      renderFiles()
      clearDiff()
      emptyState.hidden = false
      emptyState.textContent = ghStatus?.installed
        ? 'Sign in with GitHub CLI to load pull request details.'
        : 'Install GitHub CLI to load pull request details.'
      metaHost.append(
        el(
          'div',
          { class: 'pr-viewer-title-row' },
          el('h3', { class: 'pr-viewer-title' }, `#${ref.number} ${ref.owner}/${ref.repo}`),
        ),
        el(
          'div',
          { class: 'pr-viewer-subtitle' },
          `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
        ),
      )
      return
    }

    renderMeta()
    renderDescription()
    renderFiles()
    clearDiff()
    emptyState.hidden = false
    emptyState.textContent = 'Loading pull request…'

    try {
      prDetails = await api.gh.prDetails(ref.owner, ref.repo, ref.number)
    } catch (err) {
      emptyState.hidden = false
      emptyState.textContent = err instanceof Error ? err.message : 'Could not load pull request'
      return
    }

    if (!prDetails) {
      emptyState.hidden = false
      emptyState.textContent = 'Pull request not found'
      return
    }

    renderMeta()
    renderDescription()
    renderFiles()
    emptyState.hidden = false
    emptyState.textContent = 'Select a changed file'
  }

  function resetOther(): void {
    // A new listing context invalidates any in-flight CI fetches and the lazy
    // cross-repo list, which belongs to the previous workspace.
    ciGen++
    otherExpanded = false
    otherLoaded = false
    otherLoading = false
    myPrs = []
    checksCache.clear()
    checksInFlight.clear()
  }

  async function refresh(): Promise<void> {
    ghStatus = await api.gh.status()
    linkedRefs = collectLinkedPrs(store)
    resetOther()
    if (!ghStatus.installed || !ghStatus.authenticated) {
      workspacePrs = []
      prList = linkedRefs.map((ref) => ({
        ...ref,
        title: `PR #${ref.number}`,
        url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
        state: 'OPEN',
      }))
      renderList()
      return
    }

    // Only the workspace repo's open PRs (plus chat-linked ones) are fetched up
    // front; the cross-repo "your PRs" list is loaded lazily when expanded.
    workspacePrs = await api.gh.listWorkspaceOpenPrs().catch(() => [] as GhPrSummary[])
    prList = mergePrLists(linkedRefs, [workspacePrs])
    renderList()

    const openTarget = pendingOpen
    pendingOpen = null
    if (openTarget) {
      await selectPr(openTarget)
      return
    }

    if (selectedPr) {
      const stillExists = prList.some(
        (pr) =>
          pr.owner === selectedPr!.owner &&
          pr.repo === selectedPr!.repo &&
          pr.number === selectedPr!.number,
      )
      if (stillExists) {
        await selectPr(selectedPr)
        return
      }
    }

    if (linkedRefs.length > 0) {
      await selectPr(linkedRefs[0]!)
      return
    }
    if (prList[0]) await selectPr(prList[0])
    else clearDiff()
  }

  refreshBtn.addEventListener('click', () => void refresh())

  const unbindBrowserLinks = bindBrowserLinkClicks(descriptionHost, store, api)
  const stopObservingLayout = observeDiffHostLayout(viewerRoot, () => diffEditor)

  const unsubs = [
    store.on('right_panel_mode_changed', () => {
      if (prsModeActive(store)) void refresh()
    }),
    store.on('files_pane_changed', () => {
      if (prsModeActive(store)) void refresh()
    }),
    store.on('workspace_changed', () => {
      selectedPr = null
      prDetails = null
      // Everything below belongs to the previous workspace; drop it so a stale
      // repo section or CI dot can't flash before the refresh completes.
      workspacePrs = []
      prList = []
      resetOther()
      if (prsModeActive(store)) void refresh()
      else renderList()
    }),
    store.on('threads_changed', () => {
      if (!prsModeActive(store)) return
      linkedRefs = collectLinkedPrs(store)
      prList = mergePrLists(linkedRefs, [workspacePrs, myPrs])
      renderList()
    }),
    store.on('pr_open_requested', (owner, repo, number) => {
      pendingOpen = { owner, repo, number }
      if (prsModeActive(store)) void refresh()
    }),
    store.on('theme_changed', (theme) => {
      monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    }),
  ]

  renderList()
  clearDiff()

  return () => {
    stopObservingLayout()
    unbindBrowserLinks()
    unsubs.forEach((u) => u())
    diffEditor?.dispose()
    diffEditor = null
  }
}
