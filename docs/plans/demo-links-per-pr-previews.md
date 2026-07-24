# Per-PR demo previews: clickable demo links on every PR

**Status: Active.** Resolves the deliberately-deferred "per-PR distribution"
question from [demo-links.md](demo-links.md) M3. The demo _build_ already existed and
ran in CI on every eligible PR (`npm run build:demo` → `dist/demo/`, plus `test:demo`
in `ci.yml`); the missing piece — publishing that artifact to a stable per-PR URL and
surfacing the link — is implemented via the **GitHub Pages subdirectory** approach
(`copse.dev/pr-<n>/`), keeping everything on GitHub rather than adding an external
preview host. The wiring cannot run until it is on `main` (workflow_run / pull_request /
push triggers are read from the base branch), so it is verified end-to-end only after
merge; the deploy is deliberately gated behind sign-off before it serves untrusted PR
builds from the live domain.

## Implementation

- **`scripts/build.mts`** — the `--demo` build now emits `dist/demo/scenarios.json`
  (id + label per scenario) so the PR comment links each `?scenario=` state without a
  hard-coded list.
- **`.github/workflows/demo-preview.yml`** — triggered **on push** (not `workflow_run`),
  so the workflow runs from the pushed branch's own definition and the whole flow is
  testable on the PR that introduces it, before merge. It resolves the branch's open PR,
  builds the demo, commits it to the machine-managed `demo-previews` branch under
  `pr-<n>/`, calls `pages.yml` to redeploy, and posts/updates the sticky
  `<!-- copse-demo-preview -->` comment. Branches without an open PR build nothing.
- **`.github/workflows/pages.yml`** — the deploy job is the single assembler: it lays
  down `site/` **from `main`** then overlays every `demo-previews/pr-*/` directory, and
  exposes a `workflow_call` entrypoint returning `page_url`. Pinning the site to `main`
  means a preview push can only ever change its own `pr-<n>/` subtree, never the site.
- **`.github/workflows/demo-preview-cleanup.yml`** — on PR close, prunes `pr-<n>/` from
  `demo-previews` and redeploys.

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
- **Many _paths_ under the one site are fine.** `copse.dev/`, `copse.dev/demo/`,
  `copse.dev/pr-123/` all coexist; they're just directories in the published tree. That
  is the whole basis of this plan.
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
   hand-edited. Contains only `pr-<n>/` directories, each holding one built `dist/demo`.
   This is the source of truth for "which PR previews are currently live," surviving
   across the whole-tree redeploys that Actions Pages forces.

2. **Assemble-and-deploy job (trusted).** Builds the Pages artifact as
   `site/` (from `main`) overlaid with every `pr-<n>/` from `demo-previews`, then
   publishes via the existing `actions/upload-pages-artifact` + `actions/deploy-pages`.
   Result: `copse.dev/` = marketing site, `copse.dev/pr-<n>/` = that PR's demo. This
   supersedes the current `pages.yml` deploy step (which uploads bare `site/`); the site
   publish becomes a special case of "assemble everything."

3. **Per-PR publish (push-triggered, same-repo by construction).** `demo-preview.yml`
   fires **on push** to any non-`main` branch, so it runs from the pushed branch's own
   workflow definition — which is what makes the flow testable pre-merge. It resolves the
   branch's open PR, builds the demo, commits `dist/demo` to `demo-previews:pr-<n>/`, and
   invokes the assemble-and-deploy job. Safety comes from the trigger itself: only
   same-repo branches can push here (forks push to their own fork and never trigger this
   repo's push workflows), so the write token and deploy never see fork code — no separate
   split-trust stage needed. An earlier design used `workflow_run` for that isolation, but
   `workflow_run` only runs from the default branch, so it could never be exercised before
   merge; the push trigger trades nothing for that isolation given the same-repo-only
   scope, and pinning the site to `main` (component 2) keeps a preview push from touching
   the marketing site.

4. **Cleanup on close.** A `pull_request: [closed]` job removes `pr-<n>/` from
   `demo-previews` and redeploys, so previews don't accumulate forever.

5. **Sticky PR comment.** A new marker (`<!-- copse-demo-preview -->`) posts/updates one
   comment with the base preview URL plus one link per demo scenario (enumerated from the
   shared scenario list, using `?scenario=<id>`). Reuse the list/find/update/create logic
   already in the screenshots comment step so re-pushes update in place rather than
   spamming.

### Deploy serialization

`pages.yml` already sets `concurrency: { group: pages, cancel-in-progress: false }`.
Every preview publish redeploys the whole site, so with many open PRs, deploys queue and
each is a full-tree upload. Correct but not instant — acceptable at this repo's PR
volume. If it ever becomes a bottleneck, the escape hatch is a dedicated external
preview host (Cloudflare Pages/Netlify give native per-PR URLs), explicitly _not_ chosen
here but noted as the pressure-release valve.

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
- **Site pinned to `main`.** The deploy always republishes `site/` from `main`, so a
  preview push can only add or change its own `pr-<n>/` subtree — it can never ship an
  unreviewed change to the marketing site, even though it runs from a feature branch.
- **Open decision — origin isolation.** Previews and the marketing site share the
  `copse.dev` origin (cookie/`localStorage`/`postMessage` scope). Fully isolating them
  (`demo.copse.dev`) requires a _second_ Pages site → a second repo, which contradicts
  the one-repo choice. Flagged for an explicit call: accept shared origin (low risk given
  the site is cookieless and static), or spin up a demos repo later if isolation is
  wanted.

## Milestones

- **P0 — durable store + assembler.** _Done._ `pages.yml` assembles `site/` + `pr-*/`
  into one artifact and tolerates an absent `demo-previews` branch (marketing site
  publishes unchanged with no previews). The branch is created lazily on the first
  publish rather than committed up front.
- **P1 — per-PR publish.** _Done._ `demo-preview.yml` (push-triggered) resolves the
  branch's open PR, builds the demo, commits to `demo-previews:pr-<n>/`, and redeploys.
  Same-repo by construction.
- **P2 — sticky comment.** _Done._ `demo-preview.yml`'s comment job posts/updates
  `<!-- copse-demo-preview -->` with the base URL and per-scenario links.
- **P3 — cleanup.** _Done._ `demo-preview-cleanup.yml` prunes `pr-<n>/` on PR close and
  redeploys.
- **P4 — fork fallback.** _Deferred._ Fork branches get no preview (they never trigger the
  push workflow). Linking the downloadable `dist/demo` artifact for forks remains
  follow-up work.

## Verification and rollout notes

- **Testable pre-merge.** Because publishing is push-triggered, `demo-preview.yml` runs
  from the PR branch's own definition — so pushing this PR exercises the full flow
  (build → `demo-previews` → deploy → comment) and should light up a live preview at
  `copse.dev/pr-<n>/`. The cleanup workflow (`pull_request: closed`) is still read from
  the base branch, so it first runs post-merge.
- **Locally verified before merge:** `build:demo` emits a valid `scenarios.json`; all
  workflow YAML parses and is Prettier-clean.
- **Required repo setting.** The `github-pages` environment's _Deployment branches_ policy
  must permit the feature branch (or be set to "All branches") for a pre-merge preview
  deploy to run without a manual approval gate. Pages source stays "GitHub Actions."
- **Sign-off gate.** Previews are served from the live `copse.dev` origin (shared with the
  marketing site). The site is pinned to `main` so a preview can't alter it, and the demo
  is inert/mocked; the residual shared-origin decision is below. This is the item needing
  an explicit human call.

## Dependencies and open items

- **Depends on** demo-links.md M1's scenario picker for the per-scenario comment links to
  be meaningful (the bare `dist/demo/` already works; richer links improve as scenarios
  land).
- **Origin-isolation decision** (above) — accept shared `copse.dev` origin, or defer a
  `demo.copse.dev` second-repo site.
