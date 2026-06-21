export function renderMermaidFallback(container: HTMLElement, source: string): void {
  container.classList.remove('mermaid-diagram--pending', 'mermaid-diagram--folded')
  container.dataset.mermaidUi = 'true'
  container.removeAttribute('role')
  container.removeAttribute('tabindex')
  container.removeAttribute('aria-label')

  const title = document.createElement('p')
  title.className = 'mermaid-fallback-title'
  title.textContent = 'Diagram could not be rendered'

  const hint = document.createElement('p')
  hint.className = 'mermaid-fallback-hint'
  hint.textContent = 'The Mermaid source may use syntax this version does not accept.'

  const details = document.createElement('details')
  details.className = 'mermaid-fallback-source'
  const summary = document.createElement('summary')
  summary.textContent = 'View diagram source'
  const pre = document.createElement('pre')
  pre.textContent = source
  details.append(summary, pre)

  container.replaceChildren(title, hint, details)
}
