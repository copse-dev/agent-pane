import { el } from './helpers.ts'

const RISO_PALETTES = [
  { bg: '#FFF6EC', ink: '#3D3A4B', c: ['#F2A7A0', '#F7D08A', '#9ED2C6'] },
  { bg: '#F4F1FA', ink: '#2F3350', c: ['#B8A9E3', '#F5B8C8', '#A8D8EA'] },
  { bg: '#F3F7F0', ink: '#2E4036', c: ['#A7D3A6', '#F2E394', '#E8A87C'] },
  { bg: '#FDF3F0', ink: '#4A2F35', c: ['#E58F8B', '#F6C28B', '#8FB8DE'] },
  { bg: '#EEF5F7', ink: '#1F3A4A', c: ['#7FC8C2', '#FFD6A5', '#FF9AA2'] },
  { bg: '#FAF6E9', ink: '#39352A', c: ['#C9B6E4', '#BDE0FE', '#FFC8DD'] },
] as const

const DUOTONE_INK_PAIRS = [
  ['#FF48B0', '#0078BF'],
  ['#FFE800', '#FF48B0'],
  ['#00838A', '#FF6C2F'],
  ['#FFB511', '#3255A4'],
  ['#F15060', '#82D8D5'],
  ['#765BA7', '#FFE800'],
] as const
const DUOTONE_PAPER = '#F7F4EE'

type AvatarStyle = 'riso' | 'duotone'
type BlobShape = { cx: number; cy: number; radius: number; d: string; drift: string }
type SeededDrawing = {
  random: () => number
  rand: (min: number, max: number) => number
  shuffle: (values: readonly [string, string, string]) => [string, string, string]
  blob: (cx: number, cy: number, radius: number, amp?: number) => BlobShape
}
const f = (n: number): string => n.toFixed(1)

type Point = readonly [number, number]

// Adapted from the supplied riso-print generator. Each SVG is an isolated image
// document, so local filter/pattern IDs can be stable even for repeated seeds.
function seededDrawing(seed: number): SeededDrawing {
  const TAU = Math.PI * 2
  let state = seed
  const mulberry32 = (): number => {
    let t = (state += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const random = mulberry32
  const rand = (min: number, max: number): number => min + random() * (max - min)
  const shuffle = (values: readonly [string, string, string]): [string, string, string] => {
    const a: [string, string, string] = [...values]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      const current = a[i] ?? values[0]
      a[i] = a[j] ?? values[0]
      a[j] = current
    }
    return a
  }

  // Closed Catmull-Rom curve through the points, written as cubic Beziers.
  const smoothClosed = (pts: Point[]): string => {
    const first = pts[0]
    if (!first) return ''
    const n = pts.length
    let d = `M${f(first[0])} ${f(first[1])}`
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n] ?? first
      const p1 = pts[i] ?? first
      const p2 = pts[(i + 1) % n] ?? first
      const p3 = pts[(i + 2) % n] ?? first
      d +=
        `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ` +
        `${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ` +
        `${f(p2[0])} ${f(p2[1])}`
    }
    return d + 'Z'
  }

  // Seeded blob: a circle wobbled by four sine harmonics.
  // amp > 1 gives a lumpier shape.
  const blob = (cx: number, cy: number, radius: number, amp = 1): BlobShape => {
    const harmonics = [2, 3, 4, 5].map((k, i) => ({
      k,
      a: rand(0, [0.09, 0.06, 0.04, 0.025][i] ?? 0) * amp,
      p: rand(0, TAU),
    }))
    const pts: Point[] = []
    const drift: Point[] = []
    for (let i = 0; i < 40; i++) {
      const th = (i / 40) * TAU
      const r = radius * (1 + harmonics.reduce((s, h) => s + h.a * Math.sin(h.k * th + h.p), 0))
      pts.push([cx + Math.cos(th) * r, cy + Math.sin(th) * r])
      // A second pose from the same harmonics, without consuming random draws:
      // the original silhouette and palette remain identical to the static icon.
      const shifted =
        radius * (1 + harmonics.reduce((s, h) => s + h.a * Math.sin(h.k * th + h.p + 0.45), 0))
      drift.push([cx + 10 + Math.cos(th) * shifted, cy - 8 + Math.sin(th) * shifted])
    }
    return { cx, cy, radius, d: smoothClosed(pts), drift: smoothClosed(drift) }
  }

  return { random, rand, shuffle, blob }
}

// Only internal ink contours move, roughly a pixel at chat size over 16–22 seconds.
// Paper, grain, registration, and the outer silhouette stay fixed. SVG CSS runs in
// the image document, with no per-frame JavaScript or shared inline definition IDs.
function inkMotion(shapes: BlobShape[]): string {
  return `<style>@media (prefers-reduced-motion: no-preference) {
    ${shapes
      .map(
        (shape, i) => `
      .ink-${String(i)} { animation: ink-${String(i)} ${String(16 + i * 3)}s ease-in-out infinite; }
      @keyframes ink-${String(i)} {
        0%, 100% { d: path("${shape.d}"); }
        50% { d: path("${shape.drift}"); }
      }`,
      )
      .join('')}
  }</style>`
}

function risoIconSVG(seed: number, moving = false): string {
  const { random, rand, shuffle, blob } = seededDrawing(seed)
  const id = 'riso'
  const pal = RISO_PALETTES[Math.floor(random() * RISO_PALETTES.length)] ?? RISO_PALETTES[0]
  const [base, overlay, shadow] = shuffle(pal.c)

  // Main silhouette, then three inner shapes: overprint, halftone patch, paper hole.
  const main = blob(256 + rand(-8, 8), 258 + rand(-8, 8), rand(165, 188))
  const overprint = blob(
    main.cx + rand(-60, 60),
    main.cy + rand(-60, 60),
    main.radius * rand(0.55, 0.75),
    1.6,
  )
  const halftone = blob(
    main.cx + rand(-70, 70),
    main.cy + rand(-70, 70),
    main.radius * rand(0.45, 0.65),
    1.8,
  )
  const hole = blob(
    main.cx + rand(-50, 50),
    main.cy + rand(-50, 50),
    main.radius * rand(0.18, 0.3),
    1.2,
  )

  const dotRadius = rand(2.2, 3.6)
  const dotPitch = rand(9, 12)
  const screenAngle = rand(10, 75)
  const shadowX = rand(6, 12)
  const shadowY = rand(5, 11)
  const outlineX = rand(-5, -2)
  const outlineY = rand(-4, -1)

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
      <defs>
        ${moving ? inkMotion([overprint, halftone, hole]) : ''}
        <clipPath id="${id}-clip">
          <path d="${main.d}"/>
        </clipPath>

        <pattern id="${id}-dots" width="${f(dotPitch)}" height="${f(dotPitch)}"
                 patternUnits="userSpaceOnUse" patternTransform="rotate(${f(screenAngle)})">
          <circle cx="${f(dotPitch / 2)}" cy="${f(dotPitch / 2)}" r="${f(dotRadius)}"
                  fill="${pal.ink}" opacity=".55"/>
        </pattern>

        <filter id="${id}-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="${String(seed % 10000)}"/>
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  .22 0 0 0 0"/>
        </filter>
      </defs>

      <rect width="512" height="512" fill="${pal.bg}"/>

      <!-- Offset shadow in the third ink -->
      <path d="${main.d}" fill="${shadow}"
            transform="translate(${f(shadowX)} ${f(shadowY)})"
            style="mix-blend-mode:multiply"/>

      <g clip-path="url(#${id}-clip)">
        <rect width="512" height="512" fill="${base}"/>
        <path class="ink-0" d="${overprint.d}" fill="${overlay}" style="mix-blend-mode:multiply"/>
        <path class="ink-1" d="${halftone.d}" fill="url(#${id}-dots)"/>
        <path class="ink-2" d="${hole.d}" fill="${pal.bg}"/>
      </g>

      <!-- Outline printed slightly off register -->
      <path d="${main.d}" fill="none" stroke="${pal.ink}" stroke-width="5"
            stroke-linejoin="round" transform="translate(${f(outlineX)} ${f(outlineY)})"/>

      <!-- Paper grain over everything -->
      <rect width="512" height="512" filter="url(#${id}-grain)" style="mix-blend-mode:multiply"/>
    </svg>
  `
}

function duotoneIconSVG(seed: number, moving = false): string {
  const { random, rand, blob } = seededDrawing(seed)
  const id = 'duo'
  const pair =
    DUOTONE_INK_PAIRS[Math.floor(random() * DUOTONE_INK_PAIRS.length)] ?? DUOTONE_INK_PAIRS[0]
  // The two-item Fisher–Yates shuffle consumes one draw, just like the supplied generator.
  const [firstInk, secondInk] = random() < 0.5 ? [pair[1], pair[0]] : pair

  // Main silhouette in the first ink, an overprint in the second ink
  // (clipped to the main shape), and a striped patch that can spill past the edge.
  const main = blob(256 + rand(-8, 8), 258 + rand(-8, 8), rand(165, 188))
  const overprint = blob(
    main.cx + rand(-55, 55),
    main.cy + rand(-55, 55),
    main.radius * rand(0.6, 0.8),
    1.6,
  )
  const stripes = blob(
    main.cx + rand(-60, 60),
    main.cy + rand(-60, 60),
    main.radius * rand(0.3, 0.45),
    1.4,
  )

  const linePitch = rand(7, 10)
  const lineAngle = rand(20, 70)
  const registerX = rand(3, 7)
  const registerY = rand(2, 6)

  return `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <defs>
      ${moving ? inkMotion([overprint, stripes]) : ''}
      <clipPath id="${id}-clip"><path d="${main.d}"/></clipPath>
      <pattern id="${id}-lines" width="${f(linePitch)}" height="${f(linePitch)}"
               patternUnits="userSpaceOnUse" patternTransform="rotate(${f(lineAngle)})">
        <rect width="${f(linePitch)}" height="${f(linePitch * 0.42)}" fill="${secondInk}"/>
      </pattern>
      <filter id="${id}-grain" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="${String(seed % 10000)}"/>
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  .3 0 0 0 0"/>
      </filter>
    </defs>

    <rect width="512" height="512" fill="${DUOTONE_PAPER}"/>

    <!-- First ink -->
    <path d="${main.d}" fill="${firstInk}" opacity=".88"/>

    <!-- Second ink, slightly off register; multiply makes the overlap colour -->
    <g clip-path="url(#${id}-clip)" style="mix-blend-mode:multiply">
      <path class="ink-0" d="${overprint.d}" fill="${secondInk}" opacity=".85"
            transform="translate(${f(registerX)} ${f(registerY)})"/>
    </g>

    <!-- Striped patch in the second ink -->
    <path class="ink-1" d="${stripes.d}" fill="url(#${id}-lines)" style="mix-blend-mode:multiply"/>

    <!-- Heavier grain than the pastel version, to read as ink on paper -->
    <rect width="512" height="512" filter="url(#${id}-grain)" style="mix-blend-mode:multiply"/>
  </svg>`
}

// Bound memory in long-lived windows; cache by identity and style to share decoded images
// across messages. No random state or new persistence field is needed.
interface AvatarSources {
  still: string
  moving?: string
  animate: () => string
}
const sources = new Map<string, AvatarSources>()
const imageSources = new WeakMap<HTMLImageElement, AvatarSources>()
const MAX_CACHED_AVATARS = 128

export function createAgentAvatar(identity: string, style: AvatarStyle = 'riso'): HTMLImageElement {
  const cacheKey = `${style}:${identity}`
  let source = sources.get(cacheKey)
  if (!source) {
    // FNV-1a turns persisted thread/session IDs into stable unsigned seeds.
    let seed = 0x811c9dc5
    for (let i = 0; i < identity.length; i++) {
      seed = Math.imul(seed ^ identity.charCodeAt(i), 0x01000193) >>> 0
    }
    const generate = (moving: boolean): string =>
      `data:image/svg+xml,${encodeURIComponent(style === 'duotone' ? duotoneIconSVG(seed, moving) : risoIconSVG(seed, moving))}`
    source = { still: generate(false), animate: (): string => generate(true) }
    const oldest = sources.keys().next().value
    if (sources.size >= MAX_CACHED_AVATARS && oldest !== undefined) sources.delete(oldest)
    sources.set(cacheKey, source)
  }
  // Names and status remain text next to the decorative image. No agent- or
  // user-authored strings are interpolated into SVG markup.
  const img = el('img', {
    class: 'agent-avatar',
    'data-avatar-style': style,
    src: source.still,
    alt: '',
    'aria-hidden': 'true',
    draggable: 'false',
  })
  imageSources.set(img, source)
  return img
}

function setMoving(img: HTMLImageElement, moving: boolean): void {
  const source = imageSources.get(img)
  if (!source) return
  if (moving) source.moving ??= source.animate()
  const src = moving ? (source.moving ?? source.still) : source.still
  if (img.src !== src) img.src = src
  img.toggleAttribute('data-avatar-animating', moving)
}

/** One active identity per conversation; no work for hidden or historical icons. */
export function createAgentAvatarMotion(): {
  setActive: (img: HTMLImageElement | null) => void
  dispose: () => void
} {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let active: HTMLImageElement | null = null
  let visible = false
  const sync = (): void => {
    if (active) setMoving(active, visible && !document.hidden && !reducedMotion.matches)
  }
  const observer = new window.IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === active) visible = entry.isIntersecting
    }
    sync()
  })
  const setActive = (img: HTMLImageElement | null): void => {
    // Streaming tokens and settings refreshes must not restart the animation.
    if (active === img) return
    if (active) {
      observer.unobserve(active)
      setMoving(active, false)
      active.removeAttribute('data-avatar-active')
    }
    active = img
    visible = false
    if (active) {
      active.setAttribute('data-avatar-active', '')
      observer.observe(active)
    }
  }
  reducedMotion.addEventListener('change', sync)
  document.addEventListener('visibilitychange', sync)
  return {
    setActive,
    dispose: (): void => {
      setActive(null)
      observer.disconnect()
      reducedMotion.removeEventListener('change', sync)
      document.removeEventListener('visibilitychange', sync)
    },
  }
}
