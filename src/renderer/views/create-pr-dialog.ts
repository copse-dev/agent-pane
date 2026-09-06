import { el, clear } from '../dom/helpers.ts'

export interface CreatePrChoice {
  title: string
  body: string
  draft: boolean
}

/**
 * The dialog behind the "Create PR" follow-up bubble.
 *
 * Opening a pull request is the one action in this row that is visible outside
 * the machine, so unlike the changeset chip it does not fire on click: the
 * dialog collects what is awkward to fix afterwards — the title, the
 * description, and whether this goes up as a draft — and only then publishes.
 * Draft defaults off because most branches that reach this chip are finished;
 * the toggle is one keystroke away for the ones that are not.
 *
 * The description arrives asynchronously (`bodyPromise`): the model writes it
 * while the dialog is open, so the wait overlaps with the user reading the
 * dialog instead of following their confirmation. Anything they type wins — a
 * suggestion that lands late never overwrites an edit in progress.
 *
 * Resolves with the choice, or null when cancelled.
 */
let dialogEl: HTMLDialogElement | null = null

function ensureDialog(): HTMLDialogElement {
  if (dialogEl) return dialogEl
  dialogEl = el('dialog', { id: 'create-pr-dialog', class: 'create-pr-dialog' })
  document.body.append(dialogEl)
  return dialogEl
}

export function openCreatePrDialog(opts: {
  /** Prefills the title field — the thread's own title, when it has one. */
  suggestedTitle?: string
  /** Shown under the title so the user knows what is about to be published. */
  branch?: string | null
  draft?: boolean
  /** In-flight description proposal; null/rejected leaves the field empty. */
  bodyPromise?: Promise<string | null>
}): Promise<CreatePrChoice | null> {
  const dialog = ensureDialog()
  clear(dialog)

  const titleInput = el('input', {
    type: 'text',
    class: 'create-pr-dialog-title-input',
    id: 'create-pr-dialog-title',
    placeholder: 'Summarise the change',
    value: opts.suggestedTitle?.trim() ?? '',
  })
  // `value` as an attribute only seeds the default; set the property too so a
  // reused dialog does not show the previous open's text.
  titleInput.value = opts.suggestedTitle?.trim() ?? ''

  const bodyInput = el('textarea', {
    class: 'create-pr-dialog-body-input',
    id: 'create-pr-dialog-body',
    rows: '6',
    placeholder: opts.bodyPromise ? 'Writing a description…' : 'Optional',
  })
  bodyInput.value = ''
  // Whether the field is still the model's to fill. Any keystroke hands it to
  // the user for good: a proposal that arrives mid-sentence must not clobber
  // what they are writing, and must not silently discard it either.
  let bodyIsUsers = false
  bodyInput.addEventListener('input', () => {
    bodyIsUsers = true
  })
  if (opts.bodyPromise) {
    bodyInput.classList.add('is-pending')
    void opts.bodyPromise
      .then((suggested) => {
        bodyInput.classList.remove('is-pending')
        bodyInput.placeholder = 'Optional'
        if (bodyIsUsers || !suggested) return
        bodyInput.value = suggested
      })
      .catch(() => {
        bodyInput.classList.remove('is-pending')
        bodyInput.placeholder = 'Optional'
      })
  }

  const draftInput = el('input', {
    type: 'checkbox',
    class: 'create-pr-dialog-draft-input',
    id: 'create-pr-dialog-draft',
    'aria-label': 'Create as draft',
  })
  draftInput.checked = opts.draft ?? false
  // The app's own boolean control (settings plugins, MCP servers): the rounded
  // track with the accent fill. A native checkbox would be the only one in the
  // product, and it paints Chromium's blue rather than the theme accent. The
  // track must stay the input's immediate sibling — `.toggle-switch
  // input:checked + .toggle-switch-track` is what fills it.
  const draftToggle = el(
    'label',
    { class: 'toggle-switch create-pr-dialog-draft-toggle' },
    draftInput,
    el('span', { class: 'toggle-switch-track', 'aria-hidden': 'true' }),
  )

  const createBtn = el(
    'button',
    { type: 'button', class: 'ui-btn ui-btn-primary create-pr-dialog-create' },
    'Create pull request',
  )
  const cancelBtn = el(
    'button',
    { type: 'button', class: 'ui-btn create-pr-dialog-cancel' },
    'Cancel',
  )

  const syncCreateLabel = (): void => {
    createBtn.textContent = draftInput.checked ? 'Create draft PR' : 'Create pull request'
  }
  syncCreateLabel()
  draftInput.addEventListener('change', syncCreateLabel)

  // A pull request needs a title and nothing here writes one: the create runs
  // no model, and the IPC guard rejects an empty title with a raw validation
  // error. Gate the button on the trimmed value instead, so the only way to
  // press Create is with something `gh` will accept.
  const syncCreateEnabled = (): void => {
    createBtn.disabled = titleInput.value.trim().length === 0
  }
  syncCreateEnabled()
  titleInput.addEventListener('input', syncCreateEnabled)

  dialog.append(
    el('h3', {}, 'Create pull request'),
    el(
      'div',
      { class: 'create-pr-dialog-field' },
      el('label', { for: 'create-pr-dialog-title' }, 'Title'),
      titleInput,
    ),
    el(
      'div',
      { class: 'create-pr-dialog-field' },
      el('label', { for: 'create-pr-dialog-body' }, 'Description'),
      bodyInput,
    ),
    el(
      'div',
      { class: 'create-pr-dialog-draft' },
      draftToggle,
      el(
        'div',
        { class: 'create-pr-dialog-draft-text' },
        el('label', { for: 'create-pr-dialog-draft' }, 'Create as draft'),
        el(
          'span',
          { class: 'create-pr-dialog-draft-hint' },
          'Opens without requesting review or notifying reviewers.',
        ),
      ),
    ),
    // Be explicit about the publish boundary: confirmation pushes committed
    // branch state before opening the PR, while working-tree edits stay local.
    el(
      'p',
      { class: 'field-hint create-pr-dialog-hint' },
      opts.branch
        ? `Pushes committed changes on ${opts.branch}, then opens a pull request into the default branch. Uncommitted changes are not included.`
        : 'Pushes committed changes on this branch, then opens a pull request into the default branch. Uncommitted changes are not included.',
    ),
    el('div', { class: 'create-pr-dialog-actions' }, cancelBtn, createBtn),
  )

  return new Promise((resolve) => {
    let settled = false
    // The <dialog> is a module-level singleton reused across opens, so listeners
    // bound to it (rather than to this open's children) would stack up on every
    // call. Tie them to this open and drop them when it settles.
    const perOpen = new AbortController()
    const finish = (value: CreatePrChoice | null): void => {
      if (settled) return
      settled = true
      perOpen.abort()
      dialog.close()
      resolve(value)
    }

    dialog.addEventListener(
      'cancel',
      () => {
        finish(null)
      },
      { signal: perOpen.signal },
    )
    cancelBtn.addEventListener('click', () => {
      finish(null)
    })
    createBtn.addEventListener('click', () => {
      const title = titleInput.value.trim()
      // Belt and braces with the disabled state: a synthetic click on a
      // disabled button still must not publish a PR with no title.
      if (!title) return
      finish({ title, body: bodyInput.value.trim(), draft: draftInput.checked })
    })
    // Enter in the title advances to the description rather than submitting.
    // Submitting here would publish whatever the description field happened to
    // hold — quite possibly nothing, because the proposal is still in flight.
    titleInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      bodyInput.focus()
    })

    dialog.showModal()
    titleInput.focus()
    titleInput.select()
  })
}
