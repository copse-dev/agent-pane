# A user-facing documentation site

Status: **Proposed** — nothing implemented. Prompted by
[docs.openchamber.dev](https://docs.openchamber.dev/) as a format reference.

## Question

Copse has ~7,500 lines of Markdown under `docs/`, a marketing site at `copse.dev`, and no
user manual. Should the docs move to something shaped like OpenChamber's docs site, and if
so, what actually goes on it?

## Verdict

**Adopt the shape; do not move the tree.**

The gap OpenChamber's site closes is not "our docs are badly organised" — it is that _we have
almost no user documentation at all_. Of 40 top-level docs, roughly half are written for a
contributor or for an agent working on this codebase, and the ones that do address a user are
tool-by-tool essays rather than "here is how you do the thing you opened the app to do."
`README.md` carries the entire user manual in about 40 lines.

So the work splits cleanly:

1. **Keep `docs/` where it is.** It is load-bearing: 362 references across the repo, 34
   distinct docs cited from `src/`, `tests/` and `scripts/`, plus `AGENTS.md`. Moving or
   renaming that tree breaks agent navigation for no user benefit.
2. **Write a new user-facing tree** in OpenChamber's shape, publish it under `copse.dev/docs/`,
   and let the existing `docs/` become explicitly what it already is — the contributor and
   design archive.

The valuable part of OpenChamber's format is not VitePress. It is the _discipline_: short
task-shaped pages, a hand-curated sidebar decoupled from the file layout, one-sentence page
descriptions, and troubleshooting as a first-class section rather than an afterthought.

## What OpenChamber actually does

Source lives in `packages/docs/content/docs/` — 41 flat `.mdx` files, one `troubleshooting/`
subdirectory, and nine locale directories. Rendered with VitePress.

**The IA is a separate artifact.** `sidebar.config.json` hand-curates every page into seven
sections; the file tree stays flat. Sections are named for what the reader is trying to do,
not for what the software is made of:

| Section        | Contents                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| Start here     | Overview, Install, Quickstart, OpenCode Server, Environment Variables                                          |
| Workflows      | Projects, Context, Notes/Todos/Plans, Scheduled Tasks, Worktree Sessions, Git & GitHub, Changes Walkthrough, … |
| OpenCode setup | Providers/Models/Agents, MCP Servers, Skills, Skills Catalog, Commands & Snippets, Usage & Quotas              |
| Remote access  | Connect a Device, Private Relay, Tunnels, Reverse Proxy, Mobile Apps & PWA, Security                           |
| Customize      | Themes, Notifications, Voice Mode, Project Icons                                                               |
| Desktop        | Remote Instances, Desktop Browser, Desktop Tunnels, SSH Hosts & Proxying, Updates                              |
| Help           | Troubleshooting + four failure-area sub-pages                                                                  |

**Pages are short.** The entire Quickstart:

```markdown
---
title: Quickstart
description: Start OpenChamber quickly and pick the right app for the task.
---

# Quickstart

## Fastest path

1. Install [OpenCode](https://opencode.ai).
2. Install the OpenChamber CLI (see [Install](/install/) for the one-line command).
3. Run `openchamber --ui-password be-creative-here`.
4. Open the URL the CLI prints (usually `http://localhost:3000`).
5. To use it from your phone, start a [tunnel](/tunnels/) and scan the QR code.

You should see the OpenChamber session list in your browser. If it loads, you're up and running.

Use a strong UI password, especially if you plan to open the instance to the internet.

If the page doesn't load, check [Troubleshooting](/troubleshooting/).

## Which app should I use?

- use **desktop** for day-to-day work on macOS
- use **web** for remote access and reviewing from your phone
- use **VS Code** for sessions right next to your code
```

That is the whole page — 22 lines of body.

Four things worth stealing from that page:

- **Frontmatter `description` is one sentence, and it is a promise about the reader's outcome**
  — "Start OpenChamber quickly and pick the right app for the task," not "Documentation for
  the quickstart."
- **An explicit success check** — "You should see the session list." Our docs describe
  mechanisms; they rarely tell the reader what proves it worked.
- **A bail-out link** to troubleshooting at the point failure is likely.
- **A decision helper** ("Which app should I use?") instead of describing all three and
  leaving the choice to the reader.

The landing page is three lists — _Read this first_ (four links), _Explore_ (annotated links),
and _What OpenChamber is for_ — and nothing else.

**What they do that we should not copy:** nine locales. That is a translation pipeline for a
manual we have not written yet.

## What we have today

40 top-level docs (7,489 lines), 57 plans, 3 spikes, plus `README.md`, `AGENTS.md`,
`SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`. By audience:

| Bucket                                               | Count | Docs                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User-facing material** (raw material for the site) |    20 | `acp-agents`, `acp-setup-guide`, `adding-a-pack`, `packs`, `custom-tools`, `claude-hooks`, `cursor-hooks`, `copse-hooks`, `cursor-plugins`, `forced-planning`, `parallel-search`, `pii-redaction`, `lm-studio-context-persistence`, `privacy-data-flow`, `provider-data-policies`, `recovery`, `remote-agents`, `read-archive`, `video-frames`, `computer-use-tools` |
| **Contributor / architecture** (stays put)           |    11 | `testing-strategy`, `type-safety`, `ui-taste`, `e2e-component-migration`, `steer-evals`, `demo-walkthrough`, `decision-log-format`, `thread-store-format`, `hooks`, `prompt-caching`, `acp-capability-probe`                                                                                                                                                         |
| **Release & ops**                                    |     3 | `release-checklist`, `releasing-macos`, `ci-runner-security`                                                                                                                                                                                                                                                                                                         |
| **Security & point-in-time audits**                  |     6 | `threat-model`, `supply-chain-security`, `security-review-ga`, `product-definition-of-done-audit`, `acp-support-findings`, `acp-v2-readiness`                                                                                                                                                                                                                        |

Two structural observations about the "user-facing" bucket:

- **Most of them open with design rationale, not with the task.** `read-archive.md` begins "A
  zip is the wrong shape for a model twice over"; `video-frames.md` with why nobody watches
  video; `computer-use-tools.md` announces itself as "Design note plus the shipped v1." These
  are good essays. They are not pages someone reads while stuck.
- **They are organised by mechanism, not by job.** There are four separate hooks documents
  (`hooks`, `claude-hooks`, `cursor-hooks`, `copse-hooks`) because there are four hook
  dialects. A user has one question — "how do I run a script when the agent does X?"

And `lm-studio-context-persistence.md` is the exception that proves the format works: symptom
first, bolded, then the fix. It is already a troubleshooting page in everything but location.

**There is no docs site and no link to one.** `site/` is hand-rolled static HTML —
`index.html`, `architecture.html`, `privacy.html`, plus brand fonts and screenshots. Its nav
has no docs entry.

## The gap: what a user can do and cannot read about

Taken from the Settings sections (General, Usage, Agent, Permissions, MCP servers, Sources,
Packs, Appearance, SSH, Experimental) and the ~80 renderer views, these surfaces ship today
with no user-facing documentation anywhere:

| Surface                                                                                                                                                                                   | State                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permissions & approvals** — the approval dialog, batch approvals, read-access outside the sandbox, thread-scoped approvals, guarded-yolo, auto-approval tiers, macOS project sandboxing | **The biggest gap.** This is the product's central claim ("keep meaningful control") and the only prose about it is `threat-model.md`, written for a security reviewer, and a `docs/plans/` entry. A user cannot read what the dialog is asking them. |
| First run — provider setup, scanning the environment for a key, connecting a local server, picking defaults                                                                               | 3 bullets in `README.md`                                                                                                                                                                                                                              |
| Threads — forks, queued messages, drafts, conversation search, rewind, the debug-trace export                                                                                             | Nothing                                                                                                                                                                                                                                               |
| Isolated worktrees per thread                                                                                                                                                             | Nothing (a behaviour change is in `CHANGELOG.md` Unreleased)                                                                                                                                                                                          |
| Panes — Explorer, Shells, Changes, PRs, Memories, Roadmap, Browser; pop-out and expand                                                                                                    | Nothing                                                                                                                                                                                                                                               |
| Editor & attachments — Monaco, selection-to-chat, file/image/video attachments                                                                                                            | `video-frames.md` covers one input                                                                                                                                                                                                                    |
| Semantic search & indexing                                                                                                                                                                | Nothing user-facing                                                                                                                                                                                                                                   |
| Models — picker, per-thread routes, reasoning dial, model comparison, usage and the context wheel, background-task models                                                                 | Nothing                                                                                                                                                                                                                                               |
| Skills                                                                                                                                                                                    | Covered obliquely by `packs.md`                                                                                                                                                                                                                       |
| MCP servers                                                                                                                                                                               | `mcp.json.example` only                                                                                                                                                                                                                               |
| SSH & remote folders                                                                                                                                                                      | Nothing (has its own Settings section)                                                                                                                                                                                                                |
| Subagents, explore, long tasks, supervised tasks, roadmap                                                                                                                                 | Nothing                                                                                                                                                                                                                                               |
| Keyboard shortcuts & command palette                                                                                                                                                      | Nothing                                                                                                                                                                                                                                               |
| Memories / knowledge                                                                                                                                                                      | Nothing                                                                                                                                                                                                                                               |
| Appearance, themes, app icon                                                                                                                                                              | Nothing                                                                                                                                                                                                                                               |
| Updates & channels (stable vs beta)                                                                                                                                                       | `releasing-macos.md` is publisher-side only                                                                                                                                                                                                           |
| Troubleshooting                                                                                                                                                                           | One page (`lm-studio-context-persistence.md`)                                                                                                                                                                                                         |

## Proposed information architecture

Seven sections, mirroring OpenChamber's job-shaped grouping against Copse's actual surface.
Bold = must be written from scratch; the rest have existing material to adapt.

| Section                    | Pages                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start here**             | Overview · **Install** · **Quickstart** · **Connect a model** (cloud key, env scan, local server) · **Choosing a model**                                                                                                          |
| **Working with the agent** | **Threads & forks** · **Attachments** (files, selections, video) · **Plans & forced planning** · **Subagents & explore** · **Long-running and supervised tasks** · **Semantic search** · **Memories**                             |
| **Staying in control**     | **Approvals: what the dialog is asking** · **Permission tiers & auto-approval** · **The project sandbox** · **Isolated worktrees** · **Reviewing edits & diffs** · Privacy and data flow · Provider data policies · PII redaction |
| **The workspace**          | **Panes & layout** (pop-out, expand) · **Editor** · **Terminal** · **Git changes** · **Pull requests** · **Browser** · **Roadmap** · **Keyboard shortcuts & command palette**                                                     |
| **Extending Copse**        | **Skills** · **MCP servers** · Custom tools · Feature packs · Authoring a pack · **Hooks** (one user-facing page fronting the four dialects) · Cursor plugins & imported sources · Parallel Search · Computer-use tools           |
| **Other agents & remote**  | ACP agents · ACP setup (Claude) · Managed remote agents · **SSH workspaces & remote folders**                                                                                                                                     |
| **Help**                   | **Troubleshooting** hub · LM Studio context length · **Provider & key problems** · **Approval and sandbox surprises** · Backup and recovery · **Updates & channels**                                                              |

That is roughly 45 pages, of which ~30 are new writing and ~15 are rewrites of existing docs
into task shape. The four hooks documents collapse into one user page plus the existing
`docs/hooks.md` architecture doc, which stays in the contributor tree.

## Where it would live

**Constraint worth knowing before choosing a tool:** `.github/workflows/pages.yml` is a single
assembler. GitHub Pages allows one deployment per repo and each deploy replaces the whole
published tree, so the job lays down `site/` at the root and mounts every demo preview below
`/demo/`. Docs cannot deploy independently — they have to be assembled into `_site/docs/` by
that same job, from `main`, or be served from a second host entirely.

Recommendation: **generate into `_site/docs/` from the existing Pages job.** One domain, one
deploy path, no new hosting, and the docs inherit the `copse.dev` brand.

On the generator, the honest trade-off — none of this has been prototyped:

| Option                                                     | Cost                                                                                                                                                                       | Note                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| VitePress / Starlight                                      | New Node toolchain, and its default theme does not match `site/`'s hand-rolled brand (Averia Serif, Pliant, custom `styles.css`). Theming is the real cost, not the build. | What OpenChamber uses. Gets search, sidebar, dark mode, anchors for free.      |
| Extend `scripts/build.mts` with a small Markdown→HTML step | Full brand control, no new framework, but we own search, nav and anchors.                                                                                                  | Fits the existing hand-rolled site; the site is currently _copied_, not built. |

Lean VitePress or Starlight if the docs are going to reach ~45 pages, because client-side
search stops being optional at that size. Either way the portable idea is the **curated
sidebar config decoupled from the file tree** — adopt that on day one regardless of generator,
because it is what lets pages be grouped by job while the files stay flat and greppable.

### The direction-of-truth conflict with `site/*.md`

[#1670](https://github.com/copse-dev/agent-pane/pull/1670) landed after this plan was drafted
and settles a convention that points the other way. `scripts/sync-site-markdown.mts` generates
`site/index.md`, `site/architecture.md`, `site/privacy.md` and an `llms.txt` index **from the
HTML**, so an agent fetching the site gets the copy without the chrome. Its stated contract is
that "the HTML is the only source of truth," and `npm run site:md:check` enforces it inside
`npm run check`.

A docs site inverts that: Markdown is authored and HTML is generated. Both directions can
coexist — the marketing pages are hand-built HTML, the docs would be authored prose — but the
plan should not leave two opposite conventions in one tree unremarked. Two consequences:

- **Pick the boundary explicitly.** `site/*.html` stays HTML-source with generated `.md` twins;
  `docs/` pages are Markdown-source with generated HTML. Anything ambiguous (a docs landing
  page that is really marketing) belongs on the marketing side of that line.
- **Docs pages should join `llms.txt`.** The index exists so an agent can find the site's prose;
  a 45-page manual that is not in it is the largest thing missing from the one file built to
  answer that question. Whichever generator wins needs to emit into it.

This also shifts the trade-off table slightly toward extending `scripts/build.mts`: there is now
precedent, machinery, and a `check` gate for site content transformation in `scripts/`, which
did not exist when the two options above were weighed.

## Phasing

- **P1 — Prove the shape.** Generator decision plus five pages: Overview, Install, Quickstart,
  Connect a model, Troubleshooting hub. Wire `_site/docs/` into `pages.yml` and add a docs
  link to the site nav. Nothing moves out of `docs/`.
- **P2 — Close the control gap.** The whole _Staying in control_ section. This is the highest
  value per page in the plan: it is the product's differentiator and it is currently
  undocumented for users.
- **P3 — The workspace and the agent.** Panes, editor, terminal, git, threads, attachments.
  Mostly new writing, mostly screenshot-led — `site/screenshots/` already has 17 usable
  captures.
- **P4 — Adapt the extension docs.** Rewrite the pack/hook/tool docs into task pages; leave the
  architecture originals in `docs/` and link back to them from each page's footer.
- **P5 — Split the trees explicitly.** Add a `docs/README.md` stating that `docs/` is the
  contributor and design archive and that user documentation lives at `copse.dev/docs/`, so
  the next agent does not file a user page into the wrong tree.

## What we deliberately do not take

- **Localisation.** Nine locales is a pipeline for a manual that does not exist yet.
- **Moving `docs/` under a docs package.** 362 inbound references say no.
- **Publishing plans and spikes.** `docs/plans/` is design history with its own status ledger;
  it is valuable precisely because it is not a promise to users.
- **One page per mechanism.** The four-hooks-documents problem is the thing being fixed, not a
  layout to reproduce on a website.

## Open questions

- Does the docs site version with releases, or track `main`? OpenChamber tracks `main`; Copse
  ships stable and beta channels, and permission behaviour has already changed between them.
- Who owns page freshness? `docs/plans/README.md` has an audit date and a status column;
  user docs need an equivalent or they rot silently.
- Does `SUPPORT.md` fold into the Help section or stay as the GitHub-facing entry point?
