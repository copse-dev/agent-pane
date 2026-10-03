const workbench = document.querySelector('.workbench')
const note = document.querySelector('#view-note')
let selectedPr = '42'
let toastTimer

function toast(message) {
  const element = document.querySelector('#toast')
  element.textContent = message
  element.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    element.hidden = true
  }, 3500)
}

function showView(view) {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.view === view))
  })
  document.querySelectorAll('.view').forEach((section) => {
    section.hidden = section.id !== `${view}-view`
  })
  document.querySelector('.view-body').scrollTop = 0
  note.textContent = {
    overview: 'A compact header leaves room for the description and latest feedback.',
    comments: 'Rich comments, quiet metadata, and clear review outcomes.',
    checks: 'Failures first. Running jobs stay visible. Passed checks fold away.',
    files: 'A dedicated Files tab lets the existing diff viewer use the full height.',
  }[view]
  const url = new URL(location.href)
  url.searchParams.set('view', view)
  window.history.replaceState(null, '', url)
}

function checkRow(name, tone, status, duration, excerpt = '') {
  const icons = { error: '×', warning: '◷', success: '✓', muted: '−' }
  const row = document.createElement('div')
  row.className = 'check-row'
  row.innerHTML = `<span class="check-icon ${tone}" aria-hidden="true">${icons[tone]}</span><div class="check-main"><div class="check-name">${name}</div><div class="check-meta"><span class="${tone}">${status}</span> · ${duration}</div>${excerpt ? `<div class="failure-excerpt">${excerpt}</div>` : ''}</div><a href="https://github.com/copse-dev/copse-panel/pull/${selectedPr}/checks" target="_blank" rel="noreferrer" aria-label="Open ${name} details on GitHub">Details ↗</a>`
  return row
}

function renderChecks() {
  const failing = selectedPr === '88'
  const running = selectedPr === '17'
  document.querySelector('#check-count').textContent = failing ? '5' : '2'
  document.querySelector('#sha').textContent = failing ? 'b3219fc' : 'a4e9c82'
  document.querySelector('#checks-heading').textContent = failing
    ? '1 failed · 1 running'
    : running
      ? '1 check still running'
      : 'All checks passed'
  document.querySelector('#checks-note').textContent = failing
    ? 'Failures remain visible while other checks finish.'
    : running
      ? 'Results for the current head commit.'
      : '2 passed · Results for this commit'
  const host = document.querySelector('#checks-content')
  host.replaceChildren()
  if (failing) {
    const attention = document.createElement('section')
    attention.className = 'check-group'
    attention.innerHTML = '<h3 class="check-group-title">Needs attention <span>1</span></h3>'
    attention.append(
      checkRow(
        'Electron e2e / Linux',
        'error',
        'Failed',
        '2m 14s',
        'pr-panel-activity.e2e.ts<br>Expected failed checks to remain visible.',
      ),
    )
    const actions = document.createElement('div')
    actions.className = 'checks-action'
    actions.innerHTML =
      '<button class="button" data-action="Rerun failed checks">Rerun failed checks</button>'
    attention.append(actions)
    host.append(attention)
  }
  if (failing || running) {
    const group = document.createElement('section')
    group.className = 'check-group'
    group.innerHTML = '<h3 class="check-group-title">In progress <span>1</span></h3>'
    group.append(checkRow('Build / macOS', 'warning', 'Running', 'Started 3m ago'))
    host.append(group)
  }
  const passed = document.createElement('details')
  passed.className = 'check-group'
  passed.open = !failing
  passed.innerHTML = `<summary class="check-group-title">Passed <span>${failing || running ? '1' : '2'}</span></summary>`
  passed.append(checkRow('Typecheck and lint', 'success', 'Passed', '42s'))
  if (!failing && !running)
    passed.append(checkRow('Electron e2e / Linux', 'success', 'Passed', '2m 14s'))
  host.append(passed)
  if (failing) {
    const other = document.createElement('details')
    other.className = 'check-group'
    other.innerHTML = '<summary class="check-group-title">Other results <span>2</span></summary>'
    other.append(
      checkRow('Release preview', 'muted', 'Skipped', 'Not run'),
      checkRow('Previous build', 'muted', 'Cancelled', 'Superseded'),
    )
    host.append(other)
  }
}

function choosePr(pr) {
  selectedPr = pr
  const titles = {
    42: 'Add GitHub PR panel tab',
    88: 'Tidy up workspace status polling',
    17: 'Polish footer branch status',
  }
  document.querySelector('#pr-title').textContent = titles[pr]
  document.querySelector('#pr-number').textContent = `#${pr}`
  document.querySelector('#branch').textContent =
    pr === '88' ? 'chore/workspace-status' : pr === '17' ? 'fix/footer-status' : 'feature/pr-panel'
  document.querySelector('#github').href = `https://github.com/copse-dev/copse-panel/pull/${pr}`
  document.querySelectorAll('[data-pr]').forEach((row) => {
    row.classList.toggle('selected', row.dataset.pr === pr)
    row.setAttribute('aria-pressed', String(row.dataset.pr === pr))
  })
  document.querySelector('#thread').textContent = pr === '42' ? 'Open chat ↗' : 'New thread'
  document.querySelectorAll('.action-menu').forEach((menu) => {
    menu.hidden = true
  })
  document
    .querySelectorAll('[aria-controls]')
    .forEach((button) => button.setAttribute('aria-expanded', 'false'))
  renderChecks()
  showView(pr === '42' ? 'comments' : 'checks')
}

document
  .querySelectorAll('[data-view]')
  .forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)))
document
  .querySelectorAll('[data-pr]')
  .forEach((button) => button.addEventListener('click', () => choosePr(button.dataset.pr)))
document.querySelector('#jump-comments').addEventListener('click', () => showView('comments'))
document.querySelector('#width').addEventListener('change', (event) => {
  workbench.dataset.width = event.target.value
})
document.querySelector('#theme').addEventListener('click', (event) => {
  const light = document.documentElement.dataset.theme !== 'light'
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  event.target.textContent = light ? 'Dark theme' : 'Light theme'
})
document.querySelector('#filter').addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase()
  let count = 0
  document.querySelectorAll('[data-pr]').forEach((row) => {
    row.hidden = !row.textContent.toLowerCase().includes(query)
    if (!row.hidden) count++
  })
  document.querySelector('.other-prs').open = Boolean(query)
  document.querySelector('#filter-empty').hidden = count !== 0
})
document.querySelectorAll('[aria-controls]').forEach((button) =>
  button.addEventListener('click', () => {
    const menu = document.getElementById(button.getAttribute('aria-controls'))
    const open = menu.hidden
    document.querySelectorAll('.action-menu').forEach((other) => {
      other.hidden = true
    })
    document
      .querySelectorAll('[aria-controls]')
      .forEach((other) => other.setAttribute('aria-expanded', 'false'))
    menu.hidden = !open
    button.setAttribute('aria-expanded', String(open))
  }),
)
document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')
  if (action) toast(`${action.dataset.action}: preview only. No GitHub action was sent.`)
  if (!event.target.closest('.action-menu, [aria-controls]')) {
    document.querySelectorAll('.action-menu').forEach((menu) => {
      menu.hidden = true
    })
    document
      .querySelectorAll('[aria-controls]')
      .forEach((button) => button.setAttribute('aria-expanded', 'false'))
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  document.querySelectorAll('[aria-controls]').forEach((button) => {
    if (button.getAttribute('aria-expanded') === 'true') button.focus()
    button.setAttribute('aria-expanded', 'false')
  })
  document.querySelectorAll('.action-menu').forEach((menu) => {
    menu.hidden = true
  })
})
document
  .querySelector('#refresh')
  .addEventListener('click', () =>
    toast('Mock data refreshed. This prototype does not connect to GitHub.'),
  )
document
  .querySelector('#thread')
  .addEventListener('click', () => toast('Chat navigation preview. No thread was opened.'))
document.querySelector('.copy-code').addEventListener('click', async (event) => {
  try {
    await window.navigator.clipboard.writeText(
      event.target.closest('.code-block').querySelector('pre').textContent,
    )
    toast('Example code copied.')
  } catch {
    toast('Clipboard unavailable. Select the example code to copy it.')
  }
})
const initial = new URLSearchParams(location.search)
choosePr(['42', '88', '17'].includes(initial.get('pr')) ? initial.get('pr') : '42')
if (['overview', 'comments', 'checks', 'files'].includes(initial.get('view')))
  showView(initial.get('view'))
if (['wide', 'split', 'panel'].includes(initial.get('width'))) {
  workbench.dataset.width = initial.get('width')
  document.querySelector('#width').value = initial.get('width')
}
