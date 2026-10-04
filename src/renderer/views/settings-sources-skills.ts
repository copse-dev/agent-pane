import type { ApiClient } from '../../preload/api.d.ts'
import type { SkillMetadata, SkillsSourcesResult } from '@shared/types/skills.ts'

export type SourceRowFactory = (
  title: string,
  badge: string | null,
  detail: string | null,
  opts?: {
    badgeClass?: string | undefined
    extraBadges?: Array<{ text: string; className: string }>
    titleAttr?: string | undefined
    hoverDetail?: string | undefined
    titleAction?: { label: string; run: () => void }
  },
) => HTMLElement

export const skillsSourcesMarkup = `
  <fieldset id="sources-skills-fieldset">
    <legend>Skills</legend>
    <p class="settings-fieldset-desc">Skill origins, invocation controls, and validation. Files refresh when Sources opens or you reload; changes apply to future turns.</p>
    <div id="sources-skills-list" class="sources-group"></div>
    <div id="sources-skills-diagnostics" class="sources-group" aria-label="Skill validation diagnostics"></div>
    <details class="sources-skill-folders">
      <summary>Extra skill folders</summary>
      <label for="sources-skill-roots">Absolute folder paths, one per line, in precedence order</label>
      <textarea id="sources-skill-roots" rows="3" spellcheck="false"></textarea>
      <p class="settings-fieldset-desc">Folders may contain skills directly or a Cursor plugin. These sources remain untrusted; adding a folder grants no tool permissions. Earlier sources win duplicate names.</p>
      <button type="button" class="ui-btn ui-btn-secondary" id="sources-skill-roots-save">Save folders</button>
    </details>
    <button type="button" class="ui-btn ui-btn-secondary" id="sources-skills-reload">Reload skills</button>
    <span id="sources-skills-status" role="status" aria-live="polite"></span>
  </fieldset>`

function metadataDetails(skill: SkillMetadata): HTMLDetailsElement | null {
  const entries: Array<[string, string]> = []
  if (skill.license !== undefined) entries.push(['License', skill.license])
  if (skill.compatibility !== undefined) entries.push(['Compatibility', skill.compatibility])
  if (skill.allowedTools !== undefined)
    entries.push(['Declared tools (descriptive only)', skill.allowedTools])
  for (const [key, value] of Object.entries(skill.metadata ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    entries.push([`Metadata: ${key}`, value])
  if (entries.length === 0) return null
  const details = document.createElement('details')
  details.className = 'sources-skill-metadata'
  const summary = document.createElement('summary')
  summary.textContent = 'Compatibility metadata'
  const list = document.createElement('dl')
  for (const [key, value] of entries) {
    const term = document.createElement('dt')
    term.textContent = key
    const definition = document.createElement('dd')
    definition.textContent = value
    list.append(term, definition)
  }
  details.append(summary, list)
  return details
}

export function mountSkillsSources({
  root,
  api,
  makeSourceRow,
}: {
  root: HTMLElement
  api: ApiClient
  makeSourceRow: SourceRowFactory
}): { refresh: (result: SkillsSourcesResult) => void; invalidate: () => void } {
  const list = root.querySelector('#sources-skills-list')
  const diagnostics = root.querySelector('#sources-skills-diagnostics')
  const folders = root.querySelector<HTMLTextAreaElement>('#sources-skill-roots')
  const save = root.querySelector<HTMLButtonElement>('#sources-skill-roots-save')
  const reload = root.querySelector<HTMLButtonElement>('#sources-skills-reload')
  const status = root.querySelector<HTMLElement>('#sources-skills-status')
  if (!list || !diagnostics || !folders || !save || !reload || !status)
    throw new Error('Missing skills Sources elements')
  let generation = 0

  const render = (result: SkillsSourcesResult): void => {
    if (!root.isConnected) return
    list.replaceChildren()
    diagnostics.replaceChildren()
    folders.value = result.extraRoots.join('\n')
    for (const skill of result.skills) {
      const controls = `${skill.userInvocable === false ? 'Manual off' : 'Manual on'} · ${skill.disableModelInvocation ? 'Model off' : 'Model on'}`
      const row = makeSourceRow(skill.name, skill.source, skill.description, {
        titleAttr: skill.skillPath,
        hoverDetail: skill.skillPath,
      })
      const eligibility = document.createElement('span')
      eligibility.className = 'sources-skill-controls'
      eligibility.textContent = controls
      row.append(eligibility)
      const details = metadataDetails(skill)
      if (details) row.append(details)
      list.append(row)
    }
    if (result.skills.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'sources-empty'
      empty.textContent = 'No skills discovered.'
      list.append(empty)
    }
    for (const diagnostic of result.diagnostics) {
      diagnostics.append(
        makeSourceRow(diagnostic.name || 'Skill source', diagnostic.kind, diagnostic.reason, {
          titleAttr: diagnostic.skillPath,
          hoverDetail: diagnostic.skillPath,
        }),
      )
    }
    window.dispatchEvent(new Event('copse:skills-changed'))
  }

  const perform = async (
    request: () => Promise<SkillsSourcesResult>,
    pending: string,
    completed: string,
  ): Promise<void> => {
    const revision = ++generation
    save.disabled = true
    reload.disabled = true
    status.textContent = pending
    try {
      const result = await request()
      if (!root.isConnected || revision !== generation) return
      render(result)
      status.textContent = completed
    } catch (error) {
      if (root.isConnected && revision === generation)
        status.textContent = error instanceof Error ? error.message : 'Could not refresh skills.'
    } finally {
      if (root.isConnected && revision === generation) {
        save.disabled = false
        reload.disabled = false
      }
    }
  }
  save.addEventListener('click', () => {
    const paths = folders.value
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
    void perform(
      () => api.skills.setRoots(paths),
      'Saving folders…',
      'Folders saved. Skills reloaded.',
    )
  })
  reload.addEventListener('click', () => {
    void perform(() => api.skills.sources(), 'Reloading skills…', 'Skills reloaded.')
  })
  return {
    invalidate(): void {
      generation++
      // Navigation invalidates pending replies. A failed owner-wide discovery
      // must still leave these independent controls available for retry.
      save.disabled = false
      reload.disabled = false
      status.textContent = ''
    },
    refresh(result): void {
      // A newer owner snapshot supersedes any pending subsection request.
      generation++
      if (!root.isConnected) return
      render(result)
      save.disabled = false
      reload.disabled = false
      status.textContent = ''
    },
  }
}
