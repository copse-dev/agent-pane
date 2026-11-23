import { renderMessageContent } from './message-content.js'
import { installHighlighterBackend } from '../renderer/markdown/highlighter-backend.ts'
import { installComposerFocus } from './composer-focus.js'
import { RemoteChatClient } from '../renderer/remote/client.ts'
import { ConditionalReads, conditionalGet } from '../renderer/remote/conditional-reads.ts'
import { mobileTranscriptMessages } from '../main/services/mobile/mobile-transcript.ts'

const pair = document.getElementById('pair')
const activity = document.getElementById('activity')
const thread = document.getElementById('thread')
const error = document.getElementById('error')
const groups = document.getElementById('groups')
const inlineDecision = document.getElementById('inline-decision')
const messages = document.getElementById('messages')
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
const highlighterReady = installHighlighterBackend().catch(() => {})

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
let refreshPending = false
let sending = false
let decisionSignature = ''
let inlineDecisionSignature = ''
let selectedDecisionRow = null
let inlineDecisionRequest = 0
let lastActivityRows = []
// The answers last applied. The Mac answers an unchanged poll with a 304 and
// `api` then returns the same object again, so identity means "nothing to do".
let appliedActivity = null
let appliedThread = null
let appliedLive = null
let messageSignature = ''
let projectSignature = ''
const reads = new ConditionalReads()
const drafts = new Map()
const pendingActions = new Map()
const composer = document.getElementById('composer')
const messageInput = document.getElementById('message')
const actionStatus = document.getElementById('action-status')
const { focusComposer, revealComposer } = installComposerFocus()
const remote = new RemoteChatClient(api)
const nextPrompt = document.getElementById('next-prompt')
let remoteRefresh = false
let remoteGeneration = 0
let liveMessages = null
let remoteConnectionStatus = null
const connection = document.getElementById('remote-connection')

function selectChatPanel(name) {
  for (const panel of ['chat', 'plan', 'mac']) {
    document.getElementById(`${panel}-panel`).hidden = panel !== name
    document.getElementById(`${panel}-tab`).setAttribute('aria-pressed', String(panel === name))
  }
}
for (const panel of ['chat', 'plan', 'mac']) {
  document.getElementById(`${panel}-tab`).addEventListener('click', () => selectChatPanel(panel))
}

function renderRemoteDetails(live) {
  document.getElementById('remote-model').textContent = live.model || 'Desktop model'
  const todos = document.getElementById('remote-todos')
  const items = (live.todos || []).map((todo) => {
    const item = element('div', 'remote-todo')
    item.dataset.complete = String(todo.status === 'completed')
    item.append(
      element(
        'span',
        '',
        todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○',
      ),
      element('span', '', todo.content),
    )
    return item
  })
  todos.replaceChildren(
    ...(items.length ? items : [element('p', 'hint', 'No plan for this chat yet.')]),
  )
  const tools = document.getElementById('remote-tools')
  const calls = live.messages.flatMap((message) => message.toolCalls).slice(-30)
  const cards = calls.map((tool) => {
    const card = element('details', 'remote-tool')
    card.append(element('summary', '', tool.name))
    const output = tool.result
    card.append(
      element(
        'pre',
        '',
        typeof output === 'string' ? output : 'Tool activity is running on your Mac.',
      ),
    )
    return card
  })
  tools.replaceChildren(
    ...(cards.length ? cards : [element('p', 'hint', 'No tool activity in this chat yet.')]),
  )
}

messageInput.addEventListener('input', () => {
  nextPrompt.disabled = Boolean(messageInput.value.trim())
})

nextPrompt.addEventListener('click', () => {
  if (!selected || !nextPrompt.textContent || messageInput.value.trim()) return
  messageInput.value = nextPrompt.textContent
  remote.spend(selected.threadId)
  nextPrompt.hidden = true
  focusComposer(messageInput)
})
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey && !nextPrompt.hidden && !messageInput.value) {
    event.preventDefault()
    nextPrompt.click()
  }
})

/**
 * The live view is gone, so the saved view takes over, and at once rather than
 * at its next turn: what it draws depends on the state reset here, and it would
 * otherwise skip an answer it has already applied.
 */
function leaveLiveView(status) {
  const takeover = Boolean(liveMessages) || remoteConnectionStatus !== status
  appliedLive = null
  liveMessages = null
  remoteConnectionStatus = status
  if (!takeover) return
  appliedThread = null
  void refreshThread()
}

async function refreshRemoteThread() {
  const row = selected
  if (!token || !row || access !== 'control' || remoteRefresh) return
  remoteRefresh = true
  const generation = ++remoteGeneration
  try {
    const live = await remote.thread(row.projectId, row.threadId)
    if (selected !== row) return
    if (!live) {
      leaveLiveView(null)
      connection.textContent = 'Saved view'
      connection.dataset.connected = 'false'
      nextPrompt.hidden = true
      return
    }
    connection.textContent = '● Connected'
    connection.dataset.connected = 'true'
    // Unchanged since the last poll: leave the plan, the tool cards (and
    // whichever of them is open) and the transcript exactly as they are.
    if (live === appliedLive) return
    appliedLive = live
    renderRemoteDetails(live)
    const list = mobileTranscriptMessages(live.messages)
    liveMessages = { row, list }
    const signature = JSON.stringify([runId, list])
    if (signature !== messageSignature) {
      messageSignature = signature
      await highlighterReady
      if (selected !== row) return
      renderMessages(list)
    }
    remoteConnectionStatus =
      live.status === 'running'
        ? 'Connected · Live output from your Mac.'
        : 'Connected to your Mac.'
    document.getElementById('thread-status').textContent = remoteConnectionStatus
    remoteRefresh = false
    const hint = await remote.hint(live)
    if (selected !== row || generation !== remoteGeneration) return
    nextPrompt.textContent = hint || ''
    nextPrompt.hidden = !hint
    nextPrompt.disabled = Boolean(messageInput.value.trim())
  } catch {
    if (selected === row) {
      leaveLiveView('Live connection unavailable · Retrying. Your draft is kept.')
      connection.textContent = 'Reconnecting…'
      connection.dataset.connected = 'false'
      nextPrompt.hidden = true
      document.getElementById('thread-status').textContent = remoteConnectionStatus
    }
  } finally {
    if (generation === remoteGeneration) remoteRefresh = false
  }
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader()
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not read this image.'))
    reader.onerror = () => reject(new Error('Could not read this image.'))
    reader.readAsDataURL(file)
  })
}

async function prepareImage(file) {
  const direct = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
  if (!direct && !['image/heic', 'image/heif'].includes(file.type))
    throw new Error('Choose a PNG, JPEG, WebP, GIF or HEIC image.')
  if (file.size > 20_000_000) throw new Error('Choose an image smaller than 20 MB.')
  const source = await readDataUrl(file)
  if (direct && file.size <= 3_000_000) return source
  const image = new Image()
  image.src = source
  await image.decode()
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.8)
}

function imageAttachment(inputId, previewId) {
  const input = document.getElementById(inputId)
  const preview = document.getElementById(previewId)
  const picker = input.parentElement.querySelector('.image-picker')
  const image = preview.querySelector('img')
  let dataUrl = null
  let pending = null
  let imageError = null
  let generation = 0
  const clear = () => {
    generation += 1
    dataUrl = null
    pending = null
    imageError = null
    input.value = ''
    image.removeAttribute('src')
    preview.hidden = true
  }
  picker.addEventListener('click', () => input.click())
  preview.querySelector('button').addEventListener('click', clear)
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    const current = ++generation
    imageError = null
    pending = prepareImage(file)
      .then((value) => {
        if (current !== generation) return
        if (value.length > 4_200_000) throw new Error('This image is too large to send.')
        dataUrl = value
        image.src = value
        preview.hidden = false
        fail('')
      })
      .catch((cause) => {
        if (current !== generation) return
        clear()
        imageError = cause
        fail(cause.message)
      })
  })
  return {
    clear,
    async value() {
      await pending
      if (imageError) throw imageError
      return dataUrl
    },
  }
}

const threadImage = imageAttachment('message-image', 'message-image-preview')
const newChatImage = imageAttachment('new-image', 'new-image-preview')

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

/**
 * A read the Mac reports unchanged resolves to the same object as the read
 * before it. Callers compare by identity to skip work, and never modify an answer.
 */
async function api(path, options = {}) {
  const send = (conditional) =>
    fetch(path, {
      cache: 'no-store',
      ...options,
      headers: {
        ...(options.headers || {}),
        ...conditional,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
  const read = !options.method || options.method === 'GET'
  const result = read ? await conditionalGet(reads, path, send) : { response: await send({}) }
  if ('unchanged' in result) return result.unchanged
  const { response } = result
  if (response.status === 401) {
    token = null
    selected = null
    reads.clear()
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
  if (read) reads.remember(path, response.headers.get('ETag'), data)
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

const EMPTY_GROUP = {
  'needs-you': 'No decisions waiting for you.',
  working: 'No threads running right now.',
  'has-changes': 'Nothing waiting to be committed or discarded.',
  recent: 'Completed threads will appear here.',
}
const groupSections = new Map()
const activityRows = new Map()
/** Recent rows idle longer than this fold away, so sections stay a short scroll apart. */
const OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text
}

/**
 * Make `parent`'s children exactly `desired`, moving only what is out of place.
 * A node already where it belongs is not touched at all.
 */
function syncChildren(parent, desired) {
  let cursor = parent.firstChild
  for (const node of desired) {
    if (node === cursor) cursor = cursor.nextSibling
    else parent.insertBefore(node, cursor)
  }
  while (cursor) {
    const next = cursor.nextSibling
    cursor.remove()
    cursor = next
  }
}

/**
 * One row per thread, kept for as long as the thread is listed. Rebuilding the
 * list on every poll replaced the button under a finger mid-tap, which dropped
 * the tap; a kept row only has its changed text patched.
 */
function activityRow(row, group, isSelected) {
  const id = `${row.projectId}\n${row.threadId}`
  let entry = activityRows.get(id)
  if (!entry) {
    const button = element('button', 'row')
    button.type = 'button'
    const top = element('span', 'row-top')
    const state = element('span', '')
    const time = element('span', 'time')
    top.append(state, time)
    const title = element('span', 'row-title')
    const detail = element('span', 'row-detail')
    button.append(top, title, detail)
    const created = { button, state, time, title, detail, row, group }
    // A decision answers in place; anything else still opens the full thread.
    button.addEventListener('click', () =>
      created.group === 'needs-you' ? void selectDecision(created.row) : openThread(created.row),
    )
    activityRows.set(id, created)
    entry = created
  }
  entry.row = row
  entry.group = group
  const stateClass = `state ${row.state}`
  if (entry.state.className !== stateClass) entry.state.className = stateClass
  setText(entry.state, row.state.replaceAll('-', ' '))
  setText(entry.time, age(row.lastSavedAt))
  setText(entry.title, row.title)
  setText(entry.detail, `${row.detail} · ${row.projectName}`)
  entry.button.classList.toggle('selected', isSelected)
  return entry
}

function renderGroup(label, key, rows, listed) {
  let group = groupSections.get(key)
  if (!group) {
    const section = element('section', 'group')
    const heading = element('div', 'group-heading')
    const count = element('span', 'group-count')
    heading.append(element('span', '', label), count)
    // Kept like the rows, so a fold the reader opened stays open across polls.
    const older = element('details', 'older')
    older.dataset.group = key
    const olderSummary = element('summary', 'older-summary')
    const olderCount = element('span', 'group-count')
    olderSummary.append(element('span', '', 'Older than 30 days'), olderCount)
    group = {
      section,
      heading,
      count,
      empty: element('div', 'empty', EMPTY_GROUP[key]),
      older,
      olderSummary,
      olderCount,
    }
    groupSections.set(key, group)
  }
  setText(group.count, String(rows.length))
  const children = [group.heading]
  const olderChildren = [group.olderSummary]
  if (rows.length === 0) children.push(group.empty)
  const cutoff = Date.now() - OLDER_THAN_MS
  for (const row of rows) {
    const isSelected =
      key === 'needs-you' &&
      selectedDecisionRow?.projectId === row.projectId &&
      selectedDecisionRow?.threadId === row.threadId
    const entry = activityRow(row, key, isSelected)
    listed.add(entry)
    // Only Recent folds. A decision, a run or uncommitted work still wants the
    // reader, however long ago its thread last saved.
    const target = key === 'recent' && row.lastSavedAt < cutoff ? olderChildren : children
    target.push(entry.button)
    // Expand the card directly under the tapped row, not after the whole list.
    if (isSelected) target.push(inlineDecision)
  }
  // Fill the fold first: a row moving into it leaves the section by being inserted here.
  syncChildren(group.older, olderChildren)
  if (olderChildren.length > 1) {
    setText(group.olderCount, String(olderChildren.length - 1))
    children.push(group.older)
  }
  syncChildren(group.section, children)
  return group.section
}

/** Who wrote a message, in words a reader uses: "You" and "Agent", not "USER". */
function roleLabel(role) {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'Agent'
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : ''
}

function renderGroups(rows) {
  const listed = new Set()
  const sections = [
    ['Needs you', 'needs-you'],
    ['Working', 'working'],
    ['Has changes', 'has-changes'],
    ['Recent', 'recent'],
  ].map(([label, key]) =>
    renderGroup(
      label,
      key,
      rows.filter((row) => row.group === key),
      listed,
    ),
  )
  syncChildren(groups, sections)
  for (const [id, entry] of activityRows) if (!listed.has(entry)) activityRows.delete(id)
}

async function refresh() {
  if (!token || selected) return
  if (refreshing) {
    refreshPending = true
    return
  }
  refreshing = true
  try {
    const data = await api('/api/activity')
    if (selected) return
    const freshness = (at) =>
      `Updated ${age(at)} · ${access === 'control' ? 'Chat and run control' : 'Read only · enable control on your Mac'}`
    if (data === appliedActivity) {
      // The Mac confirmed the list it sent before is still current. Laying it
      // out again moves each kept row's "5m ago" on, and folds a Recent row
      // that has just passed 30 days, without touching anything in place.
      renderGroups(lastActivityRows)
      document.getElementById('freshness').textContent = freshness(Date.now())
      show(activity)
      return
    }
    appliedActivity = data
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
    lastActivityRows = data.rows
    renderGroups(data.rows)
    document.getElementById('freshness').textContent = freshness(data.refreshedAt)
    show(activity)
  } catch (cause) {
    // Whatever was half-drawn is drawn again by the next poll, changed or not.
    appliedActivity = null
    fail(cause.message)
  } finally {
    refreshing = false
    if (refreshPending) {
      refreshPending = false
      void refresh()
    }
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

function buildDecisionCards(data, row, container, afterSubmit) {
  const answerDrafts = new Map(
    [...container.querySelectorAll('textarea')].map((input) => [input.id, input.value]),
  )
  return data.decisions.map((decision) => {
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
        await afterSubmit()
      } catch (cause) {
        fail(cause.message)
        await afterSubmit()
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
          // "Approve", not "Approve once": matches the desktop Activity panel's
          // button wording (docs/ui-taste.md). Still answers once underneath —
          // no remembered grant, no task lease.
          decisionButton('Approve', true, () => submit({ action: 'approval', approved: true })),
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
}

// Some external-agent prompts still have a desktop-only transport.
function buildDesktopAttentionCards(data) {
  if (data.decisions.length) return []
  return data.attention.map((item) => {
    const card = element('section', 'attention')
    card.append(
      element('div', 'attention-title', item.title),
      element('pre', 'attention-body', item.body),
      element('p', 'hint', 'Answer this prompt on the desktop.'),
    )
    return card
  })
}

function renderDecisions(data, row) {
  const signature = JSON.stringify([data.decisions, data.attention, data.access])
  if (signature === decisionSignature) return
  decisionSignature = signature
  const attentionEl = document.getElementById('attention')
  const cards = buildDecisionCards(data, row, attentionEl, refreshThread)
  cards.push(...buildDesktopAttentionCards(data))
  const hadCards = attentionEl.childElementCount > 0
  attentionEl.replaceChildren(...cards)
  return cards.length > 0 && !hadCards
}

// Needs-you rows answer in place on the Activity screen: tapping the row
// again, or the decision settling, closes the card without a navigation.
async function selectDecision(row) {
  inlineDecisionRequest += 1
  if (
    selectedDecisionRow?.projectId === row.projectId &&
    selectedDecisionRow?.threadId === row.threadId
  ) {
    selectedDecisionRow = null
    inlineDecisionSignature = ''
    inlineDecision.hidden = true
    inlineDecision.replaceChildren()
    renderGroups(lastActivityRows)
    return
  }
  selectedDecisionRow = row
  inlineDecisionSignature = ''
  inlineDecision.hidden = false
  inlineDecision.replaceChildren(element('p', 'empty', 'Loading…'))
  renderGroups(lastActivityRows)
  await refreshInlineDecision()
}

function renderInlineDecision(data, row) {
  const signature = JSON.stringify([data.decisions, data.attention, data.access])
  if (signature === inlineDecisionSignature) return
  inlineDecisionSignature = signature
  const cards = buildDecisionCards(data, row, inlineDecision, refreshInlineDecision)
  cards.push(...buildDesktopAttentionCards(data))
  const openLink = element('button', 'open-thread-link', 'Open full thread ↗')
  openLink.type = 'button'
  openLink.addEventListener('click', () => openThread(row))
  inlineDecision.replaceChildren(...cards, openLink)
}

async function refreshInlineDecision() {
  const row = selectedDecisionRow
  if (!token || !row) return
  const request = ++inlineDecisionRequest
  try {
    const data = await api(
      `/api/thread/${encodeURIComponent(row.projectId)}/${encodeURIComponent(row.threadId)}`,
    )
    if (selectedDecisionRow !== row || request !== inlineDecisionRequest) return
    // Settled elsewhere (e.g. answered on the desktop): drop the card rather
    // than show stale actions for a decision that no longer exists.
    if (!data.decisions.length && !data.attention.length) {
      selectedDecisionRow = null
      inlineDecisionSignature = ''
      inlineDecision.hidden = true
      inlineDecision.replaceChildren()
      renderGroups(lastActivityRows)
      await refresh()
      return
    }
    renderInlineDecision(data, row)
  } catch (cause) {
    if (selectedDecisionRow === row && request === inlineDecisionRequest) fail(cause.message)
  }
}

async function loadMessageImage(image) {
  const url = image.dataset.mobileImageUrl
  const frame = image.parentElement
  try {
    const result = await api(url)
    if (!image.isConnected || image.dataset.mobileImageUrl !== url) return
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(result.image))
      throw new Error('Invalid image')
    image.onload = () => {
      image.hidden = false
      frame.querySelector('.message-image-loading')?.remove()
    }
    image.onerror = () => {
      const loading = frame.querySelector('.message-image-loading')
      if (loading) loading.textContent = 'Image unavailable'
    }
    image.src = result.image
  } catch {
    if (image.isConnected && image.dataset.mobileImageUrl === url) {
      const loading = frame.querySelector('.message-image-loading')
      if (loading) loading.textContent = 'Image unavailable'
    }
  }
}

const messageImageObserver = new window.IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      messageImageObserver.unobserve(entry.target)
      const image = entry.target.querySelector('img')
      if (image) void loadMessageImage(image)
    }
  },
  { rootMargin: '200px' },
)

function renderMessages(list) {
  if (!list.length) {
    messages.replaceChildren(
      element(
        'p',
        'empty',
        runId
          ? 'The response will appear once it is saved on the desktop.'
          : 'No text messages to show on this phone.',
      ),
    )
    return
  }
  // Patch existing cards by index instead of rebuilding the whole list: a full
  // replaceChildren on every poll tears down the nodes the browser anchors
  // scroll position to, which is what made scrolling jitter and stall while a
  // reply streamed in.
  if (![...messages.children].every((child) => child.classList.contains('message')))
    messages.replaceChildren()
  list.forEach((message, index) => {
    let card = messages.children[index]
    if (!card) {
      card = element('article', 'message')
      messages.append(card)
    }
    if (card.dataset.messageId !== message.id) {
      card.replaceChildren()
      card.dataset.messageId = message.id
    }
    let role = card.querySelector('.message-role')
    if (!role) {
      role = element('div', 'message-role')
      card.prepend(role)
    }
    role.textContent = roleLabel(message.role)
    let summary = card.querySelector('.message-summary')
    if (message.summary) {
      if (!summary) {
        summary = element('div', 'message-summary')
        role.after(summary)
      }
      summary.textContent = message.summary
    } else if (summary) {
      summary.remove()
    }
    let content = card.querySelector('.message-content')
    if (message.summary && !message.content.trim()) {
      content?.remove()
      return
    }
    if (!content) {
      content = element('div', 'message-content')
      card.append(content)
    }
    // The newest reply of a running chat is still arriving: pace it like the
    // desktop does, and settle it (diagrams, table copy) once the run ends.
    const live = Boolean(runId) && index === list.length - 1 && message.role === 'assistant'
    renderMessageContent(content, message, index, live)
    let gallery = card.querySelector('.message-images')
    const imageCount = Number.isSafeInteger(message.imageCount) ? message.imageCount : 0
    if (gallery?.dataset.imageCount !== String(imageCount)) {
      gallery?.remove()
      gallery = null
    }
    if (imageCount > 0 && !gallery && selected) {
      gallery = element('div', 'message-images')
      gallery.dataset.imageCount = String(imageCount)
      for (let imageIndex = 0; imageIndex < imageCount; imageIndex++) {
        const frame = element('div', 'message-image-frame')
        const image = document.createElement('img')
        image.className = 'message-image'
        image.alt = message.role === 'user' ? 'Attached image' : 'Image from response'
        image.hidden = true
        image.dataset.mobileImageUrl = `/api/thread/${encodeURIComponent(selected.projectId)}/${encodeURIComponent(selected.threadId)}/image/${encodeURIComponent(message.id)}/${imageIndex}`
        frame.append(element('span', 'message-image-loading', 'Loading image…'), image)
        gallery.append(frame)
        messageImageObserver.observe(frame)
      }
      card.append(gallery)
    }
  })
  while (messages.children.length > list.length) messages.lastChild.remove()
}

async function refreshThread() {
  const row = selected
  if (!token || !row) return
  try {
    const data = await api(
      `/api/thread/${encodeURIComponent(row.projectId)}/${encodeURIComponent(row.threadId)}`,
    )
    if (selected !== row) return
    // Unchanged since it was last applied to this open thread.
    if (data === appliedThread) return
    appliedThread = data
    access = data.access
    sessionId = data.sessionId
    const sharedLink = document.getElementById('shared-chat-link')
    sharedLink.hidden = access !== 'control'
    sharedLink.href =
      '/remote/?' + new URLSearchParams({ project: row.projectId, thread: row.threadId })
    runId = data.runId
    schedulePoll()
    const composerWasHidden = composer.hidden
    composer.hidden = access !== 'control'
    if (composerWasHidden && !composer.hidden) focusComposer(messageInput)
    document.getElementById('stop').hidden = access !== 'control' || !runId
    document.getElementById('send').textContent = runId ? 'Queue message' : 'Send'
    document.getElementById('thread-title').textContent = data.title
    document.getElementById('thread-status').textContent =
      access !== 'control'
        ? 'Read only · Enable control in Mobile Companion on your Mac.'
        : (remoteConnectionStatus ??
          (runId
            ? 'Running · Saved output refreshes automatically.'
            : 'Send a message to continue this chat.'))
    // Toggled every poll, independent of the message-signature gate below, so it
    // reflects the live run even while the agent hasn't saved a new message yet.
    document.getElementById('working').hidden = !runId
    const promptArrived = renderDecisions(data, row)
    // Approvals sit below the messages: scroll to a newly arrived prompt only
    // after messages settle, and not on every refresh of a visible one.
    const revealPrompt = () => {
      if (promptArrived)
        document.getElementById('attention').scrollIntoView({ block: 'end', behavior: 'smooth' })
    }
    const list = liveMessages?.row === row ? liveMessages.list : data.messages
    // A run ending changes how the last reply renders even when no text changed.
    const signature = JSON.stringify([runId, list])
    if (signature === messageSignature) return revealPrompt()
    messageSignature = signature
    // Code is highlighted as on the desktop; a highlighter that fails to load
    // leaves plain code rather than blocking the transcript.
    await highlighterReady
    if (selected !== row) return
    renderMessages(list)
    if (document.activeElement === messageInput) revealComposer()
    revealPrompt()
  } catch (cause) {
    // Whatever was half-drawn is drawn again by the next poll, changed or not.
    appliedThread = null
    fail(cause.message)
  }
}

async function openThread(row, addHistory = true) {
  remoteConnectionStatus = null
  inlineDecisionRequest += 1
  if (addHistory && (selected?.projectId !== row.projectId || selected?.threadId !== row.threadId))
    history.pushState({ mobileView: 'thread', row }, '')
  if (selected) drafts.set(selected.threadId, messageInput.value)
  // The full thread has its own decision card; leave none stale behind it.
  selectedDecisionRow = null
  inlineDecisionSignature = ''
  inlineDecision.hidden = true
  inlineDecision.replaceChildren()
  selected = row
  selectChatPanel('chat')
  connection.textContent = 'Connecting…'
  connection.dataset.connected = 'false'
  document
    .getElementById('remote-todos')
    .replaceChildren(element('p', 'hint', 'Connect to see this chat’s plan.'))
  document.getElementById('remote-tools').replaceChildren()
  liveMessages = null
  appliedThread = null
  appliedLive = null
  nextPrompt.hidden = true
  threadImage.clear()
  runId = null
  schedulePoll()
  decisionSignature = ''
  messageSignature = ''
  composer.hidden = true
  document.getElementById('stop').hidden = true
  document.getElementById('working').hidden = true
  document.getElementById('attention').replaceChildren()
  messageInput.value = drafts.get(row.threadId) || ''
  show(thread)
  document.getElementById('thread-title').textContent = row.title
  document.getElementById('thread-project').textContent = row.projectName
  messages.replaceChildren(element('p', 'empty', 'Loading saved output…'))
  fail('')
  await refreshThread()
  void refreshRemoteThread()
}

composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  const row = selected
  const text = messageInput.value.trim()
  if (!row || sending) return
  sending = true
  document.getElementById('send').disabled = true
  try {
    fail('')
    const image = await threadImage.value()
    if (!text && !image) {
      fail('Add a message or image to send.')
      return
    }
    const result = await act({
      action: 'message',
      projectId: row.projectId,
      threadId: row.threadId,
      text,
      ...(image ? { image } : {}),
    })
    remote.spend(row.threadId)
    nextPrompt.hidden = true
    drafts.delete(row.threadId)
    if (selected === row && messageInput.value.trim() === text) messageInput.value = ''
    if (selected === row) threadImage.clear()
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
  if (!projectId) return
  const button = event.currentTarget.querySelector('button[type="submit"]')
  sending = true
  button.disabled = true
  try {
    fail('')
    const image = await newChatImage.value()
    if (!text && !image) {
      fail('Add a message or image to start a chat.')
      return
    }
    const result = await act({
      action: 'message',
      projectId,
      threadId: null,
      text,
      ...(image ? { image } : {}),
    })
    input.value = ''
    newChatImage.clear()
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
  schedulePoll()
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

// The saved view is folded from disk on the Mac, so it keeps its own pace. The
// live view is already in the desktop's memory and an unchanged answer costs a
// 304, so a run that is streaming is followed more closely.
const POLL_MS = 2500
const LIVE_POLL_MS = 1000
let pollTimer = 0
let pollDelay = 0
let savedPolledAt = 0

function poll() {
  if (!token || document.hidden) return
  if (selected) {
    const now = Date.now()
    if (pollDelay === POLL_MS || now - savedPolledAt >= POLL_MS - 100) {
      savedPolledAt = now
      void refreshThread()
    }
    void refreshRemoteThread()
  } else {
    void refresh()
    if (selectedDecisionRow) void refreshInlineDecision()
  }
}

function schedulePoll() {
  const delay = selected && runId && access === 'control' ? LIVE_POLL_MS : POLL_MS
  if (delay === pollDelay) return
  pollDelay = delay
  clearInterval(pollTimer)
  pollTimer = setInterval(poll, delay)
}

schedulePoll()
// A phone coming back to the page is shown the present, not a view up to a
// whole poll old.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll()
})

if (!history.state?.mobileView) history.replaceState({ mobileView: 'activity' }, '')
show(token ? activity : pair)
if (token && history.state?.mobileView === 'thread' && history.state.row)
  void openThread(history.state.row, false)
else if (token) void refresh()
