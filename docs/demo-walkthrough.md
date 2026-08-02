# The demo walkthrough and its traces

The browser demo (`npm run build:demo`, published under `/demo/`) can replay a
real agent turn: the composer types a recorded prompt, and the recorded answer
streams back through the app's ordinary chunk path. The marketing homepage
embeds that walkthrough as its hero, so the first thing a visitor sees is the
interface working rather than a screenshot of it having worked.

Nothing about the rendering is special-cased. A trace is fed in as
`StreamChunk`s at provider-ish speed, so the streaming caret, the tool cards
flipping from running to done, and the usage footer all animate because they are
doing their normal job. If the transcript looks wrong in the demo, it looks wrong
in the app.

## The moving parts

| File                                | Role                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| `src/shared/demo-traces.ts`         | `DemoTrace` — a recorded turn: one prompt plus its chunks    |
| `src/shared/demo-traces/<id>.ts`    | Generated trace data (do not hand-edit)                      |
| `src/shared/demo-scenarios.ts`      | `landing` scenario: an empty thread plus the trace to replay |
| `src/renderer/demo/trace-player.ts` | Paces the chunks; slices prose into token-sized pieces       |
| `src/renderer/demo/autoplay.ts`     | Types the prompt into the real composer and presses Send     |
| `scripts/build-demo-trace.mts`      | Thread JSONL export → trace module                           |
| `site/hero-demo.js`                 | Swaps the homepage screenshot for an iframe of the demo      |

## Recording a new trace

1. Have the conversation in Copse. A turn that reads, searches, and then answers
   in Markdown shows the most of the interface; approvals and `ask_user` do not
   replay, because nothing in the demo can answer them.
2. Export the thread as JSONL (thread menu → **Export JSONL**).
3. Convert it:

   ```sh
   npm run demo:trace -- ~/Downloads/<thread>.jsonl --id landing --label "Landing hero"
   ```

   `--turn N` picks a later user turn (default: the first). The emitted module
   is type-checked against `DemoTrace`, so a shape mismatch fails `npm run
typecheck` rather than the published page.

4. **Read the emitted module before committing it.** Traces ship on a public
   marketing page. The converter runs tool results through `redactSecrets` and
   collapses `/Users/<name>` and `/home/<name>` to `~`, but it cannot know which
   file paths, branch names, or repository details you would rather not publish.
5. Rebuild and watch it: `npm run build:demo`, then serve `dist/demo` and open
   `/?scenario=landing`.

Two things the export cannot give back, both visible in the generated module:

- **Order within a message.** The export stores prose and tool calls as separate
  fields; the live stream interleaves them. Each assistant message replays as
  reasoning → prose → tool calls, which is right for the common "explain, then
  act" turn and wrong for one that narrated between tool calls.
- **Token usage.** Usage is recorded per thread, so a usage chunk is only
  emitted when the export holds a single user turn.

## Query flags

`/demo/<branch>/?scenario=landing` accepts:

- `autoplay` — defaults to on for any scenario with a trace; `autoplay=0` opts
  out and leaves an idle app.
- `loop` — replay forever. Each cycle reloads, so state never accumulates.

`prefers-reduced-motion: reduce` drops both the typing and the streaming: the
same transcript appears at once.

## The homepage hero

`site/hero-demo.js` layers an iframe of `/demo/main/?scenario=landing&loop=1`
over the hero screenshot. The screenshot stays in the markup as both the sizer
and the fallback, and the iframe is only revealed once the script can see the
demo's composer inside it — a 404 or an error page fires `load` too, and
revealing on that alone would trade the screenshot for a blank panel. No
scripting, a viewport under 900px, a reduced-motion preference, or a demo that
fails to mount all leave the page exactly as it was.

The frame is inert on the page (`pointer-events: none`, `aria-hidden`,
`tabindex="-1"`): it drives itself, and a scaled-down app is not a usable
control surface. The caption links to the real demo.

Note that `pages.yml` always publishes `site/` from `main`, so a change to the
hero is only live once merged — a PR preview updates `/demo/pr-<n>/` only.
