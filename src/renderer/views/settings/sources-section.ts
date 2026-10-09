import type { ApiClient } from '../../../preload/api.d.ts'
import type { ProjectInstructionSummary } from '@shared/types/instructions.ts'
import type { McpServerStatus } from '@shared/types/mcp.ts'
import { errorMessage } from '@shared/errors.ts'
import { formatByteSize } from '@shared/file-bytes.ts'
import { isNonEmptyString } from '@shared/nullish.ts'
import { qsRequired } from '../../dom/helpers.ts'
import { openAttachmentPreview } from '../../attachments/attachment-preview.ts'
import { showConfirmDialog } from '../confirm-dialog.ts'
import { makeSourceRow } from './source-row.ts'
import { mountSkillsSources } from '../settings-sources-skills.ts'

export interface SourcesSectionOptions {
  root: HTMLElement
  api: ApiClient
  onTrusted: (statuses: McpServerStatus[]) => void
  onHeadingsChanged: () => void
}

export interface SourcesSection {
  refresh: () => Promise<void>
  invalidate: () => void
}

/** Sources owns discovery, trust disclosures and hook dry-runs. */
export function createSourcesSection({
  root,
  api,
  onTrusted,
  onHeadingsChanged,
}: SourcesSectionOptions): SourcesSection {
  let generation = 0
  const skillSources = mountSkillsSources({ root, api, makeSourceRow })
  /**
   * Rows for Settings → Sources → Agents: what Copse found, what it skipped, and
   * what lost a name collision.
   *
   * Skipped and shadowed files get rows of their own rather than a console
   * warning. With three containers across two scopes, a definition silently
   * failing to appear — or quietly losing to a copy in another folder — is the
   * failure users actually hit, and it is unanswerable from the list alone.
   */
  function makeAgentRows(
    result: import('@shared/types/agents.ts').AgentsListResult,
  ): HTMLElement[] {
    const rows: HTMLElement[] = []

    for (const agent of result.agents) {
      const extraBadges: Array<{ text: string; className: string }> = [
        // The container is a directory name (`.cursor`, `.claude`): a literal,
        // shown as written rather than as a sentence-case label.
        { text: agent.container, className: 'ui-badge-literal' },
      ]
      if (agent.unsupportedFields.length > 0) {
        extraBadges.push({ text: 'partly supported', className: 'sources-badge-unsupported' })
      }
      const detail = [
        agent.description,
        ...agent.unsupportedFields.map((f) => `${f.field}: ${f.reason}`),
      ]
        .filter(isNonEmptyString)
        .join(' · ')
      rows.push(
        makeSourceRow(agent.name, agent.source, detail || null, {
          extraBadges,
          titleAttr: agent.agentPath,
          hoverDetail: agent.agentPath,
        }),
      )
    }

    for (const shadowed of result.shadowed) {
      rows.push(
        makeSourceRow(shadowed.name, shadowed.source, `overridden by ${shadowed.shadowedBy}`, {
          extraBadges: [{ text: 'overridden', className: 'sources-badge-warning' }],
          titleAttr: shadowed.agentPath,
          hoverDetail: shadowed.agentPath,
        }),
      )
    }

    for (const skipped of result.skipped) {
      rows.push(
        makeSourceRow(basenameOf(skipped.agentPath), skipped.source, skipped.reason, {
          extraBadges: [{ text: 'skipped', className: 'sources-badge-error' }],
          titleAttr: skipped.agentPath,
          hoverDetail: skipped.agentPath,
        }),
      )
    }

    return rows
  }

  /** Last path segment, for rows keyed by file rather than by agent name. */
  function basenameOf(path: string): string {
    return path.split(/[/\\]/).pop() ?? path
  }

  /** One Sources → Hooks row: event + scope/unsupported/error badges + command. */
  function makeHookRow(h: import('@shared/types/hooks.ts').HookSummary): HTMLElement {
    const extraBadges: Array<{ text: string; className: string }> = []
    if (h.supported === false) {
      extraBadges.push({ text: 'unsupported', className: 'sources-badge-unsupported' })
    }
    // The `sandbox: false` escape (F3, decision 7) runs the hook OUTSIDE the
    // project sandbox — badge it so the user sees the elevated risk they granted.
    if (h.sandbox === false) {
      extraBadges.push({ text: 'outside sandbox', className: 'sources-badge-unsandboxed' })
    }
    if (h.lastError) {
      extraBadges.push({ text: 'error', className: 'sources-badge-error' })
    }
    const familyLabel =
      h.family === 'claude' ? 'Claude Code' : h.family === 'copse' ? 'Copse' : 'Cursor'
    const title = h.family === 'claude' && h.matcher ? `${h.event} · ${h.matcher}` : h.event
    const detail = `${familyLabel} · ${h.command}`
    const row = makeSourceRow(title, h.scope, detail, {
      extraBadges,
    })
    if (h.lastError) {
      const errorEl = document.createElement('div')
      errorEl.className = 'sources-row-error'
      errorEl.textContent = `Last run failed: ${h.lastError}`
      row.append(errorEl)
    }
    addHookTester(row, h)
    return row
  }

  /**
   * Wire the G2 dry-run tester onto a hook row: a "Test" button that runs the
   * hook once against a synthetic payload for its event and shows
   * stdin/stdout/stderr/exit/duration + parse_ok + outcome summary. The dry run
   * never mutates live agent state (see `src/main/services/hooks/dry-run.ts`).
   */
  function addHookTester(row: HTMLElement, h: import('@shared/types/hooks.ts').HookSummary): void {
    const header = row.querySelector('.sources-row-header')
    if (!header) return
    const testBtn = document.createElement('button')
    testBtn.type = 'button'
    // A kit button, so it reads as a control beside the row's status badges
    // (USER, PROJECT) rather than as one more tracked-caps chip.
    testBtn.className = 'ui-btn ui-btn-secondary sources-hook-test-btn'
    testBtn.textContent = 'Test'
    testBtn.title = 'Dry-run this hook against a synthetic payload for its event'
    header.append(testBtn)

    const result = document.createElement('div')
    result.className = 'hook-test'
    result.hidden = true
    row.append(result)

    testBtn.addEventListener('click', () => {
      void runHookTest(h, testBtn, result)
    })
  }

  async function runHookTest(
    h: import('@shared/types/hooks.ts').HookSummary,
    btn: HTMLButtonElement,
    result: HTMLElement,
  ): Promise<void> {
    btn.disabled = true
    btn.textContent = 'Testing…'
    result.hidden = false
    result.innerHTML = ''
    const pending = document.createElement('div')
    pending.className = 'hook-test-summary'
    pending.textContent = 'Running dry-run…'
    result.append(pending)
    try {
      const req: import('@shared/types/hooks.ts').HookTestRequest = {
        family: h.family,
        event: h.event,
        command: h.command,
        source: h.source,
        scope: h.scope,
        ...(h.sandbox !== undefined ? { sandbox: h.sandbox } : {}),
      }
      const res = await api.hooks.test(req)
      renderHookTestResult(result, res)
    } catch {
      result.innerHTML = ''
      const err = document.createElement('div')
      err.className = 'hook-test-summary hook-test-error'
      err.textContent = 'Dry-run failed to start.'
      result.append(err)
    } finally {
      btn.disabled = false
      btn.textContent = 'Test'
    }
  }

  /** Render one `hooks:test` result: summary chips + labeled stdin/stdout/stderr streams. */
  function renderHookTestResult(
    container: HTMLElement,
    res: import('@shared/types/hooks.ts').HookTestResult,
  ): void {
    container.innerHTML = ''
    if (!res.ran) {
      const notice = document.createElement('div')
      notice.className = 'hook-test-summary hook-test-error'
      notice.textContent = res.error ?? 'This hook could not be dry-run.'
      container.append(notice)
      return
    }

    const summary = document.createElement('div')
    summary.className = 'hook-test-summary'
    const chips: string[] = []
    if (res.wireEvent) chips.push(`event ${res.wireEvent}`)
    if (res.timedOut) chips.push('timed out')
    else if (res.spawnError) chips.push('failed to start')
    chips.push(
      `exit ${res.exitCode === null || res.exitCode === undefined ? 'unknown' : String(res.exitCode)}`,
    )
    chips.push(`${String(res.durationMs ?? 0)} ms`)
    chips.push(res.parseOk ? 'parsed ok' : 'parse failed')
    if (res.sandboxed) chips.push('sandboxed')
    for (const text of chips) {
      const chip = document.createElement('span')
      chip.className = 'hook-test-chip'
      chip.textContent = text
      summary.append(chip)
    }
    container.append(summary)

    if (res.outcomeSummary) {
      const outcome = document.createElement('div')
      outcome.className = 'hook-test-outcome'
      outcome.textContent = `Outcome: ${res.outcomeSummary}`
      container.append(outcome)
    }

    appendHookTestStream(container, 'stdin', res.stdin ?? '')
    appendHookTestStream(container, 'stdout', res.stdout ?? '')
    appendHookTestStream(container, 'stderr', res.stderr ?? '')
  }

  function appendHookTestStream(container: HTMLElement, label: string, text: string): void {
    const block = document.createElement('div')
    block.className = 'hook-test-stream'
    const heading = document.createElement('div')
    heading.className = 'hook-test-stream-label'
    heading.textContent = label
    const pre = document.createElement('pre')
    pre.textContent = text.length > 0 ? text : '(empty)'
    if (text.length === 0) pre.classList.add('hook-test-stream-empty')
    block.append(heading, pre)
    container.append(block)
  }

  /** A hooks.json authoring problem (unknown event, bad entry, malformed file). */
  function makeHookWarningRow(
    w: import('@shared/types/hooks.ts').HookValidationWarning,
  ): HTMLElement {
    const row = makeSourceRow(w.message, w.scope, w.source, {
      extraBadges: [{ text: 'warning', className: 'sources-badge-warning' }],
    })
    row.classList.add('sources-row-warning')
    return row
  }

  function fillSourceList(selector: string, rows: HTMLElement[], emptyText: string): void {
    const list = qsRequired(root, selector)
    list.innerHTML = ''
    if (rows.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'sources-empty'
      empty.textContent = emptyText
      list.append(empty)
      return
    }
    for (const row of rows) list.append(row)
  }

  /**
   * Show one instruction file in the shared preview dialog, as plain text.
   *
   * Deliberately not rendered as markdown: this is the text that steers the
   * agent (and, for an untrusted workspace, the text the user is deciding
   * whether to trust), so it is shown exactly as the prompt would receive it
   * rather than as formatted prose that could hide its own markup.
   */
  function openInstructionFile(file: ProjectInstructionSummary): void {
    const session = openAttachmentPreview({
      kind: 'text',
      title: file.name,
      ariaLabel: `Instruction file: ${file.path}`,
      status: `Loading ${file.name}…`,
    })
    void api.instructions
      .read(file.path)
      .then((content) => {
        const text = document.createElement('pre')
        text.className = 'attachment-preview-text'
        text.textContent = content
        session.setContent(text)
      })
      .catch((error: unknown) => {
        session.setStatus(errorMessage(error))
      })
  }

  /** Both trust entry points land here: the MCP list and Sources must agree. */
  function applyWorkspaceTrusted(statuses: import('@shared/types/mcp.ts').McpServerStatus[]): void {
    onTrusted(statuses)
    void refreshSources()
  }

  /**
   * Trust the workspace from the Sources list. The MCP banner states the stakes
   * in its own copy before its button; a badge cannot, so the same consent —
   * including the `sandbox: false` hook warning (F3, decision 7) — is put in a
   * confirmation dialog rather than dropped.
   */
  async function trustWorkspaceFromBadge(button: HTMLButtonElement): Promise<void> {
    const unsandboxed = await api.workspace.unsandboxedProjectHooks().catch(() => [])
    const detail = [
      'Its instruction files join the system prompt, and the MCP servers and hooks it defines are allowed to run.',
      unsandboxed.length > 0
        ? `${String(unsandboxed.length)} of those hooks declare "sandbox": false and run OUTSIDE the project sandbox: ${unsandboxed
            .map((h) => `${h.event}: ${h.command}`)
            .join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' ')
    const confirmed = await showConfirmDialog({
      message: 'Trust this workspace?',
      detail,
      confirmLabel: 'Trust workspace',
    })
    if (!confirmed) return
    button.disabled = true
    const statusEl = qsRequired(root, '#sources-reload-status')
    statusEl.textContent = 'Trusting workspace…'
    // `setTrusted` only answers once the workspace's MCP servers have been
    // restarted — seconds, for a repo that defines any. The trust flag itself is
    // written before that starts, so reload the instruction list right away and
    // let the server statuses catch up. Settling both branches here (rather than
    // awaiting inside a try) keeps a rejection handled while that refresh runs.
    const pending = api.workspace.setTrusted(true).then(
      (statuses) => ({ statuses }),
      (error: unknown) => ({ error }),
    )
    await refreshSources()
    const result = await pending
    if ('statuses' in result) applyWorkspaceTrusted(result.statuses)
    // The row was rebuilt above, so the failed badge is already clickable again;
    // this says why nothing happened.
    else statusEl.textContent = errorMessage(result.error)
  }

  /**
   * One Sources → Instructions row. The name opens the file; an inert
   * (untrusted) file's badge is the button that trusts the workspace, so the
   * fix for "discovered but not loaded" sits on the thing reporting it.
   */
  function makeInstructionRow(file: ProjectInstructionSummary): HTMLElement {
    const nestedStatus =
      file.scopePath === undefined
        ? ''
        : file.duplicateOf !== undefined
          ? ` · scope: ${file.scopePath}/ · identical to ${file.duplicateOf}, loaded once through it`
          : file.active
            ? ` · scope: ${file.scopePath}/ · active this turn`
            : ` · scope: ${file.scopePath}/ · activates when a path under this directory enters context`
    const detail =
      `${file.path} · ${formatByteSize(file.bytes)}` +
      (file.trusted
        ? nestedStatus
        : ' · inert until you trust this workspace — click the badge to trust it')
    const badge = !file.trusted
      ? 'not loaded'
      : file.duplicateOf !== undefined
        ? 'duplicate'
        : file.scopePath !== undefined
          ? file.active
            ? 'active'
            : 'scoped'
          : file.scope
    const row = makeSourceRow(file.name, badge, detail, {
      badgeClass: !file.trusted
        ? 'sources-badge-untrusted'
        : file.scopePath !== undefined && file.active && file.duplicateOf === undefined
          ? 'sources-badge-active'
          : undefined,
      titleAction: {
        label: `Open ${file.name}`,
        run: () => {
          openInstructionFile(file)
        },
      },
    })
    if (file.trusted) return row

    const badgeEl = row.querySelector<HTMLElement>('.sources-badge')
    if (badgeEl) {
      const trustBtn = document.createElement('button')
      trustBtn.type = 'button'
      trustBtn.className = `${badgeEl.className} sources-badge-btn`
      trustBtn.textContent = badgeEl.textContent
      trustBtn.title = `Trust this workspace to load ${file.name}`
      trustBtn.setAttribute('aria-label', `Trust this workspace to load ${file.name}`)
      trustBtn.addEventListener('click', () => {
        void trustWorkspaceFromBadge(trustBtn)
      })
      badgeEl.replaceWith(trustBtn)
    }
    return row
  }

  async function refreshSources(): Promise<void> {
    const statusEl = qsRequired(root, '#sources-reload-status')
    const request = ++generation
    statusEl.textContent = 'Loading…'
    try {
      const [instructions, cursorRules, skills, agents, hooks] = await Promise.all([
        api.instructions.list(),
        api.cursorRules.list(),
        api.skills.sources(),
        api.agents.list(),
        api.hooks.list(),
      ])

      if (request !== generation) return
      fillSourceList(
        '#sources-instructions-list',
        instructions.map((f) => makeInstructionRow(f)),
        'No instruction files (add AGENT.md, AGENTS.md, or CLAUDE.md to the workspace root; nested directories may add AGENTS.md; or add ~/AGENTS.md globally).',
      )
      // Discovery is bounded; say so rather than let a missing nested file
      // look like it was never written.
      if (instructions.some((f) => f.discoveryTruncated)) {
        const note = document.createElement('span')
        note.className = 'sources-empty'
        note.id = 'sources-instructions-truncated'
        note.textContent =
          'Nested AGENTS.md discovery stopped at its directory limit, so this list may be incomplete. Deeper files are not loaded.'
        qsRequired(root, '#sources-instructions-list').append(note)
      }

      const kindLabel: Record<string, string> = {
        always: 'always',
        auto: 'auto',
        agent: 'agent',
        manual: 'manual',
      }
      fillSourceList(
        '#sources-cursor-rules-list',
        cursorRules.map((r) => {
          const bits = [formatByteSize(r.bytes)]
          if (r.globs?.length) bits.push(`globs: ${r.globs.join(', ')}`)
          if (r.description) bits.push(r.description)
          bits.push(r.path)
          return makeSourceRow(r.name, kindLabel[r.kind] ?? r.kind, bits.join(' · '))
        }),
        'No Cursor rules (add .cursor/rules/*.mdc or a legacy .cursorrules file).',
      )
      // Most projects have no Cursor rules, and a fieldset whose only content is
      // "there are none" is noise: the section stays hidden until the workspace
      // actually has rules to disclose. Instruction files above already name
      // where rules would come from, so nothing is lost by the absence.
      qsRequired(root, '#cursor-rules-fieldset').hidden = cursorRules.length === 0
      // The sidebar contents list is read off the DOM when a section opens, so a
      // fieldset that appears after that read has to ask for a re-read — unless
      // a search is running, which lifts blocks out of their sections and drops
      // the contents list on purpose.
      if (!root.querySelector('.settings-content')?.classList.contains('settings-searching'))
        onHeadingsChanged()

      skillSources.refresh(skills)

      fillSourceList('#sources-agents-list', makeAgentRows(agents), 'No agents discovered.')

      fillSourceList(
        '#sources-hooks-list',
        [...hooks.warnings.map(makeHookWarningRow), ...hooks.hooks.map(makeHookRow)],
        'No Cursor or Claude Code hooks configured.',
      )

      statusEl.textContent = ''
    } catch {
      if (request !== generation) return
      statusEl.textContent = 'Failed to load sources.'
    }
  }

  qsRequired(root, '#sources-reload-btn').addEventListener('click', () => {
    void refreshSources()
  })
  return {
    refresh: refreshSources,
    invalidate: (): void => {
      generation += 1
      skillSources.invalidate()
    },
  }
}
