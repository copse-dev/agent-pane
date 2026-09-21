// Standalone design workshop; not imported by the application.
;(function () {
  const examples = [
    {
      id: 'change',
      title: 'Fix duplicate search results',
      prompt: 'Can you fix the duplicate results and tell me what changed?',
      activity: '3 files inspected · 2 files changed · 42 tests passed',
      steps: [
        'Read search.ts, results.ts, and search.test.ts',
        'Updated result merging and added a regression case',
        'Ran the focused search suite: 42 passed',
      ],
      prose: `
        <p class="lead"><strong>Search results no longer repeat the same file.</strong> Results are merged by file path before ranking, so the strongest match appears once.</p>
        <h2>What changed</h2>
        <ul>
          <li><code>search.ts</code> — merges lexical and semantic matches by path, keeping the higher score.</li>
          <li><code>search.test.ts</code> — covers the case where both sources return the same file.</li>
        </ul>
        <h2>Validation</h2>
        <p>The focused search suite passed: <strong>42 tests</strong>. Typecheck also passed.</p>
        <p>The full end-to-end suite has <strong>not been run</strong>.</p>
        <h2>One tradeoff</h2>
        <p>Deduplication is by path. Two distinct files with identical contents will still appear as separate results.</p>
        <p>You can review the changes in <code>search.ts</code> and <code>search.test.ts</code>.</p>`,
      structured: `
        <h2 class="result-heading">One result per file.</h2>
        <p class="lead">Search results are merged by file path before ranking. The strongest match appears once.</p>
        <span class="section-label">What changed</span>
        <dl class="change-list">
          <div class="change-row"><dt><code>search.ts</code></dt><dd>Merges lexical and semantic matches by path, keeping the higher score.</dd></div>
          <div class="change-row"><dt><code>search.test.ts</code></dt><dd>Covers both sources returning the same file.</dd></div>
        </dl>
        <span class="section-label">Validation</span>
        <div class="checks"><span><b aria-hidden="true">✓</b> 42 search tests passed</span><span><b aria-hidden="true">✓</b> Typecheck passed</span></div>
        <p class="muted">Full end-to-end suite not run.</p>
        <div class="caveat"><strong>One tradeoff</strong>Deduplication is by path. Distinct files with identical contents remain separate results.</div>
        <p class="next-step">Review <code>search.ts</code> and <code>search.test.ts</code>.</p>`,
    },
    {
      id: 'explain',
      title: 'Understand streaming responses',
      prompt: 'How does a response get from the model to the chat panel?',
      activity: '3 modules inspected · no files changed',
      steps: [
        'Read the provider stream adapter',
        'Followed message events into the store',
        'Inspected the markdown render boundary',
      ],
      prose: `
        <p class="lead"><strong>The answer arrives in small chunks.</strong> Each chunk updates the message in the store, and the chat renderer turns the accumulated text into readable markdown.</p>
        <h2>The path through the app</h2>
        <ol>
          <li><strong>Provider:</strong> emits text chunks as the model generates its response.</li>
          <li><strong>Message store:</strong> appends each chunk to the active message.</li>
          <li><strong>Chat renderer:</strong> displays the message and updates markdown as more text arrives.</li>
        </ol>
        <h2>Why it works this way</h2>
        <p>You can start reading before generation finishes. The store remains the source of truth, so reopening the thread can render the saved message.</p>
        <h2>What to watch for</h2>
        <p>A partial code fence or table is not a finished block. The renderer needs to tolerate incomplete markdown while the answer is streaming.</p>
        <p>No files were changed. This is a simplified description of the response path.</p>`,
      structured: `
        <h2 class="result-heading">A response arrives in pieces.</h2>
        <p class="lead">Each chunk updates the stored message. The chat turns the accumulated text into readable markdown.</p>
        <div class="flow" aria-label="Response flow: provider, message store, chat renderer">
          <div class="flow-step"><strong>1. Provider</strong><small>Emits text chunks</small></div><span class="flow-arrow" aria-hidden="true">→</span>
          <div class="flow-step"><strong>2. Message store</strong><small>Appends to the message</small></div><span class="flow-arrow" aria-hidden="true">→</span>
          <div class="flow-step"><strong>3. Chat renderer</strong><small>Updates the markdown</small></div>
        </div>
        <h3>Readable before it is finished</h3>
        <p>You can start reading while the model is still generating. The store remains the source of truth, so reopening the thread can render the saved message.</p>
        <div class="caveat"><strong>Incomplete is a normal state</strong>A partial code fence or table is not a finished block. The renderer must tolerate incomplete markdown during streaming.</div>
        <p class="next-step muted">Simplified response path. No files changed.</p>`,
    },
    {
      id: 'review',
      title: 'Review the cache change',
      prompt: 'Review this cache change. What should I fix before merging?',
      activity: '2 files inspected · no files changed · tests not run',
      steps: [
        'Read cache.ts and cache.test.ts',
        'Compared expiry handling with the caller',
        'Static review only; no tests executed',
      ],
      prose: `
        <p class="lead"><strong>I found one issue to fix before merging and one smaller cleanup.</strong> Both are in <code>cache.ts</code>. This was a static review; I did not run tests or change files.</p>
        <h2>Findings</h2>
        <ol>
          <li><strong>High priority — expired entries can be returned.</strong> <code>cache.ts:48</code> returns the cached value before checking its expiry. A request after the TTL can receive stale data. Check the expiry before returning, then evict an expired entry.</li>
          <li><strong>Low priority — an unused lookup repeats work.</strong> <code>cache.ts:61</code> reads the same key a second time. Reuse the value from the first lookup.</li>
        </ol>
        <h2>Suggested verification</h2>
        <p>Add a test that advances the clock beyond the TTL and verifies that a fresh value is fetched.</p>
        <p>The review is limited to the two inspected files, <code>cache.ts</code> and <code>cache.test.ts</code>.</p>`,
      structured: `
        <h2 class="result-heading">Fix expiry before merging.</h2>
        <p class="lead">One correctness issue and one smaller cleanup in <code>cache.ts</code>.</p>
        <section class="finding"><div class="finding-heading"><span class="severity">High priority</span><h3>Expired entries can be returned</h3></div>
          <p class="muted"><code>cache.ts:48</code></p>
          <p>The cached value is returned before its expiry is checked. A request after the TTL can receive stale data.</p>
          <p><strong>Fix:</strong> Check expiry before returning, then evict an expired entry.</p>
        </section>
        <section class="finding"><div class="finding-heading"><span class="severity low">Low priority</span><h3>Duplicate lookup</h3></div>
          <p class="muted"><code>cache.ts:61</code></p>
          <p>The same key is read twice. Reuse the value from the first lookup.</p>
        </section>
        <div class="caveat"><strong>Suggested verification</strong>Advance the clock beyond the TTL and verify that a fresh value is fetched.</div>
        <p class="next-step muted">Static review of <code>cache.ts</code> and <code>cache.test.ts</code>. No tests run or files changed.</p>`,
    },
  ]
  const views = [
    {
      id: 'baseline',
      description: 'Current-style · wide column, 15px text, 22px line spacing, compact sections.',
      note: 'Static approximation of current chat styling',
    },
    {
      id: 'reading',
      description: 'Reading · same words, a shorter line, 16px text, more space between ideas.',
      note: 'Same answer, clearer typography and spacing',
    },
    {
      id: 'structured',
      description:
        'Structured · an outcome first, then a visual shape suited to the answer: changes, a flow, or findings.',
      note: 'Authored example: structure would need agent or renderer support',
    },
  ]
  const params = new URLSearchParams(location.search)
  let example = examples.find((item) => item.id === params.get('example')) ?? examples[0]
  let view = views.find((item) => item.id === location.hash.slice(1)) ?? views[1]
  const get = (selector) => {
    const element = document.querySelector(selector)
    if (!element) throw new Error(`Missing prototype element: ${selector}`)
    return element
  }
  const answer = get('#answer')
  const transcript = get('.transcript')
  const activity = get('.activity')
  function render(resetScroll) {
    const progress =
      transcript.scrollTop / Math.max(1, transcript.scrollHeight - transcript.clientHeight)
    document.body.dataset.view = view.id
    get('#thread-title').textContent = example.title
    get('#user-message').textContent = example.prompt
    get('#activity-summary').textContent = example.activity
    get('#view-description').textContent = view.description
    get('#presentation-note').textContent = view.note
    const steps = example.steps.map((text) => {
      const item = document.createElement('li')
      item.textContent = text
      return item
    })
    get('#activity-list').replaceChildren(...steps)
    // Only the fixed, authored specimens above reach this sink. No URL or input HTML.
    answer.innerHTML = view.id === 'structured' ? example.structured : example.prose
    document.querySelectorAll('[data-example]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.example === example.id))
    })
    document.querySelectorAll('button[data-view]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.view === view.id))
    })
    if (resetScroll) activity.removeAttribute('open')
    transcript.scrollTop = resetScroll
      ? 0
      : progress * (transcript.scrollHeight - transcript.clientHeight)
    const url = new URL(location.href)
    url.searchParams.set('example', example.id)
    url.hash = view.id
    window.history.replaceState(null, '', url)
  }
  document.querySelectorAll('button[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = views.find((item) => item.id === button.dataset.view)
      if (!next) return
      view = next
      render(false)
    })
  })
  document.querySelectorAll('[data-example]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = examples.find((item) => item.id === button.dataset.example)
      if (!next) return
      example = next
      render(true)
    })
  })
  get('#theme-toggle').addEventListener('click', (event) => {
    const light = document.documentElement.dataset.theme !== 'light'
    document.documentElement.dataset.theme = light ? 'light' : 'dark'
    event.currentTarget.textContent = light ? 'Dark theme' : 'Light theme'
    event.currentTarget.setAttribute('aria-pressed', String(light))
  })
  get('#width-select').addEventListener('change', (event) => {
    document.body.dataset.width = event.currentTarget.value === 'narrow' ? 'narrow' : 'wide'
  })
  window.addEventListener('hashchange', () => {
    view = views.find((item) => item.id === location.hash.slice(1)) ?? views[1]
    render(false)
  })
  render(true)
})()
