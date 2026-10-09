import { renderMessageContent } from './message-content.js'
import { installComposerFocus } from './composer-focus.js'

const pair = document.getElementById('pair')
const activity = document.getElementById('activity')
const thread = document.getElementById('thread')
const error = document.getElementById('error')
const groups = document.getElementById('groups')
const messages = document.getElementById('messages')
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme() {
  document.documentElement.dataset.theme = systemTheme.matches ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(
    document.body,
  ).backgroundColor
}

applyTheme()
systemTheme.addEventListener('change', applyTheme)

let token = localStorage.getItem('copse-mobile-token')
let selected = null
let sessionId = null
let access = 'read'
let runId = null
let refreshing = false
let sending = false
let decisionSignature = ''
let messageSignature = ''
let projectSignature = ''
const drafts = new Map()
const pendingActions = new Map()
const composer = document.getElementById('composer')
const messageInput = document.getElementById('message')
const actionStatus = document.getElementById('action-status')
const { focusComposer, revealComposer } = installComposerFocus()

function show(view) {
  pair.hidden = view !== pair
  activity.hidden = view !== activity
  thread.hidden = view !== thread
  document.getElementById('back').hidden = view !== thread
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
    selected = null
    localStorage.removeItem('copse-mobile-token')
    show(pair)
    throw new Error('Pair this phone again from the desktop.')
  }
  const data = await response.json()
  if (!response.ok) {
    const failure = new Error(data.error || `Desktop returned ${response.status}.`)
    failure.status = response.status
    throw failure
  }
  return data
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
    const state = element('span', `state ${row.state}`, row.state.replaceAll('-', ' '))
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
  if (!token || selected || refreshing) return
  refreshing = true
  try {
    const data = await api('/api/activity')
    if (selected) return
    access = data.access
    sessionId = data.sessionId
    document.getElementById('new-chat').hidden = access !== 'control'
    if (access !== 'control') document.getElementById('new-chat-form').hidden = true
    const projectSelect = document.getElementById('project')
    const nextProjects = JSON.stringify(data.projects)
    if (projectSignature !== nextProjects) {
      projectSignature = nextProjects
      const priorProject = projectSelect.value
      projectSelect.replaceChildren(
        ...data.projects.map((project) => {
          const option = element('option', '', project.name)
          option.value = project.id
          return option
        }),
      )
      if (data.projects.some((project) => project.id === priorProject))
        projectSelect.value = priorProject
    }
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
      `Updated ${age(data.refreshedAt)} · ${access === 'control' ? 'Chat and run control' : 'Read only · enable control on your Mac'}`
    show(activity)
  } catch (cause) {
    fail(cause.message)
  } finally {
    refreshing = false
  }
}

async function act(payload) {
  if (!sessionId || access !== 'control') throw new Error('Enable phone control on the Mac first.')
  const key = JSON.stringify(payload)
  // Retain the exact envelope after an uncertain network result. An explicit
  // retry then reaches the server's dedupe cache instead of starting two runs.
  let envelope = pendingActions.get(key)
  if (!envelope || envelope.sessionId !== sessionId) {
    envelope = { ...payload, requestId: crypto.randomUUID(), sessionId, issuedAt: Date.now() }
    pendingActions.set(key, envelope)
  }
  try {
    const result = await api('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    pendingActions.delete(key)
    return result
  } catch (cause) {
    if (cause.status && cause.status < 500) pendingActions.delete(key)
    throw cause
  }
}

function decisionButton(label, primary, callback) {
  const button = element('button', primary ? 'ui-btn ui-btn-primary' : 'ui-btn', label)
  button.type = 'button'
  button.addEventListener('click', callback)
  return button
}

function renderDecisions(data, row) {
  const signature = JSON.stringify([data.decisions, data.attention, data.access])
  if (signature === decisionSignature) return
  decisionSignature = signature
  const answerDrafts = new Map(
    [...document.querySelectorAll('#attention textarea')].map((input) => [input.id, input.value]),
  )
  const cards = data.decisions.map((decision) => {
    const card = element('section', 'attention')
    card.dataset.decisionId = decision.id
    const submit = async (answer) => {
      const buttons = [...card.querySelectorAll('button')]
      buttons.forEach((button) => {
        button.disabled = true
      })
      try {
        fail('')
        await act({
          ...answer,
          projectId: row.projectId,
          threadId: row.threadId,
          decisionId: decision.id,
        })
        actionStatus.textContent = 'Response sent.'
        await refreshThread()
      } catch (cause) {
        fail(cause.message)
        await refreshThread()
      } finally {
        buttons.forEach((button) => {
          button.disabled = false
        })
      }
    }
    if (decision.kind === 'approval') {
      card.append(element('div', 'attention-title', decision.title))
      if (decision.advice) card.append(element('p', 'decision-advice', decision.advice))
      card.append(element('pre', 'attention-body', decision.body))
      if (decision.footer) card.append(element('p', 'decision-advice', decision.footer))
      if (data.access === 'control') {
        const actions = element('div', 'decision-actions')
        actions.append(
          decisionButton('Deny', false, () => submit({ action: 'approval', approved: false })),
          decisionButton('Approve once', true, () =>
            submit({ action: 'approval', approved: true }),
          ),
        )
        card.append(actions)
      }
    } else {
      card.append(element('div', 'attention-title', 'Answer needed'))
      const inputs = decision.questions.map((question, index) => {
        const label = element('label', '', question.question)
        const input = element('textarea', 'answer')
        input.id = `answer-${decision.id}-${index}`
        input.value = answerDrafts.get(input.id) || ''
        input.maxLength = 8000
        input.rows = 2
        label.htmlFor = input.id
        card.append(label)
        if (data.access === 'control') {
          card.append(input)
          const options = element('div', 'answer-options')
          for (const option of question.options || [])
            options.append(
              decisionButton(option, false, () => {
                input.value = option
              }),
            )
          card.append(options)
        }
        return input
      })
      if (data.access === 'control')
        card.append(
          decisionButton('Send answers', true, () =>
            submit({ action: 'answer', answers: inputs.map((input) => input.value) }),
          ),
        )
    }
    return card
  })
  // Some external-agent prompts still have a desktop-only transport.
  if (!data.decisions.length)
    for (const item of data.attention) {
      const card = element('section', 'attention')
      card.append(
        element('div', 'attention-title', item.title),
        element('pre', 'attention-body', item.body),
        element('p', 'hint', 'Answer this prompt on the desktop.'),
      )
      cards.push(card)
    }
  const attention = document.getElementById('attention')
  const hadCards = attention.childElementCount > 0
  attention.replaceChildren(...cards)
  return cards.length > 0 && !hadCards
}

async function refreshThread() {
  const row = selected
  if (!token || !row) return
  try {
    const data = await api(
      `/api/thread/${encodeURIComponent(row.projectId)}/${encodeURIComponent(row.threadId)}`,
    )
    if (selected !== row) return
    access = data.access
    sessionId = data.sessionId
    runId = data.runId
    const composerWasHidden = composer.hidden
    composer.hidden = access !== 'control'
    if (composerWasHidden && !composer.hidden) focusComposer(messageInput)
    document.getElementById('stop').hidden = access !== 'control' || !runId
    document.getElementById('send').textContent = runId ? 'Queue message' : 'Send'
    document.getElementById('thread-title').textContent = data.title
    document.getElementById('thread-status').textContent =
      access !== 'control'
        ? 'Read only · Enable control in Mobile Companion on your Mac.'
        : runId
          ? 'Running · Saved output refreshes automatically.'
          : 'Send a message to continue this chat.'
    const promptArrived = renderDecisions(data, row)
    // Approvals sit below the messages: scroll to a newly arrived prompt only
    // after messages settle, and not on every refresh of a visible one.
    const revealPrompt = () => {
      if (promptArrived)
        document.getElementById('attention').scrollIntoView({ block: 'end', behavior: 'smooth' })
    }
    const signature = JSON.stringify(data.messages)
    if (signature === messageSignature) return revealPrompt()
    messageSignature = signature
    messages.replaceChildren(
      ...data.messages.map((message, index) => {
        const card = element('article', 'message')
        card.append(element('div', 'message-role', message.role))
        if (message.summary) card.append(element('div', 'message-summary', message.summary))
        const content = element('div', 'message-content')
        renderMessageContent(content, message, index)
        card.append(content)
        return card
      }),
    )
    if (!data.messages.length)
      messages.append(
        element('p', 'empty', 'A running response appears after it is saved on the desktop.'),
      )
    if (document.activeElement === messageInput) revealComposer()
    revealPrompt()
  } catch (cause) {
    fail(cause.message)
  }
}

async function openThread(row, addHistory = true) {
  if (addHistory && (selected?.projectId !== row.projectId || selected?.threadId !== row.threadId))
    history.pushState({ mobileView: 'thread', row }, '')
  if (selected) drafts.set(selected.threadId, messageInput.value)
  selected = row
  runId = null
  decisionSignature = ''
  messageSignature = ''
  composer.hidden = true
  document.getElementById('stop').hidden = true
  document.getElementById('attention').replaceChildren()
  messageInput.value = drafts.get(row.threadId) || ''
  show(thread)
  document.getElementById('thread-title').textContent = row.title
  document.getElementById('thread-project').textContent = row.projectName
  messages.replaceChildren(element('p', 'empty', 'Loading saved output…'))
  fail('')
  await refreshThread()
}

composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const row = selected
  const text = messageInput.value.trim()
  if (!row || !text || sending) return
  sending = true
  document.getElementById('send').disabled = true
  try {
    fail('')
    const result = await act({
      action: 'message',
      projectId: row.projectId,
      threadId: row.threadId,
      text,
    })
    drafts.delete(row.threadId)
    if (selected === row && messageInput.value.trim() === text) messageInput.value = ''
    actionStatus.textContent = result.queued
      ? 'Message queued on your Mac.'
      : 'Message sent to your Mac.'
    await refreshThread()
  } catch (cause) {
    fail(`${cause.message} Your message is still here.`)
  } finally {
    sending = false
    document.getElementById('send').disabled = false
    if (selected === row && !composer.hidden) focusComposer(messageInput)
  }
})

document.getElementById('stop').addEventListener('click', async () => {
  const row = selected
  const currentRun = runId
  if (!row || !currentRun) return
  const button = document.getElementById('stop')
  button.disabled = true
  try {
    fail('')
    await act({
      action: 'stop',
      projectId: row.projectId,
      threadId: row.threadId,
      runId: currentRun,
    })
    actionStatus.textContent = 'Stop requested.'
    await refreshThread()
  } catch (cause) {
    fail(cause.message)
  } finally {
    button.disabled = false
  }
})

document.getElementById('new-chat').addEventListener('click', () => {
  const form = document.getElementById('new-chat-form')
  form.hidden = !form.hidden
  if (!form.hidden) focusComposer(document.getElementById('new-message'))
})
document.getElementById('new-chat-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (sending) return
  const input = document.getElementById('new-message')
  const project = document.getElementById('project')
  const text = input.value.trim()
  const projectId = project.value
  if (!text || !projectId) return
  const button = event.currentTarget.querySelector('button')
  sending = true
  button.disabled = true
  try {
    fail('')
    const result = await act({ action: 'message', projectId, threadId: null, text })
    input.value = ''
    document.getElementById('new-chat-form').hidden = true
    await openThread({
      projectId,
      threadId: result.threadId,
      title: 'New chat',
      projectName: project.selectedOptions[0]?.textContent || '',
    })
    actionStatus.textContent = 'Chat started on your Mac.'
  } catch (cause) {
    fail(`${cause.message} Your message is still here.`)
  } finally {
    sending = false
    button.disabled = false
  }
})

function openActivity() {
  if (selected) drafts.set(selected.threadId, messageInput.value)
  selected = null
  actionStatus.textContent = ''
  fail('')
  show(token ? activity : pair)
  void refresh()
}

window.addEventListener('popstate', (event) => {
  if (token && event.state?.mobileView === 'thread' && event.state.row) {
    actionStatus.textContent = ''
    void openThread(event.state.row, false)
  } else {
    openActivity()
  }
})

document.getElementById('back').addEventListener('click', () => {
  history.back()
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

if (!history.state?.mobileView) history.replaceState({ mobileView: 'activity' }, '')
show(token ? activity : pair)
if (token && history.state?.mobileView === 'thread' && history.state.row)
  void openThread(history.state.row, false)
else if (token) void refresh()
setInterval(() => {
  if (!token || document.hidden) return
  if (selected) void refreshThread()
  else void refresh()
}, 2500)
