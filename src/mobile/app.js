const pair = document.getElementById('pair')
const activity = document.getElementById('activity')
const thread = document.getElementById('thread')
const error = document.getElementById('error')
const groups = document.getElementById('groups')
const messages = document.getElementById('messages')
let token = localStorage.getItem('copse-mobile-token')
let selected = null

function show(view) {
  pair.hidden = view !== pair
  activity.hidden = view !== activity
  thread.hidden = view !== thread
}

function fail(message) {
  error.textContent = message
  error.hidden = !message
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { ...(options.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  if (response.status === 401) {
    token = null
    localStorage.removeItem('copse-mobile-token')
    show(pair)
    throw new Error('Pair this phone again from the desktop.')
  }
  if (!response.ok) throw new Error(`Desktop returned ${response.status}.`)
  return response.json()
}

function age(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function element(tag, className, content) {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function renderGroup(label, key, rows) {
  const section = element('section', 'group')
  const heading = element('div', 'group-heading')
  heading.append(element('span', '', label), element('span', 'group-count', String(rows.length)))
  section.append(heading)
  if (rows.length === 0)
    section.append(
      element(
        'div',
        'empty',
        key === 'needs-you'
          ? 'No decisions waiting for you.'
          : key === 'working'
            ? 'No threads running right now.'
            : 'Completed threads will appear here.',
      ),
    )
  for (const row of rows) {
    const button = element('button', 'row')
    button.type = 'button'
    const top = element('span', 'row-top')
    const state = element(
      'span',
      `state ${key === 'needs-you' ? 'urgent' : ''}`,
      row.state.replaceAll('-', ' '),
    )
    top.append(state, element('span', 'time', age(row.lastSavedAt)))
    button.append(
      top,
      element('span', 'row-title', row.title),
      element('span', 'row-detail', `${row.detail} · ${row.projectName}`),
    )
    button.addEventListener('click', () => openThread(row))
    section.append(button)
  }
  return section
}

async function refresh() {
  if (!token || selected) return
  try {
    const data = await api('/api/activity')
    fail('')
    groups.replaceChildren(
      renderGroup(
        'NEEDS YOU',
        'needs-you',
        data.rows.filter((row) => row.group === 'needs-you'),
      ),
      renderGroup(
        'WORKING',
        'working',
        data.rows.filter((row) => row.group === 'working'),
      ),
      renderGroup(
        'RECENT',
        'recent',
        data.rows.filter((row) => row.group === 'recent'),
      ),
    )
    document.getElementById('freshness').textContent =
      `Updated ${age(data.refreshedAt)} · Read only`
    show(activity)
  } catch (cause) {
    fail(cause.message)
  }
}

async function openThread(row) {
  selected = row
  show(thread)
  document.getElementById('thread-title').textContent = row.title
  document.getElementById('thread-project').textContent = row.projectName
  messages.replaceChildren(element('p', 'empty', 'Loading completed output…'))
  try {
    const data = await api(
      `/api/thread/${encodeURIComponent(row.projectId)}/${encodeURIComponent(row.threadId)}`,
    )
    document.getElementById('attention').replaceChildren(
      ...data.attention.map((item) => {
        const card = element('section', 'attention')
        card.append(
          element('div', 'attention-title', item.title),
          element('pre', 'attention-body', item.body),
        )
        return card
      }),
    )
    messages.replaceChildren(
      ...data.messages.map((message) => {
        const card = element('article', 'message')
        card.append(element('div', 'message-role', message.role))
        if (message.summary) card.append(element('div', 'message-summary', message.summary))
        card.append(
          element(
            'p',
            'message-content',
            message.content || (message.summary ? 'Tool activity' : 'No saved text'),
          ),
        )
        return card
      }),
    )
    if (!data.messages.length)
      messages.append(
        element(
          'p',
          'empty',
          'No completed messages are saved yet. A running turn appears after it is persisted on the desktop.',
        ),
      )
    fail('')
  } catch (cause) {
    fail(cause.message)
  }
}

document.getElementById('back').addEventListener('click', () => {
  selected = null
  void refresh()
})
document.getElementById('pair-button').addEventListener('click', async () => {
  const button = document.getElementById('pair-button')
  const code = document.getElementById('pair-code')
  const status = document.getElementById('pair-status')
  button.disabled = true
  fail('')
  try {
    const requested = await api('/api/pair/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: document.getElementById('device-name').value.trim() }),
    })
    code.textContent = requested.code
    code.hidden = false
    status.textContent =
      'Check that this code matches the prompt on your desktop, then approve there.'
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const result = await api(`/api/pair/result?id=${encodeURIComponent(requested.id)}`)
      if (result.state === 'approved') {
        token = result.token
        localStorage.setItem('copse-mobile-token', token)
        code.hidden = true
        await refresh()
        return
      }
      if (result.state === 'denied') throw new Error('The desktop declined pairing.')
    }
    throw new Error('Pairing timed out. Try again.')
  } catch (cause) {
    fail(cause.message)
  } finally {
    button.disabled = false
    code.hidden = true
    status.textContent = ''
  }
})

show(token ? activity : pair)
if (token) void refresh()
setInterval(() => {
  if (token && !selected) void refresh()
}, 2500)
