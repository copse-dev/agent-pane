const main = document.querySelector('#main-content')
const status = document.querySelector('#catalog-status')

const state = {
  catalog: null,
  runIndexes: new Map(),
  trials: new Map(),
  expanded: new Set(),
  catalogQuery: '',
  catalogBenchmark: 'all',
  query: '',
  variant: 'all',
  outcome: 'all',
  flaggedOnly: false,
  activeTab: 'trace',
  routeSequence: 0,
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className, text, action) {
  const node = element('button', className, text)
  node.type = 'button'
  node.addEventListener('click', action)
  return node
}

function number(value) {
  return value === null || value === undefined ? '—' : new Intl.NumberFormat('en').format(value)
}

function compactNumber(value) {
  if (value === null || value === undefined) return '—'
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  )
}

function duration(value) {
  if (value === null || value === undefined) return '—'
  if (value < 60) return `${value.toFixed(1)}s`
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`
}

function reward(value) {
  return value === null || value === undefined ? '—' : value.toFixed(2)
}

function date(value) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf())
    ? 'Unknown date'
    : parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function statusText(trial) {
  return trial.outcome.slice(0, 1).toUpperCase() + trial.outcome.slice(1)
}

function routeParameters() {
  return new window.URLSearchParams(window.location.hash.replace(/^#/, ''))
}

function runRoute(slug) {
  window.location.hash = new window.URLSearchParams({ run: slug }).toString()
}

function trialRoute(runSlug, trialSlug) {
  window.location.hash = new window.URLSearchParams({ run: runSlug, trial: trialSlug }).toString()
}

function setOptions(select, values, allLabel) {
  const all = element('option', '', allLabel)
  all.value = 'all'
  select.append(all)
  for (const value of values) {
    const option = element('option', '', value)
    option.value = value
    select.append(option)
  }
}

function field(label, control) {
  const wrapper = element('label', 'field')
  wrapper.append(element('span', 'field-label', label), control)
  return wrapper
}

function stat(value, label) {
  const item = element('div', 'stat')
  item.append(element('strong', '', value), element('span', '', label))
  return item
}

function hero(title, description, eyebrow, statistics) {
  const section = element('section', 'hero')
  const copy = element('div')
  copy.append(
    element('span', 'eyebrow', eyebrow),
    element('h1', '', title),
    element('p', '', description),
  )
  const stats = element('div', 'hero-stats')
  for (const [value, label] of statistics) stats.append(stat(value, label))
  section.append(copy, stats)
  return section
}

async function fetchJson(path, label) {
  const response = await fetch(path)
  if (!response.ok) throw new Error(`${label} request failed (${String(response.status)})`)
  return response.json()
}

async function loadRun(summary) {
  const cached = state.runIndexes.get(summary.slug)
  if (cached) return cached
  const index = await fetchJson(summary.indexPath, 'run index')
  if (index?.schemaVersion !== 1 || !Array.isArray(index.trials)) {
    throw new Error('run index has an unsupported shape')
  }
  state.runIndexes.set(summary.slug, index)
  return index
}

async function loadTrial(summary) {
  const cached = state.trials.get(summary.detailPath)
  if (cached) return cached
  const trial = await fetchJson(summary.detailPath, 'trial')
  if (!Array.isArray(trial?.trace)) throw new Error('trial has an unsupported shape')
  state.trials.set(summary.detailPath, trial)
  return trial
}

function renderWarnings() {
  if (state.catalog.warnings.length === 0) return null
  return element(
    'div',
    'warning-banner',
    `${String(state.catalog.warnings.length)} source warning(s). Some run data may be incomplete.`,
  )
}

function catalogToolbar() {
  const bar = element('div', 'toolbar catalog-toolbar')
  const search = element('input')
  search.type = 'search'
  search.placeholder = 'Run, benchmark, model, profile, or commit'
  search.value = state.catalogQuery
  search.addEventListener('input', () => {
    state.catalogQuery = search.value
    renderCatalog()
  })
  const benchmark = element('select')
  setOptions(benchmark, unique(state.catalog.runs.map((run) => run.benchmark)), 'All benchmarks')
  benchmark.value = state.catalogBenchmark
  benchmark.addEventListener('change', () => {
    state.catalogBenchmark = benchmark.value
    renderCatalog()
  })
  bar.append(field('Search runs', search), field('Benchmark', benchmark))
  return bar
}

function filteredRuns() {
  const query = state.catalogQuery.trim().toLowerCase()
  return state.catalog.runs.filter((run) => {
    if (state.catalogBenchmark !== 'all' && run.benchmark !== state.catalogBenchmark) return false
    if (!query) return true
    return [run.id, run.benchmark, ...run.models, ...run.variants, ...run.sourceCommits]
      .join(' ')
      .toLowerCase()
      .includes(query)
  })
}

function runTable(runs) {
  const wrapper = element('div', 'benchmark-table-wrap')
  const table = element('table', 'benchmark-table run-table')
  const header = element('thead')
  const headerRow = element('tr')
  for (const [label, numeric] of [
    ['Run', false],
    ['Benchmark', false],
    ['Models / profiles', false],
    ['Result', false],
    ['Trials', true],
    ['Published', true],
  ]) {
    headerRow.append(element('th', numeric ? 'numeric' : '', label))
  }
  header.append(headerRow)
  const body = element('tbody')
  for (const run of runs) {
    const row = element('tr', 'run-row')
    row.dataset.runSlug = run.slug
    const identity = element('td')
    const open = button('run-link', run.id, () => runRoute(run.slug))
    identity.append(open)
    if (run.sourceCommits[0]) {
      identity.append(element('span', 'run-commit', run.sourceCommits[0].slice(0, 8)))
    }
    const benchmark = element('td')
    benchmark.append(element('span', 'variant-pill', `${run.benchmark} ${run.benchmarkVersion}`))
    const configuration = element('td')
    configuration.append(
      element('span', 'run-models', run.models.join(', ')),
      element('span', 'task-count', run.variants.join(', ')),
    )
    const result = element('td')
    result.append(passCount(run.passed, run.trialCount))
    if (run.flagged > 0) result.append(element('span', 'flag', `${String(run.flagged)} flagged`))
    row.append(
      identity,
      benchmark,
      configuration,
      result,
      element('td', 'numeric', String(run.trialCount)),
      element('td', 'numeric', date(run.createdAt)),
    )
    body.append(row)
  }
  table.append(header, body)
  wrapper.append(table)
  return wrapper
}

function renderCatalog() {
  const runs = filteredRuns()
  const benchmarkCount = unique(state.catalog.runs.map((run) => run.benchmark)).length
  const trialCount = state.catalog.runs.reduce((total, run) => total + run.trialCount, 0)
  main.replaceChildren(
    hero(
      'Benchmark runs, with receipts.',
      'Browse successive evaluations, compare configurations, and inspect the trace behind every score.',
      'Copse Benchmarks',
      [
        [String(state.catalog.runs.length), 'Runs'],
        [String(benchmarkCount), 'Benchmarks'],
        [String(trialCount), 'Trials'],
      ],
    ),
  )
  const warnings = renderWarnings()
  if (warnings) main.append(warnings)
  main.append(catalogToolbar())
  const meta = element('div', 'result-meta')
  meta.append(
    element('span', '', `${String(runs.length)}/${String(state.catalog.runs.length)} runs shown`),
    element('span', '', `Catalog generated ${date(state.catalog.generatedAt)}`),
  )
  main.append(meta)
  if (runs.length === 0) main.append(element('div', 'empty-state', 'No runs match these filters.'))
  else main.append(runTable(runs))
  main.focus({ preventScroll: true })
}

function passCount(passed, total) {
  const wrapper = element('span', 'pass-count')
  const dot = element('span', passed === 0 ? 'pass-dot is-failure' : 'pass-dot')
  dot.setAttribute('aria-hidden', 'true')
  wrapper.append(dot, document.createTextNode(`${String(passed)}/${String(total)}`))
  return wrapper
}

function filteredTrials(index) {
  const query = state.query.trim().toLowerCase()
  return index.trials.filter((trial) => {
    if (state.variant !== 'all' && trial.variant !== state.variant) return false
    if (state.outcome !== 'all' && trial.outcome !== state.outcome) return false
    if (state.flaggedOnly && trial.flags.length === 0) return false
    if (!query) return true
    return [trial.task, trial.variant, trial.model, trial.id]
      .join(' ')
      .toLowerCase()
      .includes(query)
  })
}

function groupedTrials(trials) {
  const groups = new Map()
  for (const trial of trials) {
    const key = `${trial.task}\u0000${trial.variant}`
    const group = groups.get(key)
    if (group) group.trials.push(trial)
    else groups.set(key, { key, task: trial.task, variant: trial.variant, trials: [trial] })
  }
  return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function aggregate(group) {
  return {
    passed: group.trials.filter((trial) => trial.passed).length,
    flagged: group.trials.filter((trial) => trial.flags.length > 0).length,
    tools: group.trials.reduce((sum, trial) => sum + (trial.toolCalls ?? 0), 0),
    tokens: group.trials.reduce(
      (sum, trial) => sum + (trial.inputTokens ?? 0) + (trial.outputTokens ?? 0),
      0,
    ),
    elapsed: group.trials.reduce((sum, trial) => sum + (trial.elapsedSeconds ?? 0), 0),
  }
}

function trialRow(trial) {
  const row = element('tr', 'trial-row')
  row.dataset.trialSlug = trial.slug
  const identity = element('td')
  identity.append(
    button('trial-link', `Attempt ${String(trial.attempt)}`, () =>
      trialRoute(trial.runSlug, trial.slug),
    ),
  )
  const statusCell = element('td')
  statusCell.append(
    element('span', trial.passed ? 'status-label is-pass' : 'status-label', statusText(trial)),
  )
  row.append(
    identity,
    statusCell,
    element('td', 'numeric', reward(trial.reward)),
    element('td', 'numeric', number(trial.toolCalls)),
    element('td', 'numeric', compactNumber((trial.inputTokens ?? 0) + (trial.outputTokens ?? 0))),
    element('td', 'numeric', duration(trial.elapsedSeconds)),
  )
  return row
}

function groupRows(group) {
  const summary = aggregate(group)
  const row = element('tr', 'group-row')
  row.dataset.task = group.task
  row.dataset.variant = group.variant
  const taskCell = element('td')
  const toggle = button('group-toggle', '', () => {
    if (state.expanded.has(group.key)) state.expanded.delete(group.key)
    else state.expanded.add(group.key)
    renderRunIndex(state.runIndexes.get(group.trials[0]?.runSlug))
  })
  toggle.setAttribute('aria-expanded', String(state.expanded.has(group.key)))
  const chevron = element('span', 'chevron', '›')
  chevron.setAttribute('aria-hidden', 'true')
  const task = element('span', 'task-name', group.task)
  task.append(element('span', 'task-count', `${String(group.trials.length)} trials`))
  toggle.append(chevron, task)
  taskCell.append(toggle)
  const variantCell = element('td')
  variantCell.append(element('span', 'variant-pill', group.variant))
  const resultCell = element('td')
  resultCell.append(passCount(summary.passed, group.trials.length))
  if (summary.flagged > 0) {
    resultCell.append(element('span', 'flag', `${String(summary.flagged)} flagged`))
  }
  row.append(
    taskCell,
    variantCell,
    resultCell,
    element('td', 'numeric', number(summary.tools)),
    element('td', 'numeric', compactNumber(summary.tokens)),
    element('td', 'numeric', duration(summary.elapsed)),
  )
  return state.expanded.has(group.key) ? [row, ...group.trials.map(trialRow)] : [row]
}

function trialTable(groups) {
  const wrapper = element('div', 'benchmark-table-wrap')
  const table = element('table', 'benchmark-table')
  const header = element('thead')
  const headerRow = element('tr')
  for (const [label, numeric] of [
    ['Task', false],
    ['Variant', false],
    ['Result', false],
    ['Tools', true],
    ['Tokens', true],
    ['Time', true],
  ]) {
    headerRow.append(element('th', numeric ? 'numeric' : '', label))
  }
  header.append(headerRow)
  const body = element('tbody')
  for (const group of groups) body.append(...groupRows(group))
  table.append(header, body)
  wrapper.append(table)
  return wrapper
}

function trialToolbar(index) {
  const bar = element('div', 'toolbar')
  const search = element('input')
  search.type = 'search'
  search.placeholder = 'Task, profile, model, or trial'
  search.value = state.query
  search.addEventListener('input', () => {
    state.query = search.value
    renderRunIndex(index)
  })
  const variant = element('select')
  setOptions(variant, unique(index.trials.map((trial) => trial.variant)), 'All variants')
  variant.value = state.variant
  variant.addEventListener('change', () => {
    state.variant = variant.value
    renderRunIndex(index)
  })
  const outcome = element('select')
  setOptions(outcome, unique(index.trials.map((trial) => trial.outcome)), 'All outcomes')
  outcome.value = state.outcome
  outcome.addEventListener('change', () => {
    state.outcome = outcome.value
    renderRunIndex(index)
  })
  const flagged = button('toggle', '', () => {
    state.flaggedOnly = !state.flaggedOnly
    renderRunIndex(index)
  })
  flagged.setAttribute('aria-pressed', String(state.flaggedOnly))
  flagged.append(
    element('span', 'toggle-dot'),
    document.createTextNode(state.flaggedOnly ? 'Showing flagged' : 'Flagged only'),
  )
  bar.append(
    field('Search trials', search),
    field('Variant', variant),
    field('Outcome', outcome),
    flagged,
  )
  return bar
}

function breadcrumbs(items) {
  const nav = element('nav', 'breadcrumbs')
  nav.setAttribute('aria-label', 'Breadcrumb')
  items.forEach((item, index) => {
    if (index > 0) nav.append(document.createTextNode('/'))
    if (item.action) nav.append(button('back-link', item.label, item.action))
    else nav.append(element('span', '', item.label))
  })
  return nav
}

function renderRunIndex(index) {
  if (!index) return
  const trials = filteredTrials(index)
  const groups = groupedTrials(trials)
  main.replaceChildren(
    breadcrumbs([
      { label: 'Benchmarks', action: () => (window.location.hash = '') },
      { label: index.run.id },
    ]),
    hero(
      index.run.id,
      `${index.run.models.join(', ')} · ${index.run.variants.length} configuration(s) · ${index.run.sourceCommits[0]?.slice(0, 8) ?? 'unversioned source'}`,
      `${index.run.benchmark} ${index.run.benchmarkVersion}`,
      [
        [String(index.run.trialCount), 'Trials'],
        [String(index.run.taskCount), 'Tasks'],
        [String(index.run.flagged), 'Flagged'],
      ],
    ),
    trialToolbar(index),
  )
  const meta = element('div', 'result-meta')
  meta.append(
    element('span', '', `${String(trials.length)}/${String(index.trials.length)} trials shown`),
    element('span', '', `${String(groups.length)} task/variant rows`),
  )
  main.append(meta)
  if (groups.length === 0)
    main.append(element('div', 'empty-state', 'No trials match these filters.'))
  else main.append(trialTable(groups))
  main.focus({ preventScroll: true })
}

function metric(label, value) {
  const card = element('div', 'metric')
  card.append(element('span', 'metric-label', label), element('span', 'metric-value', value))
  return card
}

function badge(text, variant = '') {
  return element('span', `badge${variant ? ` ${variant}` : ''}`, text)
}

function downloadTrial(trial) {
  const blob = new Blob([`${JSON.stringify(trial, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${trial.task}-${trial.variant}-attempt-${String(trial.attempt)}.json`
  link.click()
  URL.revokeObjectURL(url)
}

function toolCall(call) {
  const details = element('details', 'tool-call')
  const summary = element('summary')
  summary.append(
    element('span', 'tool-badge', call.name),
    element('span', call.status === 'error' ? 'tool-status is-error' : 'tool-status', call.status),
  )
  details.append(summary, element('div', 'code-label', 'Arguments'))
  const args = element('pre')
  args.textContent = JSON.stringify(call.args ?? null, null, 2)
  details.append(args)
  if (call.result !== null) {
    details.append(element('div', 'code-label', 'Result'))
    const result = element('pre')
    result.textContent = call.result
    details.append(result)
  }
  return details
}

function stepCard(message, index) {
  const card = element('article', 'step-card')
  const body = element('div', 'step-body')
  const header = element('header', 'step-header')
  header.append(
    element(
      'span',
      `step-role${message.role === 'user' ? ' is-user' : message.role === 'error' ? ' is-error' : ''}`,
      message.role,
    ),
    element('span', 'step-model', message.model ?? ''),
  )
  body.append(header)
  if (message.reasoning) {
    const reasoning = element('details', 'reasoning')
    reasoning.append(
      element('summary', '', `Reasoning · ${number(message.reasoning.length)} characters`),
      element('div', 'reasoning-content', message.reasoning),
    )
    body.append(reasoning)
  }
  body.append(element('div', 'message-content', message.content))
  for (const call of message.toolCalls) body.append(toolCall(call))
  card.append(element('div', 'step-index', `#${String(index + 1)}`), body)
  return card
}

function tracePanel(trial) {
  const list = element('div', 'trace-list')
  if (trial.trace.length === 0) {
    list.append(
      element('div', 'empty-state', 'This trial does not contain a readable thread trace.'),
    )
  } else trial.trace.forEach((message, index) => list.append(stepCard(message, index)))
  return list
}

function verifierPanel(trial) {
  const grid = element('div', 'verifier-grid')
  const verifier = element('section', 'verifier-card')
  verifier.append(
    element('h3', '', trial.verifierError ? 'Verifier error' : 'Verifier completed'),
    element('p', '', trial.verifierError ?? 'No verifier error was recorded for this trial.'),
  )
  if (trial.verifierErrorCategory) verifier.append(badge(trial.verifierErrorCategory, 'is-fail'))
  const agent = element('section', 'verifier-card')
  agent.append(
    element('h3', '', trial.agentError ? 'Agent exception' : 'Agent completed'),
    element('p', '', trial.agentError ?? 'No agent exception was recorded for this trial.'),
  )
  if (trial.agentErrorCategory) agent.append(badge(trial.agentErrorCategory, 'is-fail'))
  grid.append(verifier, agent)
  return grid
}

function stepSignature(message) {
  return `${message.role}\u0000${message.content}\u0000${message.toolCalls.map((call) => call.name).join('\u0000')}`
}

function firstDivergence(left, right) {
  const maximum = Math.max(left.trace.length, right.trace.length)
  for (let index = 0; index < maximum; index += 1) {
    const leftMessage = left.trace[index]
    const rightMessage = right.trace[index]
    if (
      !leftMessage ||
      !rightMessage ||
      stepSignature(leftMessage) !== stepSignature(rightMessage)
    ) {
      return index
    }
  }
  return -1
}

function compareColumn(trial, divergence) {
  const column = element('section', 'compare-column')
  column.append(
    element('h3', '', `${trial.runId} · ${trial.variant} · attempt ${String(trial.attempt)}`),
  )
  trial.trace.forEach((message, index) => {
    const row = element('div', index === divergence ? 'compare-step is-divergence' : 'compare-step')
    row.append(
      element('strong', '', `#${String(index + 1)} ${message.role}`),
      element(
        'p',
        '',
        message.content ||
          message.reasoning ||
          message.toolCalls.map((call) => call.name).join(', '),
      ),
    )
    column.append(row)
  })
  return column
}

async function allTrialSummaries() {
  const indexes = await Promise.all(state.catalog.runs.map((run) => loadRun(run)))
  return indexes.flatMap((index) => index.trials)
}

function comparison(trial) {
  const details = element('details', 'compare-panel')
  details.append(element('summary', '', 'Compare trial'))
  const body = element('div', 'compare-body')
  details.append(body)
  let initialized = false
  details.addEventListener('toggle', () => {
    if (!details.open || initialized) return
    initialized = true
    body.replaceChildren(element('p', 'loading-state', 'Finding comparable trials…'))
    void allTrialSummaries()
      .then((summaries) =>
        summaries.filter((candidate) => candidate.task === trial.task && candidate.id !== trial.id),
      )
      .then(async (candidates) => {
        if (candidates.length === 0) {
          body.replaceChildren(element('p', 'empty-state', 'No comparable trial was published.'))
          return
        }
        candidates.sort((left, right) => {
          const leftScore =
            Number(left.runId === trial.runId) * 4 +
            Number(left.attempt === trial.attempt) * 2 +
            Number(left.variant !== trial.variant)
          const rightScore =
            Number(right.runId === trial.runId) * 4 +
            Number(right.attempt === trial.attempt) * 2 +
            Number(right.variant !== trial.variant)
          return rightScore - leftScore || left.id.localeCompare(right.id)
        })
        const controls = element('div', 'compare-controls')
        const select = element('select')
        for (const candidate of candidates) {
          const option = element(
            'option',
            '',
            `${candidate.runId} · ${candidate.variant} · attempt ${String(candidate.attempt)}`,
          )
          option.value = candidate.detailPath
          select.append(option)
        }
        controls.append(element('label', '', 'Compare with'), select)
        const result = element('div')
        const render = async () => {
          result.replaceChildren(element('p', 'loading-state', 'Loading comparison…'))
          const selected = candidates.find((candidate) => candidate.detailPath === select.value)
          if (!selected) return
          const paired = await loadTrial(selected)
          const divergence = firstDivergence(trial, paired)
          result.replaceChildren(
            element(
              'p',
              'divergence-note',
              divergence < 0
                ? 'No message-level divergence detected.'
                : `First message-level divergence at step #${String(divergence + 1)}.`,
            ),
          )
          const grid = element('div', 'compare-grid')
          grid.append(compareColumn(trial, divergence), compareColumn(paired, divergence))
          result.append(grid)
        }
        select.addEventListener('change', () => void render())
        body.replaceChildren(controls, result)
        await render()
      })
      .catch((error) => {
        body.replaceChildren(
          element(
            'div',
            'error-state',
            `Could not load comparisons: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      })
  })
  return details
}

function tabs(trial) {
  const wrapper = element('div')
  const tablist = element('div', 'tabs')
  tablist.setAttribute('role', 'tablist')
  const content = element('div')
  const select = (name) => {
    state.activeTab = name
    for (const tab of tablist.querySelectorAll('.tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === name))
    }
    content.replaceChildren(name === 'trace' ? tracePanel(trial) : verifierPanel(trial))
  }
  for (const [name, label] of [
    ['trace', `Trace · ${String(trial.trace.length)} steps`],
    ['verifier', 'Verifier'],
  ]) {
    const tab = button('tab', label, () => select(name))
    tab.dataset.tab = name
    tab.setAttribute('role', 'tab')
    tablist.append(tab)
  }
  wrapper.append(tablist, content)
  select(state.activeTab)
  return wrapper
}

function renderTrial(trial) {
  main.replaceChildren()
  const shell = element('div', 'detail-shell')
  shell.append(
    breadcrumbs([
      { label: 'Benchmarks', action: () => (window.location.hash = '') },
      { label: trial.runId, action: () => runRoute(trial.runSlug) },
      { label: trial.task },
      { label: `attempt ${String(trial.attempt)}` },
    ]),
  )
  const heading = element('section', 'detail-heading')
  const copy = element('div')
  copy.append(
    element('span', 'eyebrow', `${trial.benchmark} · ${trial.runId}`),
    element('h1', '', trial.task),
  )
  const badges = element('div', 'badge-row')
  badges.append(
    badge(statusText(trial), trial.passed ? 'is-pass' : 'is-fail'),
    badge(trial.variant),
    badge(`Attempt ${String(trial.attempt)}`),
  )
  for (const flag of trial.flags) badges.append(badge(flag, 'is-fail'))
  copy.append(badges)
  heading.append(
    copy,
    button('download-button', 'Download trial JSON ↓', () => downloadTrial(trial)),
  )
  const metrics = element('section', 'metrics')
  metrics.append(
    metric('Reward', reward(trial.reward)),
    metric('Tool calls', number(trial.toolCalls)),
    metric('Reasoning chars', number(trial.reasoningCharacters)),
    metric(
      'Input / output',
      `${compactNumber(trial.inputTokens)} / ${compactNumber(trial.outputTokens)}`,
    ),
    metric('Elapsed', duration(trial.elapsedSeconds)),
    metric('Model', trial.model),
  )
  shell.append(heading, metrics)
  const prompt = element('details', 'content-card')
  prompt.append(
    element('summary', '', 'Task prompt'),
    element('div', 'prompt-content', trial.prompt),
  )
  shell.append(prompt, comparison(trial), tabs(trial))
  main.append(shell)
  main.focus({ preventScroll: true })
}

function renderLoading(message) {
  main.replaceChildren(element('div', 'loading-state page-loading', message))
}

async function renderRoute() {
  if (!state.catalog) return
  const sequence = ++state.routeSequence
  const parameters = routeParameters()
  const runSlug = parameters.get('run')
  const trialSlug = parameters.get('trial')
  if (!runSlug) {
    renderCatalog()
    return
  }
  const run = state.catalog.runs.find((candidate) => candidate.slug === runSlug)
  if (!run) {
    window.location.hash = ''
    return
  }
  renderLoading('Loading run…')
  try {
    const index = await loadRun(run)
    if (sequence !== state.routeSequence) return
    if (!trialSlug) {
      renderRunIndex(index)
      return
    }
    const summary = index.trials.find((candidate) => candidate.slug === trialSlug)
    if (!summary) {
      runRoute(runSlug)
      return
    }
    const trial = await loadTrial(summary)
    if (sequence === state.routeSequence) renderTrial(trial)
  } catch (error) {
    if (sequence !== state.routeSequence) return
    main.replaceChildren(
      element(
        'div',
        'error-state',
        `Could not load benchmark data: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }
}

async function start() {
  try {
    const catalog = await fetchJson('./catalog.json', 'catalog')
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.runs)) {
      throw new Error('catalog.json has an unsupported shape')
    }
    state.catalog = catalog
    const trials = catalog.runs.reduce((total, run) => total + run.trialCount, 0)
    status.textContent = `${String(catalog.runs.length)} runs · ${String(trials)} trials · generated ${new Date(catalog.generatedAt).toLocaleString()}`
    await renderRoute()
  } catch (error) {
    status.textContent = 'Catalog unavailable'
    main.replaceChildren(
      element(
        'div',
        'error-state',
        `Could not load Copse Benchmarks: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }
}

window.addEventListener('hashchange', () => void renderRoute())
void start()
