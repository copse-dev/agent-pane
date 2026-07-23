# Per-PR demo previews: clickable demo links on every PR

**Status: Proposed.** This resolves the deliberately-deferred "per-PR distribution"
question from [demo-links.md](demo-links.md) M3. The demo _build_ already exists and
runs in CI on every eligible PR (`npm run build:demo` → `dist/demo/`, plus `test:demo`
in `ci.yml`); the only missing piece is publishing that artifact to a stable,
per-PR URL and surfacing the link on the PR. **Chosen approach: GitHub Pages
subdirectories** (`copse.dev/pr-<n>/`), keeping everything on GitHub rather than
adding an external preview host.

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

3. **Per-PR publish (split trust, mirroring `commit-screenshots`).**
   - _Untrusted stage_ — the existing PR demo job builds `dist/demo` with **no secrets**
     and uploads it as a workflow artifact.
   - _Trusted stage_ — a `workflow_run` job (or the existing trusted screenshot job)
     downloads that artifact, commits it to `demo-previews:pr-<n>/`, and triggers the
     assemble-and-deploy job. Only this stage holds the write token, so untrusted PR code
     never touches secrets or the deploy — the same boundary CI already relies on.

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

- **Same-repo PRs only.** Reuse the existing `head.repo.full_name == github.repository`
  gate: fork PRs get **no** copse.dev preview. Their fallback is the downloadable
  `dist/demo` artifact linked from the comment (the safe default demo-links.md already
  names). This also keeps the write token away from fork code.
- **The demo is inert.** Fully static, mocked `window.api`, no real API calls, no
  secrets, no credentials. The marketing site sets no sensitive cookies on `copse.dev`,
  so a preview subpath has nothing to steal.
- **Trusted deploy stage.** Untrusted PR code only produces static files; committing to
  `demo-previews` and deploying happen in the trusted `workflow_run` context.
- **Open decision — origin isolation.** Previews and the marketing site share the
  `copse.dev` origin (cookie/`localStorage`/`postMessage` scope). Fully isolating them
  (`demo.copse.dev`) requires a _second_ Pages site → a second repo, which contradicts
  the one-repo choice. Flagged for an explicit call: accept shared origin (low risk given
  the site is cookieless and static), or spin up a demos repo later if isolation is
  wanted.

## Milestones

- **P0 — durable store + assembler.** Create the `demo-previews` orphan branch; rewrite
  `pages.yml`'s deploy to assemble `site/` + `pr-*/` into one artifact. Verify the
  marketing site still publishes unchanged with an empty preview set.
- **P1 — per-PR publish.** Wire the split-trust flow: PR job uploads `dist/demo`; trusted
  job commits to `demo-previews:pr-<n>/` and redeploys. Gate to same-repo PRs.
- **P2 — sticky comment.** Post/update `<!-- copse-demo-preview -->` with the base URL and
  per-scenario links; depends on P1's URL being live.
- **P3 — cleanup.** `pull_request: closed` prunes `pr-<n>/` and redeploys.
- **P4 — fork fallback.** For fork PRs, link the downloadable `dist/demo` artifact from
  the comment instead of a copse.dev URL.

## Dependencies and open items

- **Depends on** demo-links.md M1's scenario picker for the per-scenario comment links to
  be meaningful (the bare `dist/demo/` already works; richer links improve as scenarios
  land).
- **Repo settings.** Pages source stays "GitHub Actions" (no change); the only settings
  touch is confirming the `github-pages` environment permissions allow the assemble job
  to deploy.
- **Origin-isolation decision** (above) — accept shared `copse.dev` origin, or defer a
  `demo.copse.dev` second-repo site.
