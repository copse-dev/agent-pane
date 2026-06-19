import type { SkillSummary } from '@shared/types/skills.ts'
import { clear } from '../dom/helpers.ts'

export interface SkillPickerOptions {
  textarea: HTMLTextAreaElement
  inputBar: HTMLElement
  listSkills: () => Promise<SkillSummary[]>
}

export function initSkillPicker(opts: SkillPickerOptions): () => void {
  const { textarea, inputBar, listSkills } = opts

  const picker = document.createElement('div')
  picker.className = 'mention-picker skill-picker'
  picker.setAttribute('role', 'listbox')
  picker.hidden = true
  inputBar.append(picker)

  let slashStart = -1
  let selectedIdx = 0
  let currentSkills: SkillSummary[] = []
  let allSkills: SkillSummary[] | null = null

  async function ensureSkills(): Promise<SkillSummary[]> {
    if (!allSkills) allSkills = await listSkills()
    return allSkills
  }

  function filterSkills(query: string): SkillSummary[] {
    const skills = allSkills ?? []
    const q = query.toLowerCase()
    if (!q) return skills
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q),
    )
  }

  function renderPicker() {
    clear(picker)
    selectedIdx = 0
    currentSkills.forEach((skill, i) => {
      const item = document.createElement('div')
      item.className = `mention-item skill-item${i === 0 ? ' selected' : ''}`
      item.setAttribute('role', 'option')
      const name = document.createElement('div')
      name.className = 'skill-item-name'
      name.textContent = `/${skill.name}`
      const desc = document.createElement('div')
      desc.className = 'skill-item-desc'
      desc.textContent = skill.description
      item.append(name, desc)
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        selectItem(i)
      })
      picker.append(item)
    })
    picker.hidden = currentSkills.length === 0
  }

  async function updatePicker(query: string) {
    await ensureSkills()
    currentSkills = filterSkills(query)
    renderPicker()
  }

  function selectItem(idx: number) {
    const skill = currentSkills[idx]
    if (!skill) {
      hidePicker()
      return
    }
    const val = textarea.value
    const before = val.slice(0, slashStart)
    const after = val.slice(textarea.selectionStart)
    textarea.value = `${before}/${skill.name} ${after.replace(/^\S*/, '')}`
    const cursor = before.length + skill.name.length + 2
    textarea.setSelectionRange(cursor, cursor)
    hidePicker()
    textarea.focus()
  }

  function hidePicker() {
    picker.hidden = true
    slashStart = -1
  }

  function updateSelection() {
    picker
      .querySelectorAll('.mention-item')
      .forEach((el, i) => el.classList.toggle('selected', i === selectedIdx))
  }

  textarea.addEventListener('input', () => {
    const val = textarea.value
    const cursor = textarea.selectionStart
    const slashIdx = val.lastIndexOf('/', cursor - 1)
    if (slashIdx === -1) {
      hidePicker()
      return
    }
    const prefix = val.slice(slashIdx + 1, cursor)
    if (prefix.includes(' ') || prefix.includes('\n')) {
      hidePicker()
      return
    }
    slashStart = slashIdx
    void updatePicker(prefix)
  })

  textarea.addEventListener('keydown', (e) => {
    if (picker.hidden) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIdx = Math.min(selectedIdx + 1, currentSkills.length - 1)
      updateSelection()
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIdx = Math.max(selectedIdx - 1, 0)
      updateSelection()
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      selectItem(selectedIdx)
    }
    if (e.key === 'Escape') {
      hidePicker()
    }
  })

  document.addEventListener('mousedown', (e) => {
    if (!picker.contains(e.target as Node)) hidePicker()
  })

  return () => {
    hidePicker()
    allSkills = null
  }
}
