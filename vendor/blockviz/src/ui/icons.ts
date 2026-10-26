/**
 * Inline replacements for the lucide-react icons this app used, extracted
 * from lucide-react 1.55.0's own icon data (ISC license) so the app no
 * longer depends on React to draw them. Same markup lucide's own Icon
 * component builds: 24x24 viewBox, 2px round stroke, currentColor.
 */
type IconNode = readonly (readonly [string, Record<string, string>])[];

function buildIcon(node: IconNode, size: number): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of node) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'key') continue;
      el.setAttribute(key, value);
    }
    svg.append(el);
  }
  return svg;
}

const ICONS = {
  arrowLeft: [
    ['path', { d: 'm12 19-7-7 7-7' }],
    ['path', { d: 'M19 12H5' }],
  ],
  arrowRight: [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'm12 5 7 7-7 7' }],
  ],
  arrowUpRight: [
    ['path', { d: 'M7 7h10v10' }],
    ['path', { d: 'M7 17 17 7' }],
  ],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  chevronLeft: [['path', { d: 'm15 18-6-6 6-6' }]],
  chevronRight: [['path', { d: 'm9 18 6-6-6-6' }]],
  download: [
    ['path', { d: 'M12 15V3' }],
    ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ['path', { d: 'm7 10 5 5 5-5' }],
  ],
  externalLink: [
    ['path', { d: 'M15 3h6v6' }],
    ['path', { d: 'M10 14 21 3' }],
    ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
  ],
  fileCode: [
    [
      'path',
      {
        d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
      },
    ],
    ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
    ['path', { d: 'M10 12.5 8 15l2 2.5' }],
    ['path', { d: 'm14 12.5 2 2.5-2 2.5' }],
  ],
  folderOpen: [
    [
      'path',
      {
        d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
      },
    ],
  ],
  gitPullRequest: [
    ['circle', { cx: '18', cy: '18', r: '3' }],
    ['circle', { cx: '6', cy: '6', r: '3' }],
    ['path', { d: 'M13 6h3a2 2 0 0 1 2 2v7' }],
    ['line', { x1: '6', x2: '6', y1: '9', y2: '21' }],
  ],
  home: [
    ['path', { d: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8' }],
    [
      'path',
      {
        d: 'M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
      },
    ],
  ],
  info: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M12 16v-4' }],
    ['path', { d: 'M12 8h.01' }],
  ],
  link: [
    ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }],
  ],
  link2: [
    ['path', { d: 'M9 17H7A5 5 0 0 1 7 7h2' }],
    ['path', { d: 'M15 7h2a5 5 0 1 1 0 10h-2' }],
    ['line', { x1: '8', x2: '16', y1: '12', y2: '12' }],
  ],
  maximize: [
    ['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }],
    ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }],
    ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }],
    ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }],
  ],
  maximize2: [
    ['path', { d: 'M15 3h6v6' }],
    ['path', { d: 'm21 3-7 7' }],
    ['path', { d: 'm3 21 7-7' }],
    ['path', { d: 'M9 21H3v-6' }],
  ],
  minus: [['path', { d: 'M5 12h14' }]],
  moon: [
    [
      'path',
      {
        d: 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401',
      },
    ],
  ],
  plus: [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'M12 5v14' }],
  ],
  search: [
    ['path', { d: 'm21 21-4.34-4.34' }],
    ['circle', { cx: '11', cy: '11', r: '8' }],
  ],
  sparkles: [
    [
      'path',
      {
        d: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z',
      },
    ],
    ['path', { d: 'M20 2v4' }],
    ['path', { d: 'M22 4h-4' }],
    ['circle', { cx: '4', cy: '20', r: '2' }],
  ],
  split: [
    ['path', { d: 'M16 3h5v5' }],
    ['path', { d: 'M8 3H3v5' }],
    ['path', { d: 'M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3' }],
    ['path', { d: 'm15 9 6-6' }],
  ],
  sun: [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M12 2v2' }],
    ['path', { d: 'M12 20v2' }],
    ['path', { d: 'm4.93 4.93 1.41 1.41' }],
    ['path', { d: 'm17.66 17.66 1.41 1.41' }],
    ['path', { d: 'M2 12h2' }],
    ['path', { d: 'M20 12h2' }],
    ['path', { d: 'm6.34 17.66-1.41 1.41' }],
    ['path', { d: 'm19.07 4.93-1.41 1.41' }],
  ],
  x: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
} as const satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

/** One of this app's inlined icons, `size`×`size` (lucide's own default is 24). */
export function icon(name: IconName, size = 24): SVGSVGElement {
  return buildIcon(ICONS[name], size);
}
