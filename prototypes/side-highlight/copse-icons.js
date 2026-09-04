// Extracted from src/renderer/dom/icons.ts — the real registry, not a subset.
// 28 lucide-style outline icons, 24x24 viewBox, stroked in currentColor.
// Regenerate by re-parsing `outlineIcon('name', [paths], …)` out of that file.
globalThis.COPSE_ICONS = [
  { name: 'chevron-right', paths: ['m9 18 6-6-6-6'] },
  { name: 'chevron-down', paths: ['m6 9 6 6 6-6'] },
  { name: 'chevron-up', paths: ['m18 15-6-6-6 6'] },
  { name: 'arrow-left', paths: ['M19 12H5', 'm12 19-7-7 7-7'] },
  { name: 'arrow-right', paths: ['M5 12h14', 'm12 5 7 7-7 7'] },
  { name: 'arrow-down', paths: ['M12 5v14', 'm19 12-7 7-7-7'] },
  {
    name: 'refresh',
    paths: [
      'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
      'M21 3v5h-5',
      'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
      'M8 16H3v5',
    ],
  },
  {
    name: 'external-link',
    paths: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
  },
  { name: 'close', paths: ['M18 6 6 18', 'm6 6 12 12'] },
  { name: 'plus', paths: ['M5 12h14', 'M12 5v14'] },
  {
    name: 'monitor',
    paths: [
      'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
      'M8 21h8',
      'M12 17v4',
    ],
  },
  {
    name: 'download',
    paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  },
  {
    name: 'upload',
    paths: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm17 8-5-5-5 5', 'M12 3v12'],
  },
  { name: 'maximize', paths: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'] },
  { name: 'minimize', paths: ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7'] },
  { name: 'more-horizontal', paths: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'] },
  { name: 'running-status', paths: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'] },
  { name: 'check', paths: ['M20 6 9 17l-5-5'] },
  { name: 'dot', paths: ['M12 12h.01'] },
  { name: 'circle', paths: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'] },
  { name: 'loader-circle', paths: ['M21 12a9 9 0 1 1-6.219-8.56'] },
  { name: 'minus', paths: ['M5 12h14'] },
  {
    name: 'triangle-alert',
    paths: [
      'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z',
      'M12 9v4',
      'M12 17h.01',
    ],
  },
  { name: 'search', paths: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.35-4.35'] },
  {
    name: 'file-text',
    paths: [
      'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z',
      'M14 2v6h6',
      'M8 13h8',
      'M8 17h8',
    ],
  },
  {
    name: 'image',
    paths: [
      'M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8.3',
      'm21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21',
      'M14 19.5 16.5 17a2 2 0 0 1 2.8 0l1.7 1.7',
      'M9 9h.01',
    ],
  },
  {
    name: 'zap',
    paths: [
      'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
    ],
  },
  {
    name: 'git-pull-request',
    paths: [
      'M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
      'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
      'M13 6h3a2 2 0 0 1 2 2v7',
      'M6 9v12',
    ],
  },
]
