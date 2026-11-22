// Renders the classified PR portfolio. Reads only classify.js output; every
// label shown here traces back to a reason in that output.
;(function () {
  'use strict'

  const { classifyPortfolio, agentContextForPr, agentContextForWorkstream } = window.PrPortfolio
  const snapshot = window.PR_PORTFOLIO_SNAPSHOT
  const result = classifyPortfolio(snapshot, Date.parse(snapshot.capturedAt))
  const prs = result.prs
  const laneById = new Map(result.lanes.map((lane) => [lane.id, lane]))
  const stackById = new Map(result.stacks.map((stack) => [stack.id, stack]))
  const streamById = new Map(result.workstreams.map((ws) => [ws.id, ws]))

  const ACTOR = { user: 'You', agent: 'An agent', ci: 'CI', nobody: 'Nobody' }
  const TYPE_ORDER = ['fix', 'feature', 'hardening', 'infra', 'plan', 'prototype']
  const EDGE_LABEL = {
    stack: 'Stacked',
    duplicate: 'Heavy file overlap',
    overlap: 'Shared files',
    topic: 'Similar title / branch',
    plan: 'Same plan doc',
  }
  // Illustrative buttons for each next action; the last one is primary.
  function actionButtons(record) {
    const action = record.action
    if (action === 'Review screenshots') return ['Open thread', 'Open screenshots']
    if (action === 'Request CI') return ['Request full CI']
    if (action.startsWith('Merge after')) return ['Open parent']
    if (action === 'Ready to merge') return ['Enable auto-merge', 'Merge']
    if (action === 'Mark ready for review') return ['Mark ready']
    if (record.lane === 'agent') return ['View failures', 'Dispatch agent']
    if (action === 'Checks running') return ['View checks']
    if (record.lane === 'progress') return ['Open thread']
    if (record.lane === 'stalled') return ['Close', 'Nudge agent']
    return ['Close']
  }

  const params = new URLSearchParams(location.search)
  const state = {
    layout: params.get('layout') ?? 'expanded',
    view: params.get('view') === 'workstreams' ? 'workstreams' : 'inbox',
    selected: null,
    filter: '',
    collapsed: new Set(['stalled', 'parked']),
    collapsedStandalone: new Set(TYPE_ORDER),
    openStacks: new Set(),
    openFiles: new Set(),
  }
  if (params.get('pr')) state.selected = { kind: 'pr', id: Number(params.get('pr')) }
  if (params.get('ws')) state.selected = { kind: 'ws', id: params.get('ws') }
  if (params.get('expand')) {
    for (const id of params.get('expand').split(',')) state.openStacks.add(id)
  }

  const workbench = document.querySelector('.workbench')
  const paneBody = document.querySelector('#pane-body')
  const detail = document.querySelector('#detail')

  // ---- DOM helper: text always goes through textContent ------------------
  function h(tag, attrs, ...children) {
    const element = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (value === null || value === undefined || value === false) continue
      if (key === 'class') element.className = value
      else if (key.startsWith('on')) element.addEventListener(key.slice(2), value)
      else element.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      element.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child)
    }
    return element
  }

  const SVG_NS = 'http://www.w3.org/2000/svg'
  function s(tag, attrs, ...children) {
    const element = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (key.startsWith('on')) element.addEventListener(key.slice(2), value)
      else element.setAttribute(key, String(value))
    }
    for (const child of children.flat()) {
      if (child) element.append(typeof child === 'string' ? document.createTextNode(child) : child)
    }
    return element
  }

  let toastTimer
  function toast(message) {
    const element = document.querySelector('#toast')
    element.textContent = message
    element.hidden = false
    window.clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      element.hidden = true
    }, 3000)
  }

  function sizeText(record) {
    const lines = record.size.sourceLines
    const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    return lines === 0 ? 'no source' : `±${short(lines)}`
  }

  function matchesFilter(record) {
    const query = state.filter.trim().toLowerCase().replace(/^#/, '')
    if (!query) return true
    const stream = streamById.get(record.workstream)
    return [
      String(record.number),
      record.title,
      record.facts.headRef,
      record.type.value,
      record.action,
      stream?.name ?? '',
      ...record.surfaces,
    ].some((value) => value.toLowerCase().includes(query))
  }

  function isSelected(kind, id) {
    return state.selected?.kind === kind && state.selected.id === id
  }

  function select(kind, id) {
    state.selected = { kind, id }
    workbench.dataset.show = 'detail'
    render()
    detail.scrollTop = 0
    detail.focus({ preventScroll: true })
  }

  // ---- Pane --------------------------------------------------------------
  function renderLaneBar() {
    const host = document.querySelector('#lane-bar')
    host.replaceChildren()
    const counts = Object.fromEntries(result.lanes.map((lane) => [lane.id, 0]))
    for (const record of prs.values()) counts[record.lane] += 1
    const track = h('div', {
      class: 'lane-bar-track',
      role: 'img',
      'aria-label': summaryText(counts),
    })
    for (const lane of result.lanes) {
      if (counts[lane.id] === 0) continue
      track.append(
        h('span', {
          class: `lane-${lane.id}`,
          style: `flex: ${String(counts[lane.id])}`,
          title: `${lane.label}: ${String(counts[lane.id])}`,
        }),
      )
    }
    const legend = h('div', { class: 'lane-bar-legend' })
    for (const lane of result.lanes) {
      if (counts[lane.id] === 0) continue
      legend.append(
        h(
          'button',
          {
            type: 'button',
            class: `lane-${lane.id}`,
            title: lane.hint,
            onclick: () => {
              state.view = 'inbox'
              state.collapsed.delete(lane.id)
              render()
              paneBody.querySelector(`[data-lane="${lane.id}"]`)?.scrollIntoView({ block: 'start' })
            },
          },
          h('span', { class: 'swatch' }),
          h('strong', {}, String(counts[lane.id])),
          lane.label.replace('Needs ', ''),
        ),
      )
    }
    host.append(track, legend)
  }

  function summaryText(counts) {
    return result.lanes.map((lane) => `${String(counts[lane.id])} ${lane.label}`).join(', ')
  }

  function prRow(record, options) {
    const lane = record.lane
    const failing = (record.facts.checks?.failed ?? 0) > 0
    const active = record.signals.some((signal) => signal.kind === 'active')
    const flagged = record.signals.some((signal) =>
      ['hidden-parent', 'heavy-overlap', 'far-behind'].includes(signal.kind),
    )
    return h(
      'button',
      {
        type: 'button',
        class: `row pr-row lane-${lane}`,
        'aria-current': isSelected('pr', record.number) ? 'true' : null,
        'data-pr': record.number,
        onclick: () => select('pr', record.number),
      },
      h('span', { class: 'row-title', title: record.title }, record.title),
      h(
        'span',
        { class: 'row-meta' },
        active ? h('span', { class: 'live-dot', title: 'Updated in the last few hours' }) : null,
        h('span', { class: 'num' }, `#${String(record.number)}`),
        h('span', { class: 'tag', title: record.type.reason }, record.type.value),
        h('span', { title: record.size.reason }, sizeText(record)),
        record.overlaps.length > 0
          ? h(
              'span',
              {
                class: `tag ${record.overlaps.some((o) => o.kind === 'duplicate') ? 'warn' : ''}`,
                title: `Shares source files with ${record.overlaps.map((o) => `#${String(o.pr)}`).join(', ')}`,
              },
              `⇄ ${String(record.overlaps.length)}`,
            )
          : null,
        flagged
          ? h(
              'span',
              { class: 'tag warn', title: record.signals.map((x) => x.text).join('\n') },
              '⚑',
            )
          : null,
        options?.hideAction
          ? null
          : h(
              'span',
              { class: `row-action ${failing && lane !== 'stalled' ? 'failing' : ''}` },
              record.action,
            ),
      ),
    )
  }

  function stackRow(stack, visibleMembers) {
    const open = state.openStacks.has(stack.id) || state.filter.trim() !== ''
    const lead = prs.get(stack.lead)
    const container = h('div', { class: 'stack' })
    const strip = h(
      'span',
      { class: 'stack-strip', 'aria-hidden': 'true' },
      stack.members.map((number) => {
        const member = prs.get(number)
        return h('span', {
          class: `lane-${member.lane}`,
          title: `#${String(number)} · ${member.action}`,
        })
      }),
    )
    container.append(
      h(
        'button',
        {
          type: 'button',
          class: `row stack-row lane-${stack.lane}`,
          'aria-expanded': String(open),
          'aria-label': `Stack of ${String(stack.members.length)} pull requests from #${String(stack.root)}`,
          onclick: () => {
            if (open) state.openStacks.delete(stack.id)
            else state.openStacks.add(stack.id)
            render()
          },
        },
        h(
          'span',
          { class: 'row-title' },
          h('span', { class: 'tag info' }, `Stack · ${String(stack.members.length)}`),
          h('span', { title: stack.title }, stack.title),
        ),
        h(
          'span',
          { class: 'row-meta' },
          strip,
          h('span', { class: 'stack-expand' }, open ? 'hide' : 'show'),
          h(
            'span',
            { class: `row-action ${(lead.facts.checks?.failed ?? 0) > 0 ? 'failing' : ''}` },
            stack.action,
          ),
        ),
      ),
    )
    if (open) {
      container.append(
        h(
          'div',
          { class: 'stack-members' },
          visibleMembers.map((number) => prRow(prs.get(number))),
        ),
      )
    }
    return container
  }

  function sectionToggle(key, label, hint, count, collapsedSet) {
    const collapsed = collapsedSet.has(key) && state.filter.trim() === ''
    return h(
      'button',
      {
        type: 'button',
        class: 'section-toggle',
        'aria-expanded': String(!collapsed),
        'data-lane': key,
        onclick: () => {
          if (collapsedSet.has(key)) collapsedSet.delete(key)
          else collapsedSet.add(key)
          render()
        },
      },
      h('span', { class: 'chevron', 'aria-hidden': 'true' }, '▾'),
      h('span', { class: 'section-label' }, label),
      h('span', { class: 'section-hint' }, hint),
      h('span', { class: 'section-count' }, String(count)),
    )
  }

  // Within a lane, closest to done first: merging beats reviewing beats asking.
  const ACTION_RANK = [
    'Ready to merge',
    'Merge after',
    'Mark ready',
    'Review screenshots',
    'Request CI',
    'Rebase',
    'Fix failing',
    'Address review',
  ]
  function actionRank(record) {
    const index = ACTION_RANK.findIndex((prefix) => record.action.startsWith(prefix))
    return index === -1 ? ACTION_RANK.length : index
  }

  function renderInbox() {
    const visible = [...prs.values()].filter(matchesFilter)
    if (visible.length === 0) {
      paneBody.append(h('div', { class: 'empty' }, 'No pull requests match this filter.'))
      return
    }
    for (const lane of result.lanes) {
      const items = []
      const seenStacks = new Set()
      let count = 0
      for (const record of visible) {
        const stack = record.stack ? stackById.get(record.stack.id) : null
        if (stack) {
          if (stack.lane !== lane.id || seenStacks.has(stack.id)) continue
          seenStacks.add(stack.id)
          const members = stack.members.filter((n) => visible.some((r) => r.number === n))
          count += members.length
          items.push({
            order: stack.root,
            rank: actionRank(prs.get(stack.lead)),
            node: stackRow(stack, members),
          })
        } else if (record.lane === lane.id) {
          count += 1
          items.push({ order: record.number, rank: actionRank(record), node: prRow(record) })
        }
      }
      if (items.length === 0) continue
      const section = h('section', {})
      section.append(sectionToggle(lane.id, lane.label, lane.hint, count, state.collapsed))
      if (!state.collapsed.has(lane.id) || state.filter.trim() !== '') {
        items.sort((a, b) => a.rank - b.rank || b.order - a.order)
        section.append(...items.map((item) => item.node))
      }
      paneBody.append(section)
    }
  }

  function renderWorkstreamList() {
    const visible = new Set([...prs.values()].filter(matchesFilter).map((record) => record.number))
    const streams = result.workstreams.filter((ws) => ws.members.some((n) => visible.has(n)))
    if (streams.length > 0) {
      const section = h('section', {})
      section.append(
        sectionToggle(
          'streams',
          'Workstreams',
          'Linked by stacks, shared files, plan docs or titles',
          streams.length,
          new Set(),
        ),
      )
      for (const ws of streams) {
        section.append(
          h(
            'button',
            {
              type: 'button',
              class: 'row ws-row',
              'aria-current': isSelected('ws', ws.id) ? 'true' : null,
              'data-ws': ws.id,
              onclick: () => select('ws', ws.id),
            },
            h('span', { class: 'row-title' }, ws.name),
            h(
              'span',
              { class: 'row-meta' },
              h(
                'span',
                { class: 'mini-lanes', 'aria-hidden': 'true' },
                ws.members.map((n) =>
                  h('span', { class: `lane-${prs.get(n).lane}`, title: `#${String(n)}` }),
                ),
              ),
              `${String(ws.members.length)} PRs`,
              ws.stacks.length > 0
                ? h('span', { class: 'tag info' }, `${String(ws.stacks.length)} stack`)
                : null,
              ws.duplicates.length > 0
                ? h('span', { class: 'tag warn' }, `${String(ws.duplicates.length)} heavy overlap`)
                : null,
              h('span', { class: 'row-action lane-user' }, needsYouText(ws)),
            ),
          ),
        )
      }
      paneBody.append(section)
    }
    const standalone = [...prs.values()].filter((r) => !r.workstream && visible.has(r.number))
    for (const type of TYPE_ORDER) {
      const items = standalone.filter((record) => record.type.value === type)
      if (items.length === 0) continue
      const section = h('section', {})
      section.append(
        sectionToggle(
          type,
          `Standalone · ${type}`,
          'Not linked to another open PR',
          items.length,
          state.collapsedStandalone,
        ),
      )
      if (!state.collapsedStandalone.has(type) || state.filter.trim() !== '') {
        items.sort(
          (a, b) =>
            result.lanes.findIndex((l) => l.id === a.lane) -
            result.lanes.findIndex((l) => l.id === b.lane),
        )
        section.append(...items.map((record) => prRow(record)))
      }
      paneBody.append(section)
    }
  }

  function needsYouText(ws) {
    if (ws.lanes.user > 0) return `${String(ws.lanes.user)} need you`
    if (ws.lanes.agent > 0) return `${String(ws.lanes.agent)} need an agent`
    return ''
  }

  function renderPane() {
    paneBody.replaceChildren()
    document.querySelectorAll('[data-view]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.view === state.view))
    })
    if (state.view === 'inbox') renderInbox()
    else renderWorkstreamList()
  }

  // ---- Detail: pull request ---------------------------------------------
  function backButton() {
    return h(
      'button',
      {
        type: 'button',
        class: 'back',
        onclick: () => {
          workbench.dataset.show = 'list'
        },
      },
      '← Pull requests',
    )
  }

  function illustrativeButtons(record) {
    const labels = actionButtons(record)
    return labels.map((label, index) =>
      h(
        'button',
        {
          type: 'button',
          class: `button ${index === labels.length - 1 ? 'primary' : ''}`,
          onclick: () => toast(`Prototype: "${label}" would act here. Nothing was sent.`),
        },
        label,
      ),
    )
  }

  function agentContextBlock(call, value) {
    const json = JSON.stringify(value, null, 2)
    return h(
      'details',
      { class: 'agent-context' },
      h(
        'summary',
        {},
        'Agent context ',
        h('code', {}, call),
        h(
          'button',
          {
            type: 'button',
            class: 'button copy',
            onclick: (event) => {
              event.preventDefault()
              const done = () => toast('Copied agent context')
              const failed = () => toast('Copy is not available here; select the text below')
              try {
                window.navigator.clipboard.writeText(json).then(done, failed)
              } catch {
                failed()
              }
            },
          },
          'Copy',
        ),
      ),
      h(
        'p',
        { class: 'caption' },
        'The record an agent would receive: the same judgments and reasons this panel shows, without the raw facts it can fetch itself.',
      ),
      h('pre', {}, json),
    )
  }

  function memberRow(number, current) {
    const record = prs.get(number)
    return h(
      'button',
      {
        type: 'button',
        class: `mini-row lane-${record.lane}`,
        'aria-current': current ? 'true' : null,
        onclick: () => select('pr', number),
      },
      h('span', { class: 'num' }, h('span', { class: 'swatch' }), `#${String(number)}`),
      h('span', { class: 'title', title: record.title }, record.title),
      h('span', { class: 'aside' }, record.action),
    )
  }

  function renderPrDetail(number) {
    const record = prs.get(number)
    const facts = record.facts
    const checks = facts.checks
    const stack = record.stack ? stackById.get(record.stack.id) : null
    const stream = record.workstream ? streamById.get(record.workstream) : null
    const lane = laneById.get(record.lane)
    const root = h('div', { class: `detail-inner lane-${record.lane}` })
    root.append(
      backButton(),
      h(
        'div',
        { class: 'detail-top' },
        h('span', {}, `${result.repo} · ${lane.label}`),
        h('a', { href: record.url, target: '_blank', rel: 'noreferrer' }, 'GitHub ↗'),
      ),
      h('h2', {}, `${record.title} `, h('span', { class: 'num' }, `#${String(number)}`)),
      h(
        'div',
        { class: 'branch' },
        `${facts.headRef} → ${facts.baseRef}${record.draft ? '  ·  draft' : ''}`,
      ),
      h(
        'div',
        { class: 'chips' },
        h('span', { class: 'tag', title: record.type.reason }, `type: ${record.type.value}`),
        h(
          'span',
          { class: 'tag', title: record.size.reason },
          `size ${record.size.bucket}: +${String(record.size.added)} −${String(record.size.deleted)} source lines · ${String(facts.diff.files)} files`,
        ),
        record.surfaces.map((surface) =>
          h(
            'span',
            {
              class: 'tag danger',
              title:
                'Sensitive surface. Only the surfaces that most often preceded regressions in bench:risk are flagged; this is not a risk rating.',
            },
            surface,
          ),
        ),
        stream
          ? h(
              'button',
              { type: 'button', class: 'tag info', onclick: () => select('ws', stream.id) },
              `workstream: ${stream.name} →`,
            )
          : null,
      ),
      h(
        'section',
        { class: 'next', 'aria-label': 'Next action' },
        h(
          'div',
          { class: 'next-head' },
          h(
            'div',
            {},
            h('div', { class: 'next-who' }, `Next: ${ACTOR[record.actor]}`),
            h('div', { class: 'next-action' }, record.action),
          ),
          h('div', { class: 'next-buttons' }, illustrativeButtons(record)),
        ),
        h(
          'ul',
          {},
          record.reasons.map((reason) => h('li', {}, reason)),
        ),
      ),
    )
    if (record.signals.length > 0) {
      root.append(
        h(
          'div',
          { class: 'signals' },
          record.signals.map((signal) =>
            h(
              'div',
              { class: `signal ${signal.kind === 'active' ? 'active' : ''}` },
              h('b', {}, signal.kind.replace(/-/g, ' ')),
              h('span', {}, signal.text),
            ),
          ),
        ),
      )
    }
    if (stack) {
      root.append(
        h('h3', {}, `Stack · ${String(record.stack.position)} of ${String(record.stack.length)}`),
        h(
          'div',
          { class: 'mini-list' },
          stack.members.map((n) => memberRow(n, n === number)),
        ),
      )
    }
    if (record.overlaps.length > 0) {
      root.append(
        h(
          'h3',
          {},
          'Shares source files with ',
          h('span', { class: 'muted' }, '(hot files excluded)'),
        ),
      )
      const list = h('div', { class: 'mini-list' })
      for (const overlap of record.overlaps) {
        const other = prs.get(overlap.pr)
        const key = `${String(number)}:${String(overlap.pr)}`
        const open = state.openFiles.has(key)
        list.append(
          h(
            'button',
            {
              type: 'button',
              class: `mini-row lane-${other.lane}`,
              'aria-expanded': String(open),
              onclick: () => {
                if (open) state.openFiles.delete(key)
                else state.openFiles.add(key)
                render()
              },
            },
            h('span', { class: 'num' }, h('span', { class: 'swatch' }), `#${String(overlap.pr)}`),
            h('span', { class: 'title', title: other.title }, other.title),
            h(
              'span',
              { class: 'aside' },
              `${String(overlap.shared.length)} files · ${String(Math.round(overlap.jaccard * 100))}%${overlap.kind === 'duplicate' ? ' · heavy' : ''}`,
            ),
          ),
        )
        if (open)
          list.append(
            h(
              'ul',
              { class: 'files' },
              overlap.shared.map((path) => h('li', {}, path)),
            ),
          )
      }
      root.append(list)
    }
    if (record.hotFiles.length > 0) {
      root.append(
        h('h3', {}, 'Hot files ', h('span', { class: 'muted' }, '(merge-order conflicts likely)')),
        h(
          'div',
          { class: 'mini-list' },
          record.hotFiles.map((path) => {
            const hot = result.hotFiles.find((file) => file.path === path)
            return h(
              'div',
              { class: 'mini-row' },
              h('span', { class: 'num' }, String(hot.count)),
              h('span', { class: 'title branch', title: path }, path),
              h('span', { class: 'aside' }, 'open PRs touch it'),
            )
          }),
        ),
      )
    }
    root.append(
      h('h3', {}, 'Facts'),
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'Checks'),
        h(
          'dd',
          {},
          checks
            ? `${String(checks.passed)} passed · ${String(checks.failed)} failed · ${String(checks.running)} running · ${String(checks.skipped)} skipped`
            : 'No check runs on the current head',
        ),
        checks && checks.failed > 0
          ? [h('dt', {}, 'Failed'), h('dd', {}, checks.failedNames.join(', '))]
          : null,
        h('dt', {}, 'Labels'),
        h('dd', {}, facts.labels.length > 0 ? facts.labels.join(', ') : '—'),
        h('dt', {}, 'Activity'),
        h(
          'dd',
          {},
          `opened ${String(record.openDays)}d ago · last activity ${String(record.idleDays)}d ago · ${String(facts.comments)} comments`,
        ),
        h('dt', {}, 'Main'),
        h(
          'dd',
          {},
          `branched from main of ${facts.mainBase.committedAt.slice(0, 10)} · ${String(facts.mainBase.behind)} commits behind`,
        ),
      ),
      h('h3', {}, 'Shared with agents'),
      agentContextBlock(
        `pr_portfolio.get({ pr: ${String(number)} })`,
        agentContextForPr(result, number),
      ),
    )
    return root
  }

  // ---- Detail: workstream -------------------------------------------------
  function graph(ws, highlight) {
    const members = [...ws.members]
    // Keep stack members next to each other around the ring.
    members.sort((a, b) => {
      const sa = prs.get(a).stack
      const sb = prs.get(b).stack
      const ka = sa ? stackById.get(sa.id).root * 100 + sa.position : a * 100
      const kb = sb ? stackById.get(sb.id).root * 100 + sb.position : b * 100
      return ka - kb
    })
    const width = 640
    const height = members.length > 4 ? 300 : 200
    const cx = width / 2
    const cy = height / 2
    const rx = members.length > 2 ? width / 2 - 70 : 140
    const ry = height / 2 - 34
    const pos = new Map(
      members.map((n, i) => {
        const angle = (i / members.length) * Math.PI * 2 - Math.PI / 2
        return [n, { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }]
      }),
    )
    const svg = s('svg', {
      viewBox: `0 0 ${String(width)} ${String(height)}`,
      role: 'img',
      'aria-label': `Links between the ${String(members.length)} pull requests in ${ws.name}`,
    })
    for (const edge of ws.edges) {
      const a = pos.get(edge.a)
      const b = pos.get(edge.b)
      svg.append(
        s(
          'line',
          { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `edge-${edge.kind}` },
          s('title', {}, edge.detail),
        ),
      )
    }
    for (const n of members) {
      const p = pos.get(n)
      const record = prs.get(n)
      const node = s(
        'g',
        {
          class: `node lane-${record.lane}`,
          tabindex: 0,
          role: 'button',
          'aria-label': `#${String(n)} ${record.title}: ${record.action}`,
          onclick: () => select('pr', n),
          onkeydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              select('pr', n)
            }
          },
        },
        s('title', {}, `#${String(n)} ${record.title}\n${record.action}`),
        s('rect', {
          x: p.x - 30,
          y: p.y - 12,
          width: 60,
          height: 24,
          rx: 6,
          ...(highlight === n ? { 'stroke-width': 3 } : {}),
        }),
        s('text', { x: p.x, y: p.y }, `#${String(n)}`),
      )
      svg.append(node)
    }
    const kinds = [...new Set(ws.edges.map((edge) => edge.kind))]
    const legend = h(
      'div',
      { class: 'graph-legend' },
      kinds.map((kind) => {
        const sample = s(
          'svg',
          { viewBox: '0 0 22 8' },
          s('line', { x1: 1, y1: 4, x2: 21, y2: 4, class: `edge-${kind}` }),
        )
        return h('span', {}, sample, EDGE_LABEL[kind])
      }),
      h('span', {}, 'Node colour: who acts next'),
    )
    return h('div', { class: 'graph' }, svg, legend)
  }

  function renderWorkstreamDetail(id) {
    const ws = streamById.get(id)
    const root = h('div', { class: 'detail-inner' })
    const total = ws.members.length
    root.append(
      backButton(),
      h('div', { class: 'detail-top' }, h('span', {}, `${result.repo} · Workstream`)),
      h('h2', {}, ws.name),
      h(
        'div',
        { class: 'subtitle' },
        `${String(total)} open PRs · named from the ${ws.nameReason.toLowerCase()}`,
      ),
      h(
        'div',
        { class: 'chips' },
        result.lanes
          .filter((lane) => ws.lanes[lane.id] > 0)
          .map((lane) =>
            h(
              'span',
              { class: `tag lane-${lane.id}` },
              h('span', { class: 'swatch' }),
              `${String(ws.lanes[lane.id])} ${lane.label.toLowerCase()}`,
            ),
          ),
      ),
    )
    if (ws.duplicates.length > 0) {
      root.append(
        h(
          'div',
          { class: 'callout' },
          h('b', {}, 'Heavy overlap: '),
          ws.duplicates
            .map(
              (edge) => `#${String(edge.a)} and #${String(edge.b)} (${edge.detail.toLowerCase()})`,
            )
            .join('; '),
          '. Competing approaches or a merge conflict waiting to happen: land one, then rebase or close the other.',
        ),
      )
    }
    root.append(h('h3', {}, 'How they connect'), graph(ws, null))
    root.append(h('h3', {}, 'Pull requests'))
    const list = h('div', { class: 'mini-list' })
    for (const lane of result.lanes) {
      for (const n of ws.members.filter((m) => prs.get(m).lane === lane.id))
        list.append(memberRow(n, false))
    }
    root.append(list)
    root.append(
      h('h3', {}, 'Why these are grouped'),
      h(
        'ul',
        { class: 'evidence' },
        ws.edges.map((edge) =>
          h(
            'li',
            {},
            `${EDGE_LABEL[edge.kind]}: #${String(edge.a)} ↔ #${String(edge.b)}. ${edge.detail}`,
          ),
        ),
      ),
    )
    if (ws.sharedFiles.length > 0) {
      root.append(
        h('h3', {}, 'Files more than one of them change'),
        h(
          'div',
          { class: 'mini-list' },
          ws.sharedFiles
            .slice(0, 10)
            .map((file) =>
              h(
                'div',
                { class: 'mini-row' },
                h('span', { class: 'num' }, `${String(file.count)} PRs`),
                h('span', { class: 'title branch', title: file.path }, file.path),
                h('span', { class: 'aside' }, ''),
              ),
            ),
        ),
      )
    }
    root.append(
      h('h3', {}, 'Shared with agents'),
      agentContextBlock(
        `pr_portfolio.workstream({ id: '${ws.id}' })`,
        agentContextForWorkstream(result, ws.id),
      ),
    )
    return root
  }

  function renderDetail() {
    detail.replaceChildren()
    if (!state.selected) {
      detail.append(
        h('div', { class: 'detail-inner empty' }, 'Select a pull request or workstream.'),
      )
      return
    }
    detail.append(
      state.selected.kind === 'pr'
        ? renderPrDetail(state.selected.id)
        : renderWorkstreamDetail(state.selected.id),
    )
  }

  function render() {
    const scroll = paneBody.scrollTop
    workbench.dataset.layout = state.layout
    renderPane()
    renderDetail()
    paneBody.scrollTop = scroll
    const url = new URL(location.href)
    url.searchParams.set('layout', state.layout)
    url.searchParams.set('view', state.view)
    url.searchParams.delete('pr')
    url.searchParams.delete('ws')
    if (state.selected) url.searchParams.set(state.selected.kind, String(state.selected.id))
    try {
      window.history.replaceState(null, '', url)
    } catch {
      // Sandboxed frames may refuse URL updates; the view still works.
    }
  }

  // ---- Wiring -------------------------------------------------------------
  const total = prs.size
  const stackedPrs = result.stacks.reduce((sum, stack) => sum + stack.members.length, 0)
  document.querySelector('#lede').textContent =
    `${String(total)} open pull requests in ${result.repo}, captured ${new Date(result.capturedAt).toUTCString().slice(5, 22)} UTC. ` +
    `Grouped by who acts next; ${String(stackedPrs)} PRs in ${String(result.stacks.length)} stacks collapse to one row each; ` +
    `${String(result.workstreams.length)} workstreams found from shared files, plan docs and titles.`
  document.querySelector('#pane-count').textContent = `${String(total)} open`
  document.querySelector('#pane-footer').textContent =
    `Snapshot ${result.capturedAt.slice(0, 16).replace('T', ' ')} UTC · illustrative, no live actions`

  const layoutSelect = document.querySelector('#layout')
  layoutSelect.value = state.layout
  layoutSelect.addEventListener('change', () => {
    state.layout = layoutSelect.value
    workbench.dataset.show = state.selected ? 'detail' : 'list'
    render()
  })
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.view = button.dataset.view
      render()
    })
  })
  const filter = document.querySelector('#filter')
  filter.addEventListener('input', () => {
    state.filter = filter.value
    render()
  })
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      filter.value = ''
      state.filter = ''
      render()
    }
  })
  const themeButton = document.querySelector('#theme')
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme
    themeButton.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme'
  }
  themeButton.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
  })
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches
  applyTheme(params.get('theme') ?? (prefersLight ? 'light' : 'dark'))

  if (!state.selected && state.layout !== 'pane') {
    const first = [...prs.values()]
      .filter((r) => r.lane === 'user')
      .sort((a, b) => b.number - a.number)[0]
    if (first) state.selected = { kind: 'pr', id: first.number }
  }
  workbench.dataset.show = params.get('pr') || params.get('ws') ? 'detail' : 'list'
  renderLaneBar()
  render()
})()
