# Per-PR demo previews: clickable demo links on every PR

**Status: Active.** Resolves the deliberately-deferred "per-PR distribution"
question from [demo-links.md](demo-links.md) M3. The demo _build_ already existed and
ran in CI on every eligible PR (`npm run build:demo` → `dist/demo/`, plus `test:demo`
in `ci.yml`); the missing piece — publishing that artifact to a stable per-PR URL and
surfacing the link — is implemented via the **GitHub Pages subdirectory** approach.
Each PR gets a marketing-site preview at `copse.dev/demo/pr-<n>-preview/` and its
demo at `copse.dev/demo/pr-<n>/`. The bundle links that demo rather than nesting its
own copy — see "One demo per target" below. This keeps everything on GitHub rather
than adding an external preview host. The deploy is deliberately gated behind sign-off
before it serves untrusted PR builds from the live domain.

## Implementation

- **`scripts/build.mts`** — the `--demo` build now emits `dist/demo/scenarios.json`
  (id + label per scenario) so the PR comment links each `?scenario=` state without a
  hard-coded list.
- **`.github/workflows/demo-preview.yml`** — triggered **on push** (not `workflow_run`),
  so the workflow runs from the pushed branch's own definition and the whole flow is
  testable on the PR that introduces it, before merge. It resolves the branch's open PR,
  builds the demo, commits the flat demo under `pr-<n>/` and the branch's marketing-site
  bundle (linking that demo) under `pr-<n>-preview/` on the machine-managed `demo-previews`
  branch, calls `pages.yml` to redeploy, and posts/updates the sticky
  `<!-- copse-demo-preview -->` comment — in parallel with that deploy, not behind it.
  Branches without an open PR build nothing, and a build whose bytes match what is
  already published commits nothing — see "Publish only on change" below.
- **`.github/workflows/pages.yml`** — the deploy job is the single assembler: it lays
  down the production `site/` **from `main`** and overlays every machine-managed target
  below `/demo/`. It exposes a `workflow_call` entrypoint. Keeping
  both PR artifacts as ordinary targets makes them compatible with older branch-local
  copies of this workflow, so a queued older deploy cannot omit or remap them. Pinning
  the root site to `main` means a preview push never changes the production homepage.
- **`.github/workflows/demo-preview-cleanup.yml`** — on PR close, prunes both
  `pr-<n>/` and `pr-<n>-preview/` from `demo-previews` and redeploys.

## What already exists (don't rebuild it)

- **A browser-hostable demo.** `scripts/build.mts --demo` bundles the renderer with a
  total mock `window.api` (`src/renderer/demo/demo-api.ts`) into self-contained static
  files under `dist/demo/`. No Electron, no backend, no secrets — servable from any
  static host.
- **Scenario selection via query string.** `src/renderer/demo/main.ts` calls
  `selectDemoScenario(window.location.search)`, so `dist/demo/?scenario=<id>` opens a
  specific seeded state. One deploy demos many states; the PR comment can link each.
- **A per-PR CI build.** `ci.yml`'s demo job already runs `build:demo` on same-repo PRs
  (guarded by `head.repo.full_name == github.repository` and the precheck `mode`). The
  bytes we want to publish are already produced.
- **A sticky-comment + trusted-deploy pattern to copy.** The `commit-screenshots` job
  posts/updates a single marker comment (`<!-- copse-e2e-screenshots -->`) via
  `actions/github-script`, and does its privileged work (pushing commits, commenting)
  in a trusted context — not in the untrusted PR build. The demo-preview flow reuses
  both ideas verbatim.

## The GitHub Pages constraint (answering the questions directly)

- **One Pages site per repo.** GitHub gives `agent-pane` exactly one `github-pages`
  environment, one custom domain (`copse.dev`, from `site/CNAME`), and one deployment
  that _replaces the whole site_ each time. You cannot run two parallel Pages sites from
  this one repo. A second independent site would require a second repo (or an org
  `*.github.io` repo) — out of scope for the one-repo choice made here.
- **Many _paths_ under the one site are fine.** `copse.dev/`,
  `copse.dev/demo/pr-123/`, and `copse.dev/demo/pr-123-preview/` all coexist; they're
  just directories in the published tree. That is the whole basis of this plan.
- **Nothing is served from `docs/` today.** The marketing site is `site/`, published via
  GitHub Actions in `pages.yml` (the file's own comment notes classic Pages can't serve
  from `/site`, which is why it moved to Actions). `docs/` is developer markdown and is
  not a served site — there is nothing there to "ditch."

## Design

The friction: Actions-based Pages deploys _replace the entire published tree_ from a
single uploaded artifact. A naïve "deploy just this PR's subdir" would wipe the
marketing site and every other PR preview. So we need a **durable store of live
previews** that a single deploy re-assembles from.

### Components

1. **`demo-previews` orphan branch — the durable store.** Machine-managed, never
   hand-edited. Each PR has two ordinary targets: `pr-<n>/` contains the flat browser
   demo, while `pr-<n>-preview/` contains the static site at its root, linking that same
   flat demo. This is the source of truth for "which previews are currently
   live," surviving across the whole-tree redeploys that Actions Pages forces.

2. **Assemble-and-deploy job (trusted).** Builds the Pages artifact with `site/` from
   `main` at the root and every durable-store target at `/demo/<target>/`, then publishes
   via `actions/upload-pages-artifact` + `actions/deploy-pages`. The assembler needs no
   knowledge of which targets are demos or bundles, preserving compatibility with
   deploys queued from older feature-branch workflow definitions.

3. **Per-PR publish (push-triggered, same-repo by construction).** `demo-preview.yml`
   fires **on push** to any non-`main` branch, so it runs from the pushed branch's own
   workflow definition — which is what makes the flow testable pre-merge. It resolves the
   branch's open PR, builds the demo, commits `dist/demo` to
   `demo-previews:pr-<n>/`, commits the site (linking that demo) to
   `demo-previews:pr-<n>-preview/`, and invokes the assemble-and-deploy job. Safety
   comes from the trigger itself: only
   same-repo branches can push here (forks push to their own fork and never trigger this
   repo's push workflows), so the write token and deploy never see fork code — no separate
   split-trust stage needed. An earlier design used `workflow_run` for that isolation, but
   `workflow_run` only runs from the default branch, so it could never be exercised before
   merge; the push trigger trades nothing for that isolation given the same-repo-only
   scope. Pinning the root site to `main` (component 2) keeps a preview push from
   touching the production marketing site while still exposing the branch's site at its
   isolated preview path.

4. **Cleanup on close.** A `pull_request: [closed]` job removes both `pr-<n>/` and
   `pr-<n>-preview/` from `demo-previews` and redeploys, so previews don't accumulate
   forever.

5. **Sticky PR comment.** A new marker (`<!-- copse-demo-preview -->`) posts/updates one
   comment with the base preview URL plus one link per demo scenario (enumerated from the
   shared scenario list, using `?scenario=<id>`). Reuse the list/find/update/create logic
   already in the screenshots comment step so re-pushes update in place rather than
   spamming.

### One demo per target

`site/index.html` links the demo relatively, as `demo/main/`, which resolves correctly
from the site root. A bundle served from a subdirectory used to satisfy that by nesting
a second, identical copy of the whole demo inside itself — so every PR paid for two
builds of the same bytes, and the demo carried the awkward
`/demo/pr-<n>-preview/demo/main/` URL.

The publish step now rewrites those links to the flat build published beside the bundle:
`../pr-<n>/` from `pr-<n>-preview/`, and `../` from `main/preview/`. Relative rather
than root-relative, so it holds whether Pages serves from the `copse.dev` root or an
`<owner>.github.io/<repo>/` prefix — the mistake that leaves Monaco unreachable
(below) is exactly the one this avoids.

A bundle is therefore no longer self-contained: it needs its sibling flat build. That is
safe because the two are published in the same commit and pruned in the same cleanup.
The rewrite fails the job if `site/index.html` stops containing `"demo/main/`, so a site
refactor cannot silently ship a bundle pointing at a directory that no longer exists.

### Publish only on change

The publish step stages the rebuilt target and stops at `git diff --cached --quiet` when
the bytes match what is already published. Most pushes land there: the demo build reads
only the renderer, shared, preload and site trees, so a docs, test, benchmark or
main-process commit rebuilds byte-identical output.

**Nothing written under a target directory may derive from the commit SHA**, or that
check can never be true. A `.head-sha` provenance file used to be written into each
target and staged immediately before the check, which defeated it on every single push —
so every push to every branch with an open PR committed to `demo-previews` and triggered
a full-tree redeploy, whatever it had changed. Nothing ever read the file. Provenance
belongs in the commit message, which already carries the SHA.

### Deploy serialization

`pages.yml` sets `concurrency: { group: pages, cancel-in-progress: false }` and every
preview publish redeploys the whole site, so deploys serialize behind an ~11-minute
full-tree upload. This _did_ become the bottleneck this section originally anticipated,
and the fix was cheaper than the external-host escape hatch below.

To stop a superseded deploy painting a PR red, the group carried `queue: max`, which kept
**every** queued deploy. But the assembler reads whatever is on the `demo-previews` tip
rather than the calling run's content, so queued deploys are identical re-assemblies
where only the last can matter. Arrivals ran at roughly the drain rate, and the queue
became a standing backlog — deploys observed starting 6h26m after creation, with the
sticky comment (behind `needs: deploy`) landing seven hours after the push.

`queue: max` is gone, so GitHub's default single pending slot coalesces a burst into one
upload. That still marks a superseded caller's run cancelled, but the cost is now
cosmetic: the comment no longer sits behind `needs: deploy`, so the preview link survives
and posts within minutes, and the superseding deploy publishes that target anyway. Fixing
the no-change guard (above) also removed most of the load that made the queue pathological
in the first place.

The deploy stays a `workflow_call` from the publishing workflows. A `push:` trigger on
`demo-previews` looks tempting and is a trap: that branch is an orphan holding preview
content with no `.github/` of its own, and a push event runs the workflow definitions
from the pushed branch — so the trigger would silently never fire and previews would stop
deploying entirely.

If deploy volume ever bites again, the remaining escape hatch is a dedicated external
preview host (Cloudflare Pages/Netlify give native per-PR URLs), explicitly _not_ chosen
here but noted as the pressure-release valve.

### Search indexing

Previews live on the production domain, so search engines find them: the sticky PR
comment is on a crawlable github.com page, and each `pr-<n>-preview/` is a near-duplicate
of `copse.dev/` competing with it for its own copy. A closed PR then leaves dead
`/demo/pr-<n>/` results behind, since cleanup removes the content but not the index entry.

So **everything published under `/demo/` carries
`<meta name="robots" content="noindex, nofollow">`**, injected at publish time by
[`scripts/lib/noindex.mts`](../../scripts/lib/noindex.mts): the demos by `build:demo`
(so the tag travels with the artifact wherever it is served, including the recorded
cupcake site under `sites/`), the marketing-site bundles by `demo-preview.yml`'s publish
step — on the copy, never on `site/` itself, which `pages.yml` deploys to the root from
`main` and which stays indexable. `ci-workflow-invariants.test.ts` pins both directions.

Three things about this that are easy to get wrong later:

- **A meta tag, not `X-Robots-Tag`.** GitHub Pages serves static files with headers we
  cannot configure. If the site ever moves to a host that can set them, the header
  replaces the tag.
- **`robots.txt` must not `Disallow: /demo/`.** A disallowed URL is never fetched, so its
  `noindex` is never read, and it can stay indexed URL-only on the strength of those
  public inbound links — with no mechanism left to drop it. `site/robots.txt` exists to
  say exactly that to the next person who tries. Crawling is how the tag gets honoured.
- **The tag is constant, so "publish only on change" still holds.** A marker that varied
  per run — a timestamp, a PR number — would make every push republish and redeploy the
  whole site, the same trap `.head-sha` fell into above. `markTreeNoindex` is idempotent
  and rewrites no bytes on an already-marked tree.

## Security / phishing considerations

Serving JS built from a contributor branch on the **primary marketing domain** is a real
consideration, called out in demo-links.md M3. Mitigations, in order:

- **Same-repo branches only.** The push trigger fires only for branches in this repo;
  fork branches live in the fork and never trigger it, so fork code never reaches the
  write token, the `demo-previews` branch, or the deploy — and forks get **no** copse.dev
  preview. A downloadable-artifact fallback for forks (per demo-links.md M3) is deferred.
- **The demo is inert.** Fully static, mocked `window.api`, no real API calls, no
  secrets, no credentials. The marketing site sets no sensitive cookies on `copse.dev`,
  so a preview subpath has nothing to steal.
- **Production root pinned to `main`.** The deploy always republishes the root `site/`
  from `main`. A preview push can only add or change its own `/demo/pr-<n>/` and
  `/demo/pr-<n>-preview/` subtrees; its branch-specific marketing site never replaces
  the production homepage.
- **Open decision — origin isolation.** Previews and the marketing site share the
  `copse.dev` origin (cookie/`localStorage`/`postMessage` scope). Fully isolating them
  (`demo.copse.dev`) requires a _second_ Pages site → a second repo, which contradicts
  the one-repo choice. Flagged for an explicit call: accept shared origin (low risk given
  the site is cookieless and static), or spin up a demos repo later if isolation is
  wanted.

## Milestones

- **P0 — durable store + assembler.** _Done._ `pages.yml` assembles the production
  `site/` and every target under `demo-previews` into one artifact. It tolerates an
  absent `demo-previews` branch (the marketing site publishes unchanged with no
  previews). The branch is created lazily on the first publish rather than committed
  up front.
- **P1 — per-PR publish.** _Done._ `demo-preview.yml` (push-triggered) resolves the
  branch's open PR, builds the demo, commits `pr-<n>/` and `pr-<n>-preview/`, and
  redeploys. Same-repo by construction.
- **P2 — sticky comment.** _Done._ `demo-preview.yml`'s comment job posts/updates
  `<!-- copse-demo-preview -->` with the base URL and per-scenario links.
- **P3 — cleanup.** _Done._ `demo-preview-cleanup.yml` prunes `pr-<n>/` and
  `pr-<n>-preview/` on PR close and redeploys.
- **P4 — fork fallback.** _Deferred._ Fork branches get no preview (they never trigger the
  push workflow). Linking the downloadable `dist/demo` artifact for forks remains
  follow-up work.

## Verification and rollout notes

- **Testable pre-merge.** Because publishing is push-triggered, `demo-preview.yml` runs
  from the PR branch's own definition — so pushing this PR exercises the full flow
  (build → `demo-previews` → deploy → comment) and should light up a live site preview
  at `copse.dev/demo/pr-<n>-preview/`, with its demo at `copse.dev/demo/pr-<n>/`. That direct
  `copse.dev/demo/pr-<n>/` URL remains available. The cleanup workflow
  (`pull_request: closed`) is still read from the base branch, so it first runs
  post-merge.
- **Locally verified before merge:** `build:demo` emits a valid `scenarios.json`; all
  workflow YAML parses and is Prettier-clean.
- **Required repo setting.** The `github-pages` environment's _Deployment branches_ policy
  must permit the feature branch (or be set to "All branches") for a pre-merge preview
  deploy to run without a manual approval gate. Pages source stays "GitHub Actions."
- **Sign-off gate.** Previews are served from the live `copse.dev` origin (shared with the
  marketing site). The production root is pinned to `main` so a preview can't alter it,
  and the demo is inert/mocked; the residual shared-origin decision is below. This is
  the item needing an explicit human call.

## Dependencies and open items

- **Depends on** demo-links.md M1's scenario picker for the per-scenario comment links to
  be meaningful (the bare `dist/demo/` already works; richer links improve as scenarios
  land).
- **Origin-isolation decision** (above) — accept shared `copse.dev` origin, or defer a
  `demo.copse.dev` second-repo site.
