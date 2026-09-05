// Treatment switcher. Each option is a body class; the two "Compare" buttons
// clone the stage into scoped columns so specimens can be read side by side.
const LINE = ['current', 'a', 'b', 'c']
const MATERIAL = ['current', 'd', 'e', 'j']
const QUIET = ['current', 'g', 'h', 'i']
const MIX = ['current', 'b', 'h', 'm']
const LABELS = {
  current: 'Today',
  m: 'M · The mix',
  a: 'A · Label line',
  b: 'B · Quiet plate',
  c: 'C · Gutter',
  d: 'D · Lifted',
  e: 'E · Well',
  j: 'J · Soft',
  g: 'G · Ring',
  h: 'H · Hatch',
  i: 'I · Margin',
}
const BLURB = {
  current:
    'Every one of these blocks marks itself with a slim bar on one inline edge. In a single message ' +
    'the alert, the quote and the review card each draw their own, so the column gains three ' +
    'competing left edges and the prose is pushed off its measure three times.',
  a:
    '<b>A — Label line.</b> The bar becomes a label on a hairline rule that runs <em>with</em> the text. ' +
    'Nothing is boxed, nothing is indented, and the severity hue is spent on the one word that carries ' +
    'it. Stacked callouts read as sections of one document rather than three pasted-in cards.',
  b:
    '<b>B — Quiet plate.</b> Containment with no direction: a flat 9% wash of the severity hue, small ' +
    'radius, no border. A plate has no leading edge, so nothing can bow around a corner — but it does ' +
    'add a visible block to a dense transcript.',
  c:
    '<b>C — Gutter.</b> The marker moves off the edge into a fixed 24px icon column, so every block ' +
    'kind starts its text at the same inset and stacked callouts align. The sidebar reuses the 28px ' +
    'status gutter it already reserves: a selected row gets an accent pip instead of an edge rail.',
  d:
    '<b>D — Lifted.</b> The block is a leaf raised a hair off the transcript: no border and no rail, ' +
    'just a soft drop shadow and a 1px inner top highlight, lit from above like <code>.pane-chat</code>. ' +
    'Containment comes from the material, so severity is free to live in the icon and title alone.',
  e:
    '<b>E — Well.</b> The inverse: the block is pressed <em>into</em> the surface with an inset shadow ' +
    'and a highlight along its lower lip. Recessed reads as subordinate without any hue at all, which ' +
    'is semantically right for a quote, a thinking block, or technical details.',
  j:
    '<b>J — Soft.</b> The chat pane technique with the colour taken out: the surface gets lighter ' +
    'where the title is, then dissolves into the page over a long falloff. No border, no shadow, no ' +
    'hue. This is what F should have been — F tinted the falloff with the severity hue and it read ' +
    'as a smudge rather than a light.',
  g:
    '<b>G — Ring.</b> A hairline all the way round in a low-alpha severity hue, nothing filled. A ring ' +
    'has no leading edge, so it follows a radius evenly on all four corners and the whole ' +
    '&ldquo;rails never curve&rdquo; problem stops existing. Cheapest containment of the set.',
  h:
    '<b>H — Hatch.</b> A texture rather than a tint: a 1px diagonal hatch at very low alpha, so the ' +
    'block reads as a different material without becoming a solid coloured slab. Density stays ' +
    'constant, so a tall callout weighs no more than a short one — which a flat wash cannot claim.',
  i:
    '<b>I — Margin.</b> No graphic at all. The kind of block is named in a fixed left column, ' +
    'right-aligned so every label ends where the body begins. Stacked callouts share one column and ' +
    'line up, and the body keeps a single unbroken measure however many blocks precede it.',
  m:
    '<b>M — The mix.</b> Split by what each block <em>is</em>, not by what it looks like. Alerts and ' +
    'blockquotes are prose the agent wrote, so they take B&rsquo;s flat plate. Thinking, review and ' +
    'comparison are Copse annotating its own turn, so they take H&rsquo;s hatch — same box, different ' +
    'material. VNC takes C&rsquo;s gutter. Tool rollups keep today&rsquo;s guide line, which is ' +
    'structure rather than decoration. Selection is the fill alone everywhere.',
  split: 'Line-based treatments: today, against A, B and C.',
  material: 'Depth and light — shadow, recess and falloff, in the manner of the chat pane.',
  quiet: 'Low-ink treatments: an outline, a texture, and no graphic at all.',
  mix: 'The mix and its two ingredients: B for content, H for commentary.',
}
const COLUMNS = { split: LINE, material: MATERIAL, quiet: QUIET, mix: MIX }

const stage = document.getElementById('stage')
const blurb = document.getElementById('blurb')
const pristine = stage.cloneNode(true)

function apply(opt) {
  for (const button of document.querySelectorAll('.sw')) {
    button.setAttribute('aria-pressed', String(button.dataset.opt === opt))
  }
  blurb.innerHTML = BLURB[opt]
  document.body.className = ''
  stage.replaceChildren(...pristine.cloneNode(true).childNodes)

  const columns = COLUMNS[opt]
  if (!columns) {
    document.body.className = `opt-${opt}`
    stage.className = ''
    return
  }
  stage.className = 'split-grid'
  stage.replaceChildren(
    ...columns.map((option) => {
      const column = document.createElement('div')
      column.className = `split-col opt-${option}`
      const heading = document.createElement('h3')
      heading.textContent = LABELS[option]
      column.append(heading, ...pristine.cloneNode(true).childNodes)
      return column
    }),
  )
}

/* ---------------------------------------------------------------------------
   The Copse icon set, rendered from the real registry.

   Lives outside the treatment stage so it is not re-cloned on every switch.
-------------------------------------------------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Fill every gallery on the page and wire its own controls.
 *
 * Has to run *after* each `apply()`: the stage is restored from a clone taken
 * before this ever ran, so anything rendered once at startup is wiped by the
 * first treatment switch. Selection is by class, not id, because compare views
 * put four copies of the stage on the page at the same time.
 */
function renderGalleries() {
  if (!globalThis.COPSE_ICONS) return
  for (const host of document.querySelectorAll('.icon-gallery')) {
    if (host.dataset.filled) continue
    host.dataset.filled = '1'
    host.replaceChildren(
      ...globalThis.COPSE_ICONS.map(({ name, paths }) => {
        const cell = document.createElement('figure')
        cell.className = 'gallery-cell'
        const svg = document.createElementNS(SVG_NS, 'svg')
        svg.setAttribute('viewBox', '0 0 24 24')
        svg.setAttribute('aria-hidden', 'true')
        for (const d of paths) {
          const path = document.createElementNS(SVG_NS, 'path')
          path.setAttribute('d', d)
          svg.append(path)
        }
        const caption = document.createElement('figcaption')
        caption.textContent = name
        cell.append(svg, caption)
        return cell
      }),
    )
  }

  for (const button of document.querySelectorAll('[data-gallery]')) {
    if (button.dataset.wired) continue
    button.dataset.wired = '1'
    button.addEventListener('click', () => {
      const gallery = button.closest('.spec')?.querySelector('.icon-gallery')
      if (!gallery) return
      const on = gallery.classList.toggle(button.dataset.gallery)
      button.setAttribute('aria-pressed', String(on))
      button.textContent = on ? button.dataset.on : button.dataset.off
    })
  }
}

/* ---------------------------------------------------------------------------
   Optical centring, measured rather than eyeballed.

   A glyph's bounding box tells you nothing about where it *looks* like it sits.
   A triangle carries two thirds of its area in the bottom half, so a
   box-centred triangle reads low; a lightbulb and a speech bubble carry theirs
   at the top, so both read high. The honest measure is the ink's centre of
   mass, so rasterise each glyph and take the alpha-weighted centroid.

   Every solid icon is then translated so that centroid lands on the box
   centre, which makes five different silhouettes sit on one optical line. The
   align strip is excluded so it keeps showing the uncorrected truth.
-------------------------------------------------------------------------- */

const centroids = new Map()

async function inkCentroid(svg) {
  // Paint comes from CSS, which does not survive serialisation, so read it off
  // the live element. `.ico-thin` and `.ico-bold` share their path data and
  // differ only in stroke width, so the key has to carry the paint too.
  const style = getComputedStyle(svg)
  const solid = style.fill !== 'none'
  const width = Number.parseFloat(style.strokeWidth) || 1.4
  const key = `${solid ? 'f' : 's'}${width}|${svg.innerHTML}`
  if (centroids.has(key)) return centroids.get(key)

  const clone = svg.cloneNode(true)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', '128')
  clone.setAttribute('height', '128')
  clone.setAttribute('fill', solid ? '#000' : 'none')
  clone.setAttribute('stroke', solid ? 'none' : '#000')
  clone.setAttribute('stroke-width', String(width))
  clone.setAttribute('stroke-linecap', 'round')
  clone.setAttribute('stroke-linejoin', 'round')
  // `.fill` marks a filled counter inside an otherwise stroked glyph.
  for (const node of clone.querySelectorAll('.fill')) {
    node.setAttribute('fill', '#000')
    node.setAttribute('stroke', 'none')
  }
  const source = new XMLSerializer().serializeToString(clone)
  const image = new Image()
  const loaded = new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = reject
  })
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  try {
    await loaded
  } catch {
    return null
  }

  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0, size, size)
  const { data } = context.getImageData(0, 0, size, size)

  let weight = 0
  let sumX = 0
  let sumY = 0
  const box = { top: size, bottom: 0, left: size, right: 0 }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = data[(y * size + x) * 4 + 3]
      if (!alpha) continue
      weight += alpha
      sumX += alpha * (x + 0.5)
      sumY += alpha * (y + 0.5)
      if (y < box.top) box.top = y
      if (y > box.bottom) box.bottom = y
      if (x < box.left) box.left = x
      if (x > box.right) box.right = x
    }
  }
  // Back into viewBox units so the numbers are readable against the paths.
  const u = (value) => (value / size) * 16
  const result = weight
    ? {
        x: u(sumX / weight),
        y: u(sumY / weight),
        box: { top: u(box.top), bottom: u(box.bottom), left: u(box.left), right: u(box.right) },
      }
    : null
  centroids.set(key, result)
  return result
}

/**
 * How much of the centroid error to actually take out.
 *
 * Correcting a triangle *fully* would drive its apex through the top of the
 * box: two thirds of its area sits in the bottom half, so its centroid is
 * ~1.5u low, and moving that onto centre leaves a third of the box empty
 * underneath. Icon families damp the correction instead — take out enough that
 * the glyph stops reading low, not so much that the silhouette looks shoved.
 */
const DAMPING = 0.62
/** Ink may not come closer than this to the edge of the box. */
const EDGE = 0.35

/**
 * Damped, clamped translation that puts a glyph on the optical line.
 *
 * Vertical only, deliberately. These icons sit in left-aligned icon+label rows
 * where the glyph's horizontal position comes from its fixed-width box, and
 * every row shares that box. Nudging horizontally by centroid would move only
 * the glyphs with asymmetric ink — `Important` is the one here, because its
 * tail hangs left of centre — and that one glyph would then sit proud of the
 * icon column that Tip, Warning and the rest line up in.
 */
function correction(measure) {
  const dy = (8 - measure.y) * DAMPING
  return {
    dx: 0,
    dy: Math.min(Math.max(dy, EDGE - measure.box.top), 16 - EDGE - measure.box.bottom),
  }
}

async function balanceIcons() {
  // Every icon in the workshop, not just the solid ones: leaving the outline
  // columns uncorrected would compare weight *and* centring at once, and the
  // rows would go ragged across the table.
  for (const svg of document.querySelectorAll('.ico-solid, .ico-big, .ico-thin, .ico-bold')) {
    const measure = await inkCentroid(svg)
    if (!measure) continue
    const { dx, dy } = correction(measure)

    if (svg.classList.contains('ico-big')) {
      // Diagnostic strip: leave the glyph where it is and mark what was found,
      // so the strip keeps showing the uncorrected truth.
      const cell = svg.closest('.align-cell')
      if (!cell || cell.querySelector('.align-dot')) continue
      const dot = document.createElement('span')
      dot.className = 'align-dot'
      dot.style.left = `${(measure.x / 16) * 100}%`
      dot.style.top = `${(measure.y / 16) * 100}%`
      cell.append(dot)
      const read = document.createElement('span')
      read.className = 'align-read'
      const off = measure.y - 8
      const w = measure.box.right - measure.box.left
      const h = measure.box.bottom - measure.box.top
      read.innerHTML =
        `${off > 0 ? '+' : ''}${off.toFixed(2)} → ${dy > 0 ? '+' : ''}${dy.toFixed(2)}` +
        `<br><b>${w.toFixed(1)}×${h.toFixed(1)}</b>`
      cell.append(read)
      continue
    }

    if (svg.dataset.balanced) continue
    svg.dataset.balanced = '1'
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute('transform', `translate(${dx.toFixed(3)} ${dy.toFixed(3)})`)
    group.append(...svg.childNodes)
    svg.append(group)
  }
}

for (const button of document.querySelectorAll('.sw')) {
  button.addEventListener('click', () => {
    location.hash = button.dataset.opt
  })
}
// The hash drives the view so any treatment is directly linkable (and directly
// screenshottable) rather than only reachable by clicking.
const fromHash = () => {
  const wanted = location.hash.slice(1)
  apply(wanted in BLURB ? wanted : 'current')
  // ?at=<n> scrolls straight to the nth specimen, so any part of any treatment
  // is a single URL rather than a scroll away.
  const at = new URLSearchParams(location.search).get('at')
  renderGalleries()
  if (at) document.querySelectorAll('.spec')[Number(at)]?.scrollIntoView()
  void balanceIcons()
}
addEventListener('hashchange', fromHash)
fromHash()
