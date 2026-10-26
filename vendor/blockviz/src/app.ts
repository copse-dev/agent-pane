import { Analyzer } from './core/analyzer';
import {
  droppedProject,
  embeddedProject,
  exampleProject,
  folderProject,
  githubComparison,
  githubProject,
  isComparison,
  MAX_FILES,
  MAX_TOTAL,
  parseGitHub,
  pastedProject,
  type Progress,
} from './core/loaders';
import type { Comparison, Project, Scene } from './core/types';
import { SceneDiff } from './canvas/diff';
import { Engine, type EdgeRef, type ViewState } from './canvas/engine';
import { blockSvg } from './canvas/svg';
import { traceValue } from './canvas/trace';
import { mountValuePanel, type ValuePanelHandle } from './ui/ValuePanel';
import type { Insets } from './canvas/geometry';
import { SceneModel } from './canvas/model';
import { drawnIn, type Paint } from './canvas/renderer';
import { DARK, legend, LIGHT, swatch, withChromeColors, type ChromeColors, type Theme } from './canvas/theme';
import {
  blockName,
  mountChangesPanel,
  mountRemovedDetails,
  type ChangesPanelHandle,
  type RemovedDetailsHandle,
} from './ui/ChangesPanel';
import { Highlights } from './core/highlights';
import { clampPanel, DEFAULT_PANEL, mountInspector, type InspectorHandle, type PanelSize } from './ui/Inspector';
import { mountOpenDialog, type OpenDialogHandle, type OpenRequest } from './ui/OpenDialog';
import { mountSearch, type SearchHandle } from './ui/Search';
import { mountBreadcrumbs, type BreadcrumbsHandle, type Crumb } from './ui/Breadcrumbs';
import { hashParam, hashParams, Navigation, pushProject } from './ui/navigation';
import { NARROW } from './ui/media';
import { isDark, setEmbeddedDark, subscribe as subscribeScheme, toggleScheme } from './ui/scheme';
import { Store } from './ui/store';
import { el, clear } from './ui/dom';
import { icon } from './ui/icons';

/** A change being read: both versions of the code and how the head (on screen) differs from the base. */
interface Compared {
  comparison: Comparison;
  base: SceneModel;
  baseHighlights: Highlights;
  diff: SceneDiff;
}

interface Loaded {
  project: Project;
  scene: Scene;
  model: SceneModel;
  highlights: Highlights;
  elapsed: number;
  compare?: Compared;
}

/** A GitHub link's code: a repository, or both versions of a pull request or comparison. */
function fromGitHub(url: string, progress: Progress, signal: AbortSignal, latest = false): Promise<Project | Comparison> {
  return isComparison(parseGitHub(url)) ? githubComparison(url, progress, { latest, signal }) : githubProject(url, progress, { latest, signal });
}

/** What a large project's limits left out, said briefly (null: nothing). */
function partial(p: Project): string | null {
  const left = p.leftOut;
  if (!left) return null;
  const n = (k: number): string => k.toLocaleString();
  return [
    left.files ? `${n(p.files.length)} of ${n(p.files.length + left.files)} files` : '',
    left.texts ? `${n(left.texts)} without code` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const LIMITS = `${MAX_FILES.toLocaleString()} files and ${MAX_TOTAL / 1e6} MB of text`;

/** Saves `blob` as a file called `name`. */
function download(blob: Blob | null, name: string): void {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Saves an SVG, named for what it shows. */
function downloadSvg(svg: string, title: string): void {
  const name = title.replace(/[\\/:*?"<>|\0-\x1f]+/g, '-').trim().slice(0, 80) || 'diagram';
  download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
}

/** Saves block `id` alone as SVG, named as the panels name it. */
function downloadBlock(model: SceneModel, id: number, theme: Theme, paint: Pick<Paint, 'diff' | 'trace'> = {}): void {
  const n = model.node(id);
  downloadSvg(blockSvg(model, id, theme, paint), n.title ? model.qualified(id) : blockName(model, n));
}

const storage = {
  get(key: string): string {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* optional */
    }
  },
};

/** Screen margins covered by the top bar, footer and (when open) the details panel. */
function overlayInsets(panelOpen: boolean, panel: PanelSize): Insets {
  const narrow = window.matchMedia(NARROW).matches;
  return {
    top: narrow ? 100 : 56,
    right: panelOpen && !narrow ? panel.w + 24 : 12,
    bottom: panelOpen && narrow ? (panel.h || window.innerHeight * 0.46) + 24 : 52,
    left: 12,
  };
}

export function mountApp(root: HTMLElement): () => void {
  // ---- state ----
  let loaded: Loaded | null = null;
  let busy: string | null = 'Starting…';
  let error: string | null = null;
  let view: ViewState = { path: [] };
  let selected: number | null = null;
  let selectedPath: number[] | null = null;
  let dialog: 'open' | 'search' | null = null;
  let showLegend = false;
  let dragging = false;
  /** A value being followed (an edge clicked). */
  let value: EdgeRef | null = null;
  /** Reading a change: the list of its changes is open (when nothing else is in the panel). */
  let changesOpen = true;
  /** Reading a change: a block it removed (a base block), shown in the panel. */
  let removedSel: number | null = null;
  /** The block under the pointer: a store, so that only the code lines it tints update. */
  const hover = new Store<number | null>(null);
  /** The details panel's size as the reader chose it (remembered), and as it fits this window. */
  let panel: PanelSize = {
    w: Number(storage.get('blockviz.panel.w')) || DEFAULT_PANEL.w,
    h: Number(storage.get('blockviz.panel.h')) || 0,
  };
  let steps = { back: false, forward: false };
  /** Layout style of the diagram on screen, and of the next one loaded: each
   * block's values on one branching line (off: a line per value). */
  let trunks = storage.get('blockviz.trunks') === '1';
  let copied = false;
  let panelSizeTimer: ReturnType<typeof setTimeout> | null = null;

  const analyzer = new Analyzer();
  /** The load in progress: a new one, or leaving, stops it. */
  let loadingController: AbortController | null = null;
  let engine: Engine | null = null;
  let nav: Navigation | null = null;
  /** The hash's `github` value when the current engine was built. */
  let engineRepo: string | undefined;
  /** Shown inside a Copse panel (code-map-pane.ts), which already labels the
   * panel and owns the theme choice — so this page's own wordmark and theme
   * toggle would be redundant chrome. */
  const embedded = hashParam('embedded') === '1';
  // Copse's own pane-header (code-map-pane.ts) already carries a title and an
  // expand control, and its own panel chrome is the discoverable surface — so
  // this page's floating topbar (brand/history/breadcrumbs) and toolbar
  // (search/copy/open/download) would just be a second, redundant header row.
  // Keyboard access (Alt+←/→, '/', f/h/+/-) keeps working regardless; only the
  // host's bridged search button (below) replaces the visible affordance.
  if (embedded) document.documentElement.classList.add('is-embedded');

  function fitted(): PanelSize {
    return clampPanel(panel);
  }

  // ---- DOM skeleton ----
  const main = el('main', { class: 'app' });
  root.append(main);

  const canvas = el('canvas', {
    tabindex: '0',
    'aria-label': 'Code diagram. Scroll or pinch to zoom, drag to pan, double-click a block to zoom into it, press / to search.',
  }) as HTMLCanvasElement;

  main.addEventListener('dragover', (e) => {
    e.preventDefault();
    dragging = true;
    render();
  });
  main.addEventListener('dragleave', (e) => {
    if (e.currentTarget === e.target) {
      dragging = false;
      render();
    }
  });
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    dragging = false;
    render();
    const items = e.dataTransfer?.items;
    if (items?.length) {
      pushProject(nav, location.pathname + location.search);
      void load((p) => droppedProject(items, p));
    }
  });

  // Topbar
  const brandBtn = el(
    'button',
    { class: 'brand', title: 'Whole project (H)', 'aria-label': 'blockviz: whole project' },
    el('span', { class: 'logo', 'aria-hidden': 'true' }, el('i', {}), el('i', {}), el('i', {})),
    ...(embedded ? [] : [el('span', { class: 'brand-name' }, 'blockviz')]),
  );
  brandBtn.addEventListener('click', () => engine?.home());

  const backBtn = el('button', { class: 'icon', 'aria-label': 'Back', title: 'Back (Alt+←)' }, icon('arrowLeft', 15)) as HTMLButtonElement;
  backBtn.addEventListener('click', () => history.back());
  const forwardBtn = el('button', { class: 'icon', 'aria-label': 'Forward', title: 'Forward (Alt+→)' }, icon('arrowRight', 15)) as HTMLButtonElement;
  forwardBtn.addEventListener('click', () => history.forward());
  const historySpan = el('span', { class: 'history' }, backBtn, forwardBtn);

  const crumbRoot = el('span', { class: 'crumb-root' });
  const tagline = el('span', { class: 'tagline' });
  const crumbsHost = el('div');
  let breadcrumbs: BreadcrumbsHandle | null = null;
  const changeChip = el('button', { class: 'change-chip' });
  const changeChipNum = el('span', { class: 'cc-num' });
  const changeChipTitle = el('span', { class: 'cc-title' });
  const changeChipCounts = el(
    'span',
    { class: 'cc-counts' },
    el('b', { class: 'added' }),
    el('b', { class: 'changed' }),
    el('b', { class: 'removed' }),
  );
  changeChip.append(icon('gitPullRequest', 13), changeChipNum, changeChipTitle, changeChipCounts);
  changeChip.addEventListener('click', () => {
    selected = null;
    selectedPath = null;
    value = null;
    removedSel = null;
    changesOpen = true;
    render();
  });
  const where = el('div', { class: 'where' }, crumbRoot, tagline, crumbsHost, changeChip);
  const topbar = el('nav', { class: 'topbar', 'aria-label': 'Location' }, brandBtn, historySpan, where);

  const borrowedBtn = el('button', { class: 'defined-in', title: 'Go to where this code is defined' });
  const borrowedStrong = el('strong', {});
  const borrowedDim = el('span', { class: 'dim' });
  borrowedBtn.append('defined in ', borrowedStrong, borrowedDim);
  borrowedBtn.addEventListener('click', () => {
    // `goTo` is defined below; this listener reads it via a mutable holder since
    // it is declared after this point but only ever invoked after mount.
    goToHolder.current?.(Number(borrowedBtn.dataset['id']));
  });
  const goToHolder: { current: ((id: number) => void) | null } = { current: null };

  // Toolbar
  const searchBtn = el('button', { class: 'search-button', 'aria-label': 'Search' }, icon('search', 15), el('span', {}, 'Search'), el('kbd', {}, '⌘K'));
  searchBtn.addEventListener('click', () => {
    dialog = 'search';
    render();
  });
  // Embedded in a Copse panel, `location.href` is this run's ephemeral
  // loopback server (a fresh port every launch) — a link to it is useless the
  // moment the panel closes, so there is nothing worth copying.
  const copyBtn = embedded ? null : (el('button', { class: 'icon', 'aria-label': 'Copy a link to this view' }) as HTMLButtonElement);
  copyBtn?.addEventListener('click', () => {
    nav?.viewChanged();
    // The URL is brought up to date a moment after the view settles.
    setTimeout(() => {
      void navigator.clipboard?.writeText(location.href).then(() => {
        copied = true;
        render();
        setTimeout(() => {
          copied = false;
          render();
        }, 1400);
      });
    }, 300);
  });
  // Embedded in a Copse panel, there is exactly one codebase to look at — the
  // host's own project — so a button to open a different one has nothing to do.
  const openBtn = embedded
    ? null
    : el('button', { class: 'icon', title: 'Open a codebase', 'aria-label': 'Open a codebase' }, icon('folderOpen', 17));
  openBtn?.addEventListener('click', () => {
    dialog = 'open';
    render();
  });
  // Exporting a static image is a standalone-site feature; embedded, the diagram
  // stays live inside Copse rather than becoming a file to hand off.
  const downloadBtn = embedded
    ? null
    : el('button', { class: 'icon', title: 'Download this view', 'aria-label': 'Download this view', popovertarget: 'download-menu' }, icon('download', 17));
  const downloadSvgBtn = el('button', { popovertarget: 'download-menu', popovertargetaction: 'hide' }, 'SVG');
  downloadSvgBtn.addEventListener('click', () => {
    if (engine) downloadSvg(engine.svg(), loaded?.scene.title ?? 'diagram');
  });
  const downloadPngBtn = el('button', { popovertarget: 'download-menu', popovertargetaction: 'hide' }, 'PNG');
  downloadPngBtn.addEventListener('click', () => {
    void engine?.png().then((b) => download(b, `${loaded?.scene.title ?? 'diagram'}.png`));
  });
  const downloadMenu = embedded ? null : el('div', { id: 'download-menu', class: 'menu', popover: 'auto' }, downloadSvgBtn, downloadPngBtn);
  // Embedded in a Copse panel, the host already owns the theme choice (and
  // repaints this page to match it — see __copseSetTheme below); a second,
  // independent toggle here would just be confusing.
  const themeBtn = embedded ? null : (el('button', { class: 'icon' }) as HTMLButtonElement);
  themeBtn?.addEventListener('click', toggleScheme);
  const toolbar = el(
    'div',
    { class: 'toolbar' },
    searchBtn,
    ...(copyBtn ? [copyBtn] : []),
    ...(openBtn ? [openBtn] : []),
    ...(downloadBtn ? [downloadBtn] : []),
    ...(downloadMenu ? [downloadMenu] : []),
    ...(themeBtn ? [themeBtn] : []),
  );

  // Zoombar
  const zoomOutBtn = el('button', { class: 'icon', 'aria-label': 'Zoom out', title: 'Zoom out (−)' }, icon('minus', 15));
  zoomOutBtn.addEventListener('click', () => engine?.zoomBy(1 / 1.5));
  const zoomInBtn = el('button', { class: 'icon', 'aria-label': 'Zoom in', title: 'Zoom in (+)' }, icon('plus', 15));
  zoomInBtn.addEventListener('click', () => engine?.zoomBy(1.5));
  const fitBtn = el('button', { class: 'icon', 'aria-label': 'Fit current view', title: 'Fit (F)' }, icon('maximize', 15));
  fitBtn.addEventListener('click', () => engine?.fit());
  const homeBtn = el('button', { class: 'icon', 'aria-label': 'Whole project', title: 'Whole project (H)' }, icon('home', 15));
  homeBtn.addEventListener('click', () => engine?.home());
  const trunkBtn = el(
    'button',
    { class: 'trunk-switch', role: 'switch', 'aria-label': 'Tidy arrows', title: 'Tidy arrows: draw one branching line out of each block, not a separate line for every value' },
    icon('split', 15),
    el('span', { class: 'switch', 'aria-hidden': 'true' }, el('i', {})),
  ) as HTMLButtonElement;
  // Lay the same project out again; the address brings the view back.
  function toggleTrunk(): void {
    if (loaded) void load(async () => loaded!.compare?.comparison ?? loaded!.project, !trunks);
    else {
      trunks = !trunks;
      storage.set('blockviz.trunks', trunks ? '1' : '');
      render();
    }
  }
  trunkBtn.addEventListener('click', toggleTrunk);
  const zoombar = el(
    'div',
    { class: 'zoombar' },
    zoomOutBtn,
    zoomInBtn,
    fitBtn,
    homeBtn,
    el('span', { class: 'zoombar-sep' }),
    trunkBtn,
  );

  // Footer
  const legendToggle = el('button', { class: 'legend-toggle' }, icon('info', 13), el('span', {}, 'Legend')) as HTMLButtonElement;
  legendToggle.addEventListener('click', () => {
    showLegend = !showLegend;
    render();
  });
  const statsSpan = el('span', { class: 'stats' });
  const partialSpan = el('span', { class: 'partial' });
  const footer = el('div', { class: 'footer' }, legendToggle, statsSpan, partialSpan);

  // Overlays
  const legendAside = el('aside', { class: 'legend', 'aria-label': 'Legend' });
  const busyDiv = el('div', { class: 'busy' });
  const busySpan = el('span', { role: 'status' });
  const cancelBtn = el('button', { class: 'link' }, 'Cancel');
  cancelBtn.addEventListener('click', () => cancel());
  busyDiv.append(el('span', { class: 'spinner' }), busySpan, cancelBtn);
  const errorDiv = el('div', { class: 'toast', role: 'alert' });
  const errorText = el('span', {});
  const errorDismiss = el('button', { class: 'icon', 'aria-label': 'Dismiss' }, icon('x', 14));
  errorDismiss.addEventListener('click', () => {
    error = null;
    render();
  });
  errorDiv.append(errorText, errorDismiss);
  const errorOverlayDiv = el('div', { class: 'toast over', role: 'alert' });
  const dropHint = el('div', { class: 'drop-hint' }, 'Drop a folder to visualize it');

  main.append(
    canvas,
    topbar,
    borrowedBtn,
    toolbar,
    zoombar,
    footer,
    legendAside,
    busyDiv,
    errorDiv,
    dropHint,
    errorOverlayDiv,
  );

  // Panels (mounted/destroyed on demand)
  let inspector: InspectorHandle | null = null;
  let removedDetails: RemovedDetailsHandle | null = null;
  let changesPanel: ChangesPanelHandle | null = null;
  let valuePanel: ValuePanelHandle | null = null;
  let openDialogHandle: OpenDialogHandle | null = null;
  let searchHandle: SearchHandle | null = null;
  const panelHost = main;

  // ---- loading orchestration ----

  function cancel(): void {
    loadingController?.abort();
    busy = null;
    nav?.resume();
    if (!engine) {
      dialog ??= 'open';
    }
    render();
  }

  async function load(
    make: (progress: (m: string) => void, signal: AbortSignal) => Promise<Project | Comparison>,
    sharedTrunks = trunks,
  ): Promise<void> {
    loadingController?.abort();
    const controller = new AbortController();
    loadingController = controller;
    const { signal } = controller;
    // The project on screen stops writing the address the new one is loaded into.
    nav?.stop();
    error = null;
    busy = 'Loading…';
    render();
    try {
      const made = await make((m) => {
        if (!signal.aborted) {
          busy = m;
          render();
        }
      }, signal);
      if (signal.aborted) return;
      const comparison = 'info' in made ? made : null;
      const project = comparison ? comparison.head : (made as Project);
      if (!project.files.length) throw new Error('No files found.');
      busy = comparison ? `Analyzing the change's ${String(project.files.length)} files…` : `Analyzing ${String(project.files.length)} files…`;
      render();
      const result = await analyzer.analyze(project, { sharedTrunks, signal });
      if (signal.aborted) return;
      if (!result.ok) throw new Error(result.error);
      const model = new SceneModel(result.scene, project);
      let compare: Compared | undefined;
      let elapsed = result.elapsed;
      if (comparison) {
        // The base is analyzed the same way, only to be compared with.
        busy = 'Comparing with the base…';
        render();
        const before = await analyzer.analyze(comparison.base, { sharedTrunks, signal });
        if (signal.aborted) return;
        if (!before.ok) throw new Error(before.error);
        const base = new SceneModel(before.scene, comparison.base);
        compare = {
          comparison,
          base,
          baseHighlights: new Highlights(analyzer, base),
          diff: new SceneDiff(base, model, comparison.info.files),
        };
        elapsed += before.elapsed;
      }
      selected = null;
      selectedPath = null;
      value = null;
      removedSel = null;
      changesOpen = true;
      view = { path: [] };
      loaded = {
        project,
        scene: result.scene,
        model,
        highlights: new Highlights(analyzer, model),
        elapsed,
        ...(compare ? { compare } : {}),
      };
      // Opened on purpose: commit the layout choice only now, so a cancelled or
      // failed load does not change the on-screen setting.
      trunks = sharedTrunks;
      storage.set('blockviz.trunks', trunks ? '1' : '');
      dialog = null;
      const info = comparison?.info;
      document.title = info
        ? `${info.kind === 'pr' ? `#${String(info.number)} ` : ''}${info.title} · ${result.scene.title} · blockviz`
        : `${result.scene.title} · blockviz`;
      rebuildEngine();
      render();
    } catch (e) {
      if (signal.aborted) return;
      nav?.resume();
      error = e instanceof Error ? e.message : String(e);
      dialog ??= 'open';
      render();
    } finally {
      if (!signal.aborted) {
        busy = null;
        render();
      }
    }
  }

  function open(r: OpenRequest): void {
    // The URL names the project only when a link can load it again. An embedding
    // host's files have no URL that would reopen them, same as a GitHub link
    // being resolved (handled separately, below).
    if (r.kind !== 'github' && r.kind !== 'embedded') pushProject(nav, location.pathname + location.search);
    if (r.kind === 'example') void load(() => exampleProject());
    if (r.kind === 'github') {
      storage.set('blockviz.github', r.url);
      pushProject(nav, `#github=${encodeURIComponent(r.url.replace(/^https?:\/\//, ''))}`);
      void load((p, signal) => fromGitHub(r.url, p, signal, true));
    }
    if (r.kind === 'folder') void load((p) => folderProject(r.files, p));
    if (r.kind === 'paste') void load(async () => pastedProject(r.filename, r.text));
    if (r.kind === 'embedded') void load(async () => embeddedProject(r.files, r.name));
  }

  // First load: a shared GitHub link, else the bundled example — unless an
  // embedding host (Copse) will hand over files itself (`#embedded=1`), in
  // which case nothing loads until it calls `window.__copseLoadFiles`.
  function loadFromUrl(): void {
    if (embedded) {
      busy = 'Waiting for the project…';
      render();
      return;
    }
    const repo = hashParam('github');
    if (repo) void load((p, signal) => fromGitHub(repo, p, signal));
    else void load(() => exampleProject());
  }

  function rebuildEngine(): void {
    if (!loaded) return;
    engine?.dispose();
    hover.set(null);
    nav?.dispose();
    nav = null;
    // A link that names a selection opens the details panel: frame its view beside it.
    const insets = overlayInsets(hashParams().has('sel'), fitted());
    const e = new Engine(
      canvas,
      loaded.model,
      {
        onView: (v) => {
          view = v;
          syncLocation();
        },
        onMove: () => nav?.viewChanged(),
        onJump: () => nav?.jump(),
        onSelect: (id, path) => {
          selected = id;
          selectedPath = path;
          value = null;
          removedSel = null;
          render();
        },
        onSelectEdge: (edge) => {
          value = edge;
          selected = null;
          selectedPath = null;
          removedSel = null;
          render();
        },
        onHover: (id) => hover.set(id),
      },
      theme(),
      insets,
    );
    e.setDiff(loaded.compare?.diff ?? null);
    engine = e;
    if (import.meta.env.DEV) (window as unknown as { __engine: Engine }).__engine = e;
    // Captured now (not read fresh in popHandler below): what the hash named
    // when this engine was built, so a pop can detect it naming something else.
    engineRepo = hashParams().get('github');
    const repo = engineRepo;
    const n = new Navigation(
      loaded.model,
      e,
      `${loaded.project.source}#${String(loaded.scene.nodes.length)}`,
      repo ? [['github', repo]] : [],
      (sel) => {
        selected = sel?.id ?? null;
        selectedPath = sel?.path ?? null;
        render();
      },
      () => {
        steps = { back: n.canBack, forward: n.canForward };
        render();
      },
    );
    nav = n;
    steps = { back: n.canBack, forward: n.canForward };
    render();
  }

  const popHandler = (ev: PopStateEvent): void => {
    // An entry of another project (or a link to one): load that project.
    if (!nav?.pop(ev.state)) loadFromUrl();
    else if ((hashParam('github') ?? '') !== (engineRepo ? decodeURIComponent(engineRepo) : '')) loadFromUrl();
  };
  window.addEventListener('popstate', popHandler);

  /** Set by an embedding host's __copseSetTheme; overrides the plain DARK/LIGHT
   * chrome colors (not the diagram's own role/change/flow vocabulary). */
  let chromeColors: ChromeColors | null = null;

  function theme(): Theme {
    const base = isDark() ? DARK : LIGHT;
    return chromeColors ? withChromeColors(base, chromeColors) : base;
  }

  function goTo(id: number): void {
    selected = id;
    selectedPath = loaded?.model.canonicalPath(id) ?? null;
    // The panel opens with this selection: frame the block beside it.
    engine?.setInsets(overlayInsets(true, fitted()));
    engine?.flyToNode(id);
    render();
  }
  goToHolder.current = goTo;

  function compareOf(): Compared | undefined {
    return loaded?.compare;
  }

  /** Where the change being read is among the changes (-1: what is selected is not one). */
  function changeIndex(): number {
    const compare = compareOf();
    if (!compare) return -1;
    if (removedSel !== null) return compare.diff.indexOf(removedSel, true);
    if (selected !== null) return compare.diff.indexOf(selected);
    return -1;
  }

  /** Goes to a change: selects its block (or shows the removed one) and flies to it. */
  function goToChange(i: number): void {
    const compare = compareOf();
    const c = compare?.diff.changes[i];
    if (!c) return;
    value = null;
    if (c.status === 'removed') {
      selected = null;
      selectedPath = null;
      removedSel = c.id;
      engine?.setInsets(overlayInsets(true, fitted()));
      engine?.flyToNode(c.at);
      render();
    } else {
      removedSel = null;
      goTo(c.id);
    }
  }

  /** The next (`delta` 1) or previous (-1) change from the one being read, round the list. */
  function stepChange(delta: number): void {
    const compare = compareOf();
    const n = compare?.diff.changes.length ?? 0;
    if (!n) return;
    const idx = changeIndex();
    goToChange(idx < 0 ? (delta > 0 ? 0 : n - 1) : (idx + delta + n) % n);
  }

  /** Selects a block for a line of source, staying in the instance being read. */
  function pick(id: number): void {
    if (!loaded) return;
    const path = loaded.model.instancePath(id, selectedPath ?? view.path);
    // Read through a call, the call is where the definition is drawn.
    selected = path[path.length - 1]!;
    selectedPath = path;
    engine?.reveal(path);
    render();
  }

  // ---- keyboard shortcuts (set up once; always reads live state) ----
  const keyHandler = (e: KeyboardEvent): void => {
    const target = e.target;
    const typing = target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      dialog = dialog === 'search' ? null : 'search';
      render();
      return;
    }
    // Esc closes a dialog, else the details panel (as its close button does); it never moves the view.
    if (e.key === 'Escape') {
      if (dialog) {
        if (dialog !== 'open' || loaded) dialog = null;
        render();
        return;
      }
      if (selected !== null) {
        selected = null;
        selectedPath = null;
      } else if (removedSel !== null) removedSel = null;
      else if (value !== null) value = null;
      else if (loaded?.compare && changesOpen) changesOpen = false;
      render();
      return;
    }
    // Back and forward, as in a browser.
    if (!typing && !dialog && ((e.altKey && e.key === 'ArrowLeft') || ((e.metaKey || e.ctrlKey) && e.key === '['))) {
      e.preventDefault();
      history.back();
      return;
    }
    if (!typing && !dialog && ((e.altKey && e.key === 'ArrowRight') || ((e.metaKey || e.ctrlKey) && e.key === ']'))) {
      e.preventDefault();
      history.forward();
      return;
    }
    if (typing || dialog || e.metaKey || e.ctrlKey || e.altKey) return;
    const eng = engine;
    if (!eng) return;
    if (e.key === '/') {
      e.preventDefault();
      dialog = 'search';
      render();
    } else if (e.key === 'f') eng.fit();
    else if (e.key === 'h' || e.key === '0') eng.home();
    else if (e.key === '+' || e.key === '=') eng.zoomBy(1.5);
    else if (e.key === '-' || e.key === '_') eng.zoomBy(1 / 1.5);
    else if (e.key === 'Enter' && selectedPath) eng.flyTo(selectedPath);
    else if ((e.key === 'n' || e.key === 'p') && loaded?.compare) stepChange(e.key === 'n' ? 1 : -1);
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const d = 90;
      eng.panBy(e.key === 'ArrowLeft' ? d : e.key === 'ArrowRight' ? -d : 0, e.key === 'ArrowUp' ? d : e.key === 'ArrowDown' ? -d : 0);
    }
  };
  window.addEventListener('keydown', keyHandler);

  const resizeHandler = (): void => {
    render();
  };
  window.addEventListener('resize', resizeHandler);

  const unsubScheme = subscribeScheme(() => {
    engine?.setTheme(theme());
    render();
  });

  /** Applies the chrome colors a host (Copse) pushed: the few CSS custom
   * properties that aren't already a formula over them (styles.css), the
   * diagram's own chrome-facing theme fields (`theme()`, above), and
   * dark/light itself. Everything else — the diagram's role/change/flow
   * vocabulary, `--faint`/`--chip`/`--code-*` — stays blockviz's own. */
  function applyEmbeddedChrome(colors: ChromeColors & { dark: boolean }): void {
    setEmbeddedDark(colors.dark);
    chromeColors = colors;
    const root = document.documentElement.style;
    root.setProperty('--bg', colors.background);
    root.setProperty('--panel', colors.panel);
    root.setProperty('--glass', colors.background);
    root.setProperty('--ink', colors.ink);
    root.setProperty('--muted', colors.muted);
    root.setProperty('--line', colors.line);
    root.setProperty('--line-strong', colors.line);
    root.setProperty('--accent', colors.accent);
    engine?.setTheme(theme());
    render();
  }

  // Bridges for an embedding host (Copse): files read from disk, in place of
  // GitHub or the browser's folder picker; the host's own chrome colors,
  // pushed once and again live whenever the host's own theme changes; and
  // search/zoom/home/trunk, the toolbar and zoombar actions that still need a
  // visible trigger once the floating topbar/toolbar/zoombar are hidden
  // (is-embedded, above) — the host's own pane-header carries those buttons
  // and calls these instead. No `__copseFit`: the host dropped that button,
  // home already resets to the same whole-project view.
  if (embedded) {
    const bridge = window as unknown as {
      __copseLoadFiles?: (files: { path: string; content: string }[], name?: string) => void;
      __copseSetTheme?: (colors: ChromeColors & { dark: boolean }) => void;
      __copseOpenSearch?: () => void;
      __copseZoomOut?: () => void;
      __copseZoomIn?: () => void;
      __copseHome?: () => void;
      __copseToggleTrunk?: () => void;
    };
    bridge.__copseLoadFiles = (files, name) => {
      open({ kind: 'embedded', files, ...(name ? { name } : {}) });
    };
    bridge.__copseSetTheme = applyEmbeddedChrome;
    bridge.__copseOpenSearch = () => {
      dialog = 'search';
      render();
    };
    bridge.__copseZoomOut = () => engine?.zoomBy(1 / 1.5);
    bridge.__copseZoomIn = () => engine?.zoomBy(1.5);
    bridge.__copseHome = () => engine?.home();
    bridge.__copseToggleTrunk = toggleTrunk;
  }

  // ---- rendering ----

  let lastPathKey = '';

  function syncLocation(): void {
    const pathKey = view.path.join(' ');
    const crumbs: Crumb[] = loaded
      ? view.path.map((id, i) => ({ id, i, title: loaded!.model.node(id)?.title ?? '' })).filter((c) => c.title)
      : [];
    const compare = compareOf();

    crumbRoot.hidden = crumbs.length > 1;
    crumbRoot.textContent = loaded?.scene.title ?? '';

    const showTagline = view.path.length <= 1 && !compare && !!loaded?.scene.description;
    tagline.hidden = !showTagline;
    if (showTagline && loaded) {
      tagline.textContent = loaded.scene.description ?? '';
      tagline.title = loaded.scene.description ?? '';
    }

    if (crumbs.length > 1) {
      if (!breadcrumbs) {
        breadcrumbs = mountBreadcrumbs(crumbsHost, {
          onGo: (c) => {
            const slice = view.path.slice(0, c.i + 1);
            engine?.flyTo(slice.length > 1 ? slice : [view.path[0]!], 'fit', 0.06);
          },
        });
      }
      if (pathKey !== lastPathKey) breadcrumbs.update(crumbs);
    } else {
      breadcrumbs?.destroy();
      breadcrumbs = null;
    }

    changeChip.hidden = !compare;
    if (compare) {
      changeChip.title = `${compare.comparison.info.title}: show its changes`;
      changeChip.classList.toggle('narrow', false);
      changeChipNum.textContent = compare.comparison.info.kind === 'pr' ? `#${String(compare.comparison.info.number)}` : 'compare';
      changeChipTitle.hidden = view.path.length > 1;
      changeChipTitle.textContent = compare.comparison.info.title;
      changeChipCounts.children[0]!.textContent = `+${String(compare.diff.summary.added)}`;
      changeChipCounts.children[1]!.textContent = `~${String(compare.diff.summary.changed)}`;
      changeChipCounts.children[2]!.textContent = `−${String(compare.diff.summary.removed)}`;
    }

    // Inside code reached through a call (… › block › attn): where that code is defined.
    const borrowed = pathKey !== lastPathKey && loaded ? loaded.model.borrowedDefinition(view.path) : undefined;
    if (pathKey !== lastPathKey) {
      borrowedBtn.hidden = !(borrowed && loaded);
      if (borrowed && loaded) {
        borrowedBtn.dataset['id'] = String(borrowed.id);
        borrowedStrong.textContent = loaded.model.qualified(borrowed.id);
        if (borrowed.span) {
          borrowedDim.hidden = false;
          borrowedDim.textContent = ` · ${loaded.model.fileOf(borrowed)?.split('/').pop()}:${String(borrowed.span.line)}`;
        } else {
          borrowedDim.hidden = true;
        }
      }
    }

    lastPathKey = pathKey;
  }

  function render(): void {
    const compare = compareOf();
    const node = loaded && selected !== null ? loaded.model.node(selected) : null;
    const panelOpen = selected !== null || value !== null || removedSel !== null || (!!compare && changesOpen);
    const size = fitted();

    main.classList.toggle('dragging', dragging);

    syncLocation();

    backBtn.disabled = !steps.back;
    forwardBtn.disabled = !steps.forward;

    if (copyBtn) {
      copyBtn.title = copied ? 'Link copied' : 'Copy a link to this view';
      clear(copyBtn);
      copyBtn.append(copied ? icon('check', 17) : icon('link', 17));
    }

    if (themeBtn) {
      themeBtn.title = isDark() ? 'Light mode' : 'Dark mode';
      themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
      clear(themeBtn);
      themeBtn.append(isDark() ? icon('sun', 17) : icon('moon', 17));
    }

    trunkBtn.classList.toggle('on', trunks);
    trunkBtn.setAttribute('aria-checked', String(trunks));

    legendToggle.classList.toggle('on', showLegend);
    legendToggle.setAttribute('aria-expanded', String(showLegend));

    const stats = loaded?.scene.stats;
    statsSpan.hidden = !stats;
    if (stats && loaded) {
      statsSpan.textContent = `${String(stats.files)} files · ${stats.lines.toLocaleString()} lines · ${stats.nodes.toLocaleString()} blocks · ${String(Math.round(loaded.elapsed))} ms`;
    }
    const cut = loaded ? partial(loaded.project) : null;
    partialSpan.hidden = !cut;
    if (cut) {
      partialSpan.textContent = `Partly shown: ${cut}`;
      partialSpan.title = `Larger than blockviz reads in a browser (${LIMITS}): its code was read first, then its tests, then its documentation.`;
    }

    // Legend
    if (showLegend && loaded) {
      const drawn = drawnIn(loaded.model.nodes);
      const t = theme();
      clear(legendAside);
      const header = el(
        'header',
        {},
        el('strong', {}, 'Legend'),
        (() => {
          const btn = el('button', { class: 'icon', 'aria-label': 'Close legend' }, icon('x', 14));
          btn.addEventListener('click', () => {
            showLegend = false;
            render();
          });
          return btn;
        })(),
      );
      const grid = el(
        'div',
        { class: 'legend-grid' },
        ...legend
          .filter(([cat]) => drawn.roles.has(cat))
          .map(([cat, label]) => {
            const s = swatch(t, cat);
            return el('span', {}, el('i', { style: `background: ${s.fill}; border-color: ${t.outline}` }), label);
          }),
      );
      const lines = el('div', { class: 'legend-lines' });
      if (drawn.edges.has('data') || drawn.edges.has('uses')) {
        lines.append(
          el(
            'span',
            {},
            svgArrow(26, t.edge, 1.4),
            'value flows into',
          ),
        );
      }
      if (drawn.edges.has('control')) {
        lines.append(el('span', {}, svgArrow(27, t.context, 1.2, '1.5 2.5'), 'decides whether it runs'));
      }
      if (drawn.edges.has('artifact')) {
        lines.append(el('span', {}, svgArrow(26, t.artifact, 1.4, '6 3'), 'file written → read'));
      }
      if (drawn.edges.has('exec')) {
        lines.append(el('span', {}, svgArrow(26, t.faintEdge, 1.4, '5 4'), 'code executed'));
      }
      if (drawn.add) {
        const svg = svgEl(34, 14);
        svg.append(
          svgCircle(17, 7, 6, t.paper, t.outline),
          svgPath('M13.5 7h7M17 3.5v7', t.outline),
        );
        lines.append(el('span', {}, svg, 'add'));
      }
      if (drawn.effects) {
        const svg = svgEl(34, 14);
        svg.append(svgCircle(17, 7, 3.5, t.effect));
        lines.append(el('span', {}, svg, 'has side effects'));
      }
      legendAside.append(header, grid, lines);
      if (compare && compare.diff.changes.length > 0) {
        const changeLines = el('div', { class: 'legend-lines' });
        if (compare.diff.summary.added > 0) {
          changeLines.append(
            el('span', {}, el('i', { class: 'legend-box', style: `background: ${t.change.added.tint}; border-color: ${t.change.added.ink}` }), 'added'),
          );
        }
        if (compare.diff.summary.changed > 0) {
          changeLines.append(
            el('span', {}, el('i', { class: 'legend-box', style: `background: ${t.change.changed.tint}; border-color: ${t.change.changed.ink}` }), 'changed'),
          );
        }
        if (compare.diff.added.size > 0) changeLines.append(el('span', {}, svgArrow(26, t.change.added.ink, 2), 'new connection'));
        if (compare.diff.removed.size > 0) changeLines.append(el('span', {}, svgArrow(26, t.change.removed.ink, 1.6, '5 4'), 'removed connection'));
        changeLines.append(el('span', {}, el('i', { class: 'legend-count' }, '3'), 'changes inside'));
        changeLines.append(el('span', {}, el('i', { class: 'legend-box dashed', style: `border-color: ${t.change.changed.ink}` }), 'leads into changes'));
        legendAside.append(changeLines);
      }
      legendAside.append(el('p', {}, `Bigger blocks contain more. Zoom into any block with a corner mark to see inside.${compare ? ' What the change did not touch is faded.' : ''}`));
      legendAside.hidden = false;
    } else {
      legendAside.hidden = true;
    }

    // Engine effects that are cheap/idempotent to call every render.
    engine?.peek(null);
    engine?.setInsets(overlayInsets(panelOpen, size));
    const tracedStart = value && loaded?.model.nodes[value.owner]?.edges?.[value.index];
    const traced = value && tracedStart && loaded ? { owner: value.owner, start: tracedStart, ...traceValue((id) => loaded!.model.node(id), value.owner, tracedStart) } : null;
    engine?.trace(traced && { scope: traced.scope, edges: traced.edges });

    // Conditional panels, mounted/updated/destroyed to match what should show.
    if (node && loaded) {
      const compareProp = compare
        ? { diff: compare.diff, baseHighlights: compare.baseHighlights, index: changeIndex(), onStep: stepChange, onChange: goToChange }
        : undefined;
      const props = {
        model: loaded.model,
        highlights: loaded.highlights,
        node,
        hover,
        size,
        onResize: (s: PanelSize) => setPanel(s),
        onClose: () => {
          selected = null;
          selectedPath = null;
          render();
        },
        onZoom: () => {
          if (selectedPath) engine?.flyTo(selectedPath);
        },
        onGo: goTo,
        onPick: pick,
        onPeek: (id: number | null) => engine?.peek(id),
        onDownload: () => downloadBlock(loaded!.model, node.id, theme(), { diff: compare?.diff }),
        ...(compareProp ? { compare: compareProp } : {}),
      };
      if (inspector) inspector.update(props);
      else inspector = mountInspector(panelHost, props);
    } else {
      inspector?.destroy();
      inspector = null;
    }

    if (compare && removedSel !== null && !node) {
      const change = compare.diff.changes[compare.diff.indexOf(removedSel, true)];
      if (change) {
        const props = {
          diff: compare.diff,
          change,
          baseHighlights: compare.baseHighlights,
          size,
          index: changeIndex(),
          onResize: (s: PanelSize) => setPanel(s),
          onClose: () => {
            removedSel = null;
            render();
          },
          onShow: (id: number) => engine?.flyToNode(id),
          onStep: stepChange,
          onDownload: () => downloadBlock(compare.diff.base, removedSel!, theme()),
        };
        if (removedDetails) removedDetails.update(props);
        else removedDetails = mountRemovedDetails(panelHost, props);
      }
    } else {
      removedDetails?.destroy();
      removedDetails = null;
    }

    if (compare && changesOpen && !node && removedSel === null && !traced) {
      const props = {
        diff: compare.diff,
        info: compare.comparison.info,
        size,
        current: changeIndex(),
        onResize: (s: PanelSize) => setPanel(s),
        onClose: () => {
          changesOpen = false;
          render();
        },
        onGo: goToChange,
        onPeek: (id: number | null) => engine?.peek(id),
      };
      if (changesPanel) changesPanel.update(props);
      else changesPanel = mountChangesPanel(panelHost, props);
    } else {
      changesPanel?.destroy();
      changesPanel = null;
    }

    if (traced && loaded && !node && removedSel === null) {
      const props = {
        model: loaded.model,
        owner: traced.owner,
        edges: traced.edges,
        start: traced.start,
        size,
        onClose: () => {
          value = null;
          render();
        },
        onPick: (id: number) => {
          value = null;
          pick(id);
        },
        onPeek: (id: number | null) => engine?.peek(id),
        onDownload: (id: number) => downloadBlock(loaded!.model, id, theme(), { diff: compare?.diff, trace: traced }),
      };
      if (valuePanel) valuePanel.update(props);
      else valuePanel = mountValuePanel(panelHost, props);
    } else {
      valuePanel?.destroy();
      valuePanel = null;
    }

    busyDiv.hidden = !busy;
    if (busy) busySpan.textContent = busy;
    errorDiv.hidden = !error || !!dialog;
    if (error) errorText.textContent = error;
    dropHint.hidden = !dragging;

    if (dialog === 'open') {
      if (!openDialogHandle) {
        openDialogHandle = mountOpenDialog(panelHost, {
          onOpen: open,
          onClose: () => {
            dialog = null;
            render();
          },
          canClose: !!loaded,
          lastUrl: storage.get('blockviz.github') || 'github.com/karpathy/nanoGPT',
        });
      }
    } else {
      openDialogHandle?.destroy();
      openDialogHandle = null;
    }
    errorOverlayDiv.hidden = !(dialog === 'open' && error);
    if (dialog === 'open' && error) errorOverlayDiv.textContent = error;

    if (dialog === 'search' && loaded) {
      if (!searchHandle) {
        searchHandle = mountSearch(panelHost, {
          model: loaded.model,
          onPick: (id) => {
            dialog = null;
            goTo(id);
          },
          onClose: () => {
            dialog = null;
            render();
          },
        });
      }
    } else {
      searchHandle?.destroy();
      searchHandle = null;
    }
  }

  function setPanel(next: PanelSize): void {
    panel = next;
    if (panelSizeTimer) clearTimeout(panelSizeTimer);
    panelSizeTimer = setTimeout(() => {
      storage.set('blockviz.panel.w', String(panel.w));
      storage.set('blockviz.panel.h', String(panel.h));
    }, 300);
    render();
  }

  function svgEl(w: number, h: number): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    return svg;
  }
  function svgPath(d: string, stroke: string, fill = 'none'): SVGPathElement {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('stroke', stroke);
    p.setAttribute('fill', fill);
    return p;
  }
  function svgCircle(cx: number, cy: number, r: number, fill: string, stroke?: string): SVGCircleElement {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', String(r));
    c.setAttribute('fill', fill);
    if (stroke) c.setAttribute('stroke', stroke);
    return c;
  }
  function svgArrow(lineEnd: number, color: string, width: number, dash?: string): SVGSVGElement {
    const svg = svgEl(34, 10);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '5');
    line.setAttribute('x2', String(lineEnd));
    line.setAttribute('y2', '5');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(width));
    if (dash) line.setAttribute('stroke-dasharray', dash);
    const headStart = lineEnd === 26 ? 26 : 27;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${String(headStart)} ${String(5 - (headStart === 26 ? 3.5 : 3))} L33 5 L${String(headStart)} ${String(5 + (headStart === 26 ? 3.5 : 3))}Z`);
    path.setAttribute('fill', color);
    svg.append(line, path);
    return svg;
  }

  render();
  loadFromUrl();

  return () => {
    window.removeEventListener('popstate', popHandler);
    window.removeEventListener('keydown', keyHandler);
    window.removeEventListener('resize', resizeHandler);
    unsubScheme();
    loadingController?.abort();
    analyzer.cancel();
    engine?.dispose();
    nav?.dispose();
    inspector?.destroy();
    removedDetails?.destroy();
    changesPanel?.destroy();
    valuePanel?.destroy();
    openDialogHandle?.destroy();
    searchHandle?.destroy();
    breadcrumbs?.destroy();
    main.remove();
  };
}
