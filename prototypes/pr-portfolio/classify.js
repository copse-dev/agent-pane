// Classifies a facts-only PR snapshot (snapshot.js) into lanes, stacks and
// workstreams. Pure: the same snapshot and clock always give the same result.
// Every judgment carries the reasons behind it, so the panel can show "why"
// and an agent can be handed the identical record (see agentContext*).
;(function () {
  'use strict'

  const RULES = {
    staleDays: 7,
    activeHours: 3,
    farBehindCommits: 300,
    // A file touched by at least this share of open PRs is too common to say
    // anything about which PRs belong together (e2e shard weights, main/index.ts).
    hotFileShare: 0.12,
    overlapMinFiles: 3,
    overlapMinJaccard: 0.1,
    duplicateMinFiles: 4,
    duplicateMinJaccard: 0.5,
    // A plan doc that this many open PRs edit (e.g. a binding decisions log)
    // says nothing about which PRs belong together.
    hotPlanDocPrs: 4,
    titleMinSimilarity: 0.25,
  }

  const DAY = 86_400_000
  const HOUR = 3_600_000

  const LANES = [
    { id: 'user', label: 'Needs you', hint: 'Merge, review screenshots or decide' },
    { id: 'agent', label: 'Needs an agent', hint: 'Failing checks or review feedback to address' },
    {
      id: 'progress',
      label: 'In progress',
      hint: 'Checks running or a draft still being worked on',
    },
    { id: 'stalled', label: 'Stalled', hint: `No activity for ${String(RULES.staleDays)}+ days` },
    { id: 'parked', label: 'Parked', hint: 'Marked do-not-merge' },
  ]
  const LANE_ORDER = Object.fromEntries(LANES.map((lane, index) => [lane.id, index]))

  const STOPWORDS = new Set(
    (
      'a an the and or of in on to for from with by at as is are be it its their this that ' +
      'when where while than then only one each every all into across through without after ' +
      'before instead not no via can do does make makes keep let lets use uses using copse ' +
      'claude codex fix fixes bug bugs add adds new more less own up out per'
    ).split(' '),
  )

  function days(ms) {
    return Math.floor(ms / DAY)
  }

  function plural(count, word) {
    return `${String(count)} ${word}${count === 1 ? '' : 's'}`
  }

  function tokens(pr) {
    const branch = pr.headRef.replace(/-[0-9a-f]{6}$/, '')
    return `${pr.title} ${branch}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word))
      .map((word) => (word.length > 4 && /[^su]s$/.test(word) ? word.slice(0, -1) : word))
  }

  // Words that describe the action rather than the subject; skipped in names.
  const NAME_SKIP = new Set(
    (
      'allow require preserve render start show turn list reach open serve read verify ' +
      'confine contain refresh completed protected offer stop hold forget recover refuse ' +
      'harden support guide set move remove print fail click plan prototype'
    ).split(' '),
  )
  const NAME_CASE = new Map(
    Object.entries({
      ssh: 'SSH',
      ci: 'CI',
      mcp: 'MCP',
      ipc: 'IPC',
      xss: 'XSS',
      gpt: 'GPT',
      npm: 'npm',
      acp: 'ACP',
      e2e: 'e2e',
      api: 'API',
      github: 'GitHub',
      macos: 'macOS',
      pii: 'PII',
    }),
  )

  function displayWord(word) {
    return NAME_CASE.get(word) ?? word[0].toUpperCase() + word.slice(1)
  }

  function classifyType(pr) {
    const title = pr.title
    const cats = pr.diff.categories
    const source = pr.diff.sourcePaths
    if (/^plan\b/i.test(title) || (cats.source === 0 && pr.diff.planDocs.length > 0)) {
      return { value: 'plan', reason: 'Title starts with "Plan", or it only changes plan docs' }
    }
    if (
      /\bprototype\b|^\[diagnostic\]/i.test(title) ||
      (cats.source === 0 && cats.prototypes > 0)
    ) {
      return { value: 'prototype', reason: 'Title names a prototype or diagnostic' }
    }
    const infraPath = /^(scripts\/|\.github\/|ci-runners\/|build\/|wdio)/
    if (
      (source.length > 0 && source.every((path) => infraPath.test(path))) ||
      (cats.source === 0 && cats.tests > 0) ||
      /\b(e2e|screenshot|ci|release|profiler)\b/i.test(title)
    ) {
      return { value: 'infra', reason: 'Only touches tests, scripts or CI, or names them' }
    }
    if (/^(fix|stop|keep|restore|preserve|recover|refuse|hold|forget|remove)\b/i.test(title)) {
      return { value: 'fix', reason: `Title starts with "${title.split(/[\s(:]/)[0]}"` }
    }
    if (/^(harden|contain|require|confine|verify|render only)\b/i.test(title)) {
      return { value: 'hardening', reason: `Title starts with "${title.split(' ')[0]}"` }
    }
    return { value: 'feature', reason: 'No fix, hardening, infra, plan or prototype signal' }
  }

  function classifySize(pr) {
    const lines = pr.diff.sourceAdded + pr.diff.sourceDeleted
    const bucket =
      lines < 50 ? 'XS' : lines < 200 ? 'S' : lines < 600 ? 'M' : lines < 1500 ? 'L' : 'XL'
    return {
      bucket,
      sourceLines: lines,
      added: pr.diff.sourceAdded,
      deleted: pr.diff.sourceDeleted,
      reason: 'Added + deleted lines outside tests, docs, fixtures, screenshots and lockfiles',
    }
  }

  const SURFACES = [
    { id: 'sandbox', pattern: /sandbox|seatbelt|asrt/i },
    { id: 'permissions', pattern: /permission|approval|escalat/i },
    { id: 'secrets', pattern: /secret|keyring|credential|token-|auth(?!or)/i },
    { id: 'security', pattern: /\/security\//i },
  ]

  function sensitiveSurfaces(pr) {
    return SURFACES.filter((surface) =>
      pr.diff.sourcePaths.some((path) => surface.pattern.test(path)),
    ).map((surface) => surface.id)
  }

  // Checks hold only the latest run of each check name (snapshot.js), so a
  // superseded failure never counts. Where the repository's aggregate
  // `CI Passed` gate exists it decides pass or fail; other failures under a
  // green gate are non-blocking. A failing `Base Current` means the branch is
  // behind its required base. #4226 reads GitHub's own required flags instead.
  function checkState(checks) {
    if (!checks || checks.total === 0) return { kind: 'none', names: [], behindBase: false }
    const behindBase = checks.failedNames.includes('Base Current')
    const names = checks.failedNames.filter(
      (name) => name !== 'Base Current' && name !== 'CI Passed',
    )
    if (checks.gate === 'failed') return { kind: 'failing', names, behindBase }
    if (checks.running > 0 || checks.gate === 'running')
      return { kind: 'running', names, behindBase }
    if (checks.gate === null && names.length > 0) return { kind: 'failing', names, behindBase }
    if (checks.gate === 'passed' || checks.passed > 0) return { kind: 'passed', names, behindBase }
    return { kind: 'none', names, behindBase }
  }

  function classifyLane(pr, now) {
    const idle = days(now - Date.parse(pr.updatedAt))
    const checks = pr.checks
    const labels = new Set(pr.labels)
    const stale = idle >= RULES.staleDays
    const staleReason = `No activity for ${String(idle)} days`
    const ci = checkState(checks)
    const nonBlocking =
      ci.kind === 'passed' && ci.names.length > 0
        ? [`Non-blocking failures under a green CI Passed gate: ${ci.names.join(', ')}`]
        : []
    // An agent's turn that nobody has taken for a week is stalled.
    const agentTurn = (action, short, reasons) =>
      stale
        ? {
            lane: 'stalled',
            actor: 'nobody',
            action: `${short} · idle ${String(idle)}d`,
            reasons: [...reasons, staleReason],
          }
        : { lane: 'agent', actor: 'agent', action, reasons }
    if (/parked|do not merge/i.test(pr.title)) {
      return {
        lane: 'parked',
        actor: 'nobody',
        action: 'Parked',
        reasons: ['Title marks it do-not-merge'],
      }
    }
    if (ci.kind === 'failing') {
      const list = ci.names.slice(0, 3).join(', ')
      return agentTurn('Fix failing checks', 'CI failing', [
        checks.gate === 'failed'
          ? `CI Passed gate failed${list ? `: ${list}` : ''}`
          : `${plural(ci.names.length, 'check')} failed: ${list}`,
      ])
    }
    if (ci.behindBase) {
      return agentTurn('Rebase onto main', 'Needs rebase', [
        'Base Current fails: the branch is behind its required base',
        ...nonBlocking,
      ])
    }
    if (labels.has('review-has-feedback')) {
      return agentTurn('Address review feedback', 'Feedback unaddressed', [
        'Labelled review-has-feedback',
      ])
    }
    if (ci.kind === 'running') {
      return {
        lane: 'progress',
        actor: 'ci',
        action: 'Checks running',
        reasons: [
          `${plural(checks.running, 'check')} running: ${checks.runningNames.join(', ')}`,
          ...(ci.names.length > 0
            ? [`Failed so far, before the gate reports: ${ci.names.slice(0, 3).join(', ')}`]
            : []),
        ],
      }
    }
    if (labels.has('screenshots-need-review')) {
      return {
        lane: 'user',
        actor: 'user',
        action: 'Review screenshots',
        reasons: [
          'Labelled screenshots-need-review',
          ...nonBlocking,
          ...(stale ? [staleReason] : []),
        ],
      }
    }
    if (ci.kind === 'passed') {
      const ready = pr.draft ? 'Mark ready for review' : 'Ready to merge'
      return {
        lane: 'user',
        actor: 'user',
        action: pr.baseIsOpenPr && !pr.draft ? `Merge after #${String(pr.baseIsOpenPr)}` : ready,
        reasons: [
          checks.gate === 'passed'
            ? 'CI Passed gate is green on the current head'
            : `${plural(checks.passed, 'check')} passed, none failing or running`,
          ...nonBlocking,
          pr.draft ? 'Still a draft' : 'Not a draft',
          ...(stale ? [`Waiting on you for ${String(idle)} days`] : []),
        ],
      }
    }
    if (stale) {
      return {
        lane: 'stalled',
        actor: 'nobody',
        action: `Idle ${String(idle)}d`,
        reasons: [staleReason, 'No check results on the current head'],
      }
    }
    if (pr.draft) {
      return {
        lane: 'progress',
        actor: 'agent',
        action: 'Draft · no CI yet',
        reasons: [
          'Draft with no check results on the current head',
          `Last activity ${String(idle)}d ago`,
        ],
      }
    }
    return {
      lane: 'user',
      actor: 'user',
      action: 'Request CI',
      reasons: ['Ready for review but no check results on the current head'],
    }
  }

  function buildStacks(prs, byNumber) {
    const children = new Map()
    for (const pr of prs) {
      if (pr.baseIsOpenPr === null) continue
      const list = children.get(pr.baseIsOpenPr) ?? []
      list.push(pr.number)
      children.set(pr.baseIsOpenPr, list)
    }
    const stacks = []
    for (const pr of prs) {
      if (pr.baseIsOpenPr !== null || !children.has(pr.number)) continue
      const members = []
      const walk = (number) => {
        members.push(number)
        for (const child of (children.get(number) ?? []).sort((a, b) => a - b)) walk(child)
      }
      walk(pr.number)
      stacks.push({ id: `stack-${String(pr.number)}`, root: pr.number, members })
    }
    const stackOf = new Map()
    for (const stack of stacks) {
      stack.members.forEach((number, index) => {
        stackOf.set(number, { id: stack.id, position: index + 1, length: stack.members.length })
      })
      stack.title = byNumber.get(stack.root).title
    }
    return { stacks, stackOf }
  }

  function similarity(a, b) {
    let dot = 0
    for (const [word, weight] of a) dot += weight * (b.get(word) ?? 0)
    const norm = (v) => Math.sqrt([...v.values()].reduce((sum, w) => sum + w * w, 0))
    const denominator = norm(a) * norm(b)
    return denominator === 0 ? 0 : dot / denominator
  }

  function classifyPortfolio(snapshot, now) {
    const prs = snapshot.prs
    const byNumber = new Map(prs.map((pr) => [pr.number, pr]))
    const { stacks, stackOf } = buildStacks(prs, byNumber)
    const sameStack = (a, b) => stackOf.has(a) && stackOf.get(a).id === stackOf.get(b)?.id

    // Hot files: touched by so many open PRs that sharing them means little.
    const fileCounts = new Map()
    for (const pr of prs) {
      for (const path of pr.diff.sourcePaths) fileCounts.set(path, (fileCounts.get(path) ?? 0) + 1)
    }
    const hotThreshold = Math.max(4, Math.ceil(prs.length * RULES.hotFileShare))
    const hotFiles = [...fileCounts]
      .filter(([, count]) => count >= hotThreshold)
      .sort((a, b) => b[1] - a[1])
      .map(([path, count]) => ({
        path,
        count,
        prs: prs.filter((pr) => pr.diff.sourcePaths.includes(path)).map((pr) => pr.number),
      }))
    const isHot = new Set(hotFiles.map((file) => file.path))
    const coldPaths = new Map(
      prs.map((pr) => [pr.number, new Set(pr.diff.sourcePaths.filter((path) => !isHot.has(path)))]),
    )

    const planCounts = new Map()
    for (const pr of prs) {
      for (const path of pr.diff.planDocs) planCounts.set(path, (planCounts.get(path) ?? 0) + 1)
    }
    const hotPlanDocs = new Set(
      [...planCounts]
        .filter(([path, count]) => count >= RULES.hotPlanDocPrs || path.endsWith('README.md'))
        .map(([path]) => path),
    )

    // Title + branch word vectors, weighted by rarity across the open PRs.
    const docFreq = new Map()
    const words = new Map(prs.map((pr) => [pr.number, tokens(pr)]))
    for (const list of words.values()) {
      for (const word of new Set(list)) docFreq.set(word, (docFreq.get(word) ?? 0) + 1)
    }
    const idf = (word) => Math.log(prs.length / (docFreq.get(word) ?? 1))
    const vectors = new Map(
      [...words].map(([number, list]) => {
        const vector = new Map()
        for (const word of list) vector.set(word, (vector.get(word) ?? 0) + idf(word))
        return [number, vector]
      }),
    )

    // Edges between PRs, each with the evidence that created it.
    const edges = []
    for (const stack of stacks) {
      for (let i = 1; i < stack.members.length; i++) {
        const child = byNumber.get(stack.members[i])
        edges.push({
          a: child.baseIsOpenPr,
          b: child.number,
          kind: 'stack',
          detail: `#${String(child.number)} is stacked on #${String(child.baseIsOpenPr)}`,
        })
      }
    }
    for (let i = 0; i < prs.length; i++) {
      for (let j = i + 1; j < prs.length; j++) {
        const a = prs[i]
        const b = prs[j]
        if (sameStack(a.number, b.number)) continue
        const pa = coldPaths.get(a.number)
        const pb = coldPaths.get(b.number)
        const shared = [...pa].filter((path) => pb.has(path))
        const union = new Set([...pa, ...pb]).size
        const jaccard = union === 0 ? 0 : shared.length / union
        if (shared.length >= RULES.overlapMinFiles && jaccard >= RULES.overlapMinJaccard) {
          const heavy =
            shared.length >= RULES.duplicateMinFiles && jaccard >= RULES.duplicateMinJaccard
          edges.push({
            a: a.number,
            b: b.number,
            kind: heavy ? 'duplicate' : 'overlap',
            jaccard: Math.round(jaccard * 100) / 100,
            shared: shared.sort(),
            detail: `Share ${plural(shared.length, 'source file')} (${String(Math.round(jaccard * 100))}% of their combined files)`,
          })
        }
        const plans = a.diff.planDocs.filter(
          (path) => b.diff.planDocs.includes(path) && !hotPlanDocs.has(path),
        )
        if (plans.length > 0) {
          edges.push({
            a: a.number,
            b: b.number,
            kind: 'plan',
            shared: plans,
            detail: `Both change ${plans[0].replace('docs/plans/', '')}`,
          })
        }
        const score = similarity(vectors.get(a.number), vectors.get(b.number))
        const common = [...new Set(words.get(a.number))]
          .filter((word) => words.get(b.number).includes(word))
          .sort((x, y) => idf(y) - idf(x))
        if (score >= RULES.titleMinSimilarity && common.length >= 2) {
          edges.push({
            a: a.number,
            b: b.number,
            kind: 'topic',
            detail: `Titles and branches share "${common.slice(0, 3).join('", "')}"`,
          })
        }
      }
    }

    // Workstreams: connected PRs. Union-find over the edges above.
    const parent = new Map(prs.map((pr) => [pr.number, pr.number]))
    const find = (n) => (parent.get(n) === n ? n : find(parent.get(n)))
    for (const edge of edges) parent.set(find(edge.a), find(edge.b))
    const groups = new Map()
    for (const pr of prs) {
      const root = find(pr.number)
      groups.set(root, [...(groups.get(root) ?? []), pr.number])
    }

    const records = new Map()
    for (const pr of prs) {
      const idleMs = now - Date.parse(pr.updatedAt)
      const lane = classifyLane(pr, now)
      const signals = []
      if (pr.baseIsOpenPr === null && pr.baseRef !== 'main') {
        signals.push({
          kind: 'hidden-parent',
          text: `Based on ${pr.baseRef}, which has no open PR`,
        })
      }
      if (pr.mainBase.behind >= RULES.farBehindCommits) {
        signals.push({
          kind: 'far-behind',
          text: `Branched from main of ${pr.mainBase.committedAt.slice(0, 10)}, ${String(pr.mainBase.behind)} commits behind`,
        })
      }
      const ci = checkState(pr.checks)
      if (ci.kind === 'passed' && ci.names.length > 0) {
        signals.push({
          kind: 'non-blocking-failures',
          text: `${ci.names.join(', ')} failing; the CI Passed gate is still green`,
        })
      }
      if (idleMs < RULES.activeHours * HOUR) {
        signals.push({ kind: 'active', text: 'Pushed or updated in the last few hours' })
      }
      const myEdges = edges.filter((edge) => edge.a === pr.number || edge.b === pr.number)
      const overlaps = myEdges
        .filter((edge) => edge.kind === 'overlap' || edge.kind === 'duplicate')
        .map((edge) => ({
          pr: edge.a === pr.number ? edge.b : edge.a,
          kind: edge.kind,
          jaccard: edge.jaccard,
          shared: edge.shared,
        }))
        .sort((x, y) => y.jaccard - x.jaccard)
      if (overlaps.some((overlap) => overlap.kind === 'duplicate')) {
        signals.push({
          kind: 'heavy-overlap',
          text: `Heavy file overlap with #${String(overlaps[0].pr)}: competing changes or a merge conflict`,
        })
      }
      records.set(pr.number, {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        draft: pr.draft,
        idleDays: days(idleMs),
        openDays: days(now - Date.parse(pr.createdAt)),
        ...lane,
        type: classifyType(pr),
        size: classifySize(pr),
        surfaces: sensitiveSurfaces(pr),
        stack: stackOf.get(pr.number) ?? null,
        workstream: null,
        overlaps,
        hotFiles: pr.diff.sourcePaths.filter((path) => isHot.has(path)),
        signals,
        facts: pr,
      })
    }

    const workstreams = [...groups.values()]
      .filter((members) => members.length > 1)
      .map((members) => {
        members.sort((a, b) => a - b)
        const memberSet = new Set(members)
        const weight = new Map()
        for (const number of members) {
          for (const word of new Set(words.get(number))) {
            if ((docFreq.get(word) ?? 0) < 2 || NAME_SKIP.has(word)) continue
            weight.set(word, (weight.get(word) ?? 0) + idf(word))
          }
        }
        const top = [...weight]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([word]) => word)
        const name = top.map(displayWord).join(' · ')
        const own = edges.filter((edge) => memberSet.has(edge.a) && memberSet.has(edge.b))
        const fileCountsHere = new Map()
        for (const number of members) {
          for (const path of coldPaths.get(number)) {
            fileCountsHere.set(path, (fileCountsHere.get(path) ?? 0) + 1)
          }
        }
        const sharedFiles = [...fileCountsHere]
          .filter(([, count]) => count > 1)
          .sort((a, b) => b[1] - a[1])
          .map(([path, count]) => ({ path, count }))
        const lanes = Object.fromEntries(LANES.map((lane) => [lane.id, 0]))
        for (const number of members) lanes[records.get(number).lane] += 1
        return {
          id: `ws-${String(members[0])}`,
          name,
          nameReason: 'Most distinctive words shared by its titles and branch names',
          members,
          stacks: stacks.filter((stack) => memberSet.has(stack.root)).map((stack) => stack.id),
          edges: own,
          duplicates: own.filter((edge) => edge.kind === 'duplicate'),
          sharedFiles,
          lanes,
        }
      })
      .sort((a, b) => b.members.length - a.members.length || a.members[0] - b.members[0])
    for (const stream of workstreams) {
      for (const number of stream.members) records.get(number).workstream = stream.id
    }

    for (const stack of stacks) {
      const lanes = stack.members.map((number) => records.get(number).lane)
      stack.lane = lanes.reduce((best, lane) => (LANE_ORDER[lane] < LANE_ORDER[best] ? lane : best))
      const lead = stack.members.find((number) => records.get(number).lane === stack.lane)
      stack.lead = lead
      stack.action = `#${String(lead)}: ${records.get(lead).action}`
    }

    return {
      repo: snapshot.repo,
      capturedAt: snapshot.capturedAt,
      classifiedAt: new Date(now).toISOString(),
      rules: RULES,
      lanes: LANES,
      prs: records,
      stacks,
      workstreams,
      hotFiles,
      edges,
    }
  }

  // What an agent would be handed: the same judgments and reasons, minus
  // the raw facts it can fetch itself.
  function agentContextForPr(result, number) {
    const record = result.prs.get(number)
    const stream = result.workstreams.find((ws) => ws.id === record.workstream)
    const stack = result.stacks.find((s) => s.id === record.stack?.id)
    return {
      pr: record.number,
      title: record.title,
      url: record.url,
      lane: record.lane,
      nextActor: record.actor,
      nextAction: record.action,
      reasons: record.reasons,
      type: record.type.value,
      size: { bucket: record.size.bucket, sourceLines: record.size.sourceLines },
      sensitiveSurfaces: record.surfaces,
      stack: stack ? { members: stack.members, position: record.stack.position } : null,
      workstream: stream ? { id: stream.id, name: stream.name, members: stream.members } : null,
      overlaps: record.overlaps.map((overlap) => ({
        pr: overlap.pr,
        kind: overlap.kind,
        sharedFiles: overlap.shared,
      })),
      hotFiles: record.hotFiles,
      signals: record.signals.map((signal) => signal.text),
      idleDays: record.idleDays,
      snapshot: result.capturedAt,
    }
  }

  function agentContextForWorkstream(result, id) {
    const stream = result.workstreams.find((ws) => ws.id === id)
    return {
      workstream: stream.id,
      name: stream.name,
      members: stream.members.map((number) => {
        const record = result.prs.get(number)
        return {
          pr: number,
          title: record.title,
          lane: record.lane,
          nextAction: record.action,
          stack: record.stack
            ? `${String(record.stack.position)}/${String(record.stack.length)}`
            : null,
        }
      }),
      links: stream.edges.map((edge) => ({
        a: edge.a,
        b: edge.b,
        kind: edge.kind,
        why: edge.detail,
      })),
      possibleDuplicates: stream.duplicates.map((edge) => [edge.a, edge.b]),
      sharedFiles: stream.sharedFiles.slice(0, 12),
      snapshot: result.capturedAt,
    }
  }

  window.PrPortfolio = { classifyPortfolio, agentContextForPr, agentContextForWorkstream, RULES }
})()
