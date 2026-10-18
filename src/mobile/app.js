import { renderMessageContent } from './message-content.js'
import { installComposerFocus } from './composer-focus.js'

const pair = document.getElementById('pair')
const activity = document.getElementById('activity')
const thread = document.getElementById('thread')
const error = document.getElementById('error')
const groups = document.getElementById('groups')
const inlineDecision = document.getElementById('inline-decision')
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
let refreshPending = false
let sending = false
let decisionSignature = ''
let inlineDecisionSignature = ''
let selectedDecisionRow = null
let inlineDecisionRequest = 0
let lastActivityRows = []
let messageSignature = ''
let projectSignature = ''
const drafts = new Map()
const pendingActions = new Map()
const composer = document.getElementById('composer')
const messageInput = document.getElementById('message')
const actionStatus = document.getElementById('action-status')
const { focusComposer, revealComposer } = installComposerFocus()

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
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
            : key === 'has-changes'
              ? 'Nothing waiting to be committed or discarded.'
              : 'Completed threads will appear here.',
      ),
    )
  for (const row of rows) {
    const button = element('button', 'row')
    button.type = 'button'
    const isSelected =
      key === 'needs-you' &&
      selectedDecisionRow?.projectId === row.projectId &&
      selectedDecisionRow?.threadId === row.threadId
    if (isSelected) button.classList.add('selected')
    const top = element('span', 'row-top')
    const state = element('span', `state ${row.state}`, row.state.replaceAll('-', ' '))
    top.append(state, element('span', 'time', age(row.lastSavedAt)))
    button.append(
      top,
      element('span', 'row-title', row.title),
      element('span', 'row-detail', `${row.detail} · ${row.projectName}`),
    )
    // A decision answers in place; anything else still opens the full thread.
    button.addEventListener('click', () =>
      key === 'needs-you' ? void selectDecision(row) : openThread(row),
    )
    section.append(button)
    // Expand the card directly under the tapped row, not after the whole list.
    if (isSelected) section.append(inlineDecision)
  }
  return section
}

function renderGroups(rows) {
  groups.replaceChildren(
    renderGroup(
      'NEEDS YOU',
      'needs-you',
      rows.filter((row) => row.group === 'needs-you'),
    ),
    renderGroup(
      'WORKING',
      'working',
      rows.filter((row) => row.group === 'working'),
    ),
    renderGroup(
      'HAS CHANGES',
      'has-changes',
      rows.filter((row) => row.group === 'has-changes'),
    ),
    renderGroup(
      'RECENT',
      'recent',
      rows.filter((row) => row.group === 'recent'),
    ),
  )
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
    document.getElementById('freshness').textContent =
      `Updated ${age(data.refreshedAt)} · ${access === 'control' ? 'Chat and run control' : 'Read only · enable control on your Mac'}`
    show(activity)
  } catch (cause) {
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

const messageImageObserver = new IntersectionObserver(
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
      element('p', 'empty', 'A running response appears after it is saved on the desktop.'),
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
    role.textContent = message.role
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
    if (!content) {
      content = element('div', 'message-content')
      card.append(content)
    }
    renderMessageContent(content, message, index)
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
    renderMessages(data.messages)
    if (document.activeElement === messageInput) revealComposer()
    revealPrompt()
  } catch (cause) {
    fail(cause.message)
  }
}

async function openThread(row, addHistory = true) {
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
  threadImage.clear()
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
  else {
    void refresh()
    if (selectedDecisionRow) void refreshInlineDecision()
  }
}, 2500)
