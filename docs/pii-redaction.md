# PII redaction (experimental)

On-device redaction of personal data in your messages before they leave for a
model provider. Off by default; enable it under **Settings → Plugins → PII
redaction** (the `copse.pii-redaction` first-party plugin).

## What it does

When enabled, the text you type is passed through
[Rampart](https://github.com/nationaldesignstudio/rampart) (National Design
Studio, CC BY 4.0) before the prompt is sent to any provider — the local agent,
a remote agent, a plugin model route, or an ACP agent. Rampart has two layers:

- **Synchronous heuristics + validators** for structured identifiers. These
  redact **email addresses, SSNs** (structural rules) and **credit-card numbers**
  (Luhn). They also detect URLs, IP addresses and MAC addresses, which Copse
  deliberately keeps (see below).
- An optional **small ONNX token-classifier** (~15 MB, MiniLM) for contextual
  PII the heuristics can't catch — **names, phone numbers, street addresses**,
  and account / routing / government-ID / passport / licence numbers. It needs
  the `@huggingface/transformers` runtime, which the packaged Copse release does
  not include, so **releases run the heuristic layer only**: names and phone
  numbers are sent as typed. A development checkout that has the runtime
  installed downloads the model on first use and falls back to heuristics if
  that fails.

Each redacted value is replaced with a typed placeholder that carries a random
per-session tag, e.g. `[EMAIL_QJXKT_1]`. Within one app session the same real
value always maps to the same placeholder in a thread, so the model can still
reason coherently. The reverse map lives only in memory in the main process,
keyed per thread, and never crosses the wire.

### What is kept

Rampart is default-deny and keeps only city, state and ZIP code. Copse also
keeps **URLs** (`https://…`, `www.…`) and **IP addresses** (IPv4, IPv6 and MAC
addresses, which Rampart files under the same label). Without this, every link,
`127.0.0.1`, and four-part version number such as `1.2.3.4` would be rewritten,
which breaks ordinary coding requests. Because Rampart resolves overlapping
detections before applying the keep-list, PII embedded _inside_ a URL (for
example an email address in a query string) is kept along with the URL.

## Revealing a value

The model only ever sees placeholders. When the agent genuinely needs a real
value — e.g. to write it verbatim into a file — it calls the `reveal_pii` tool.
**Every call prompts you to approve revealing that specific placeholder.** If you
decline, the agent keeps using the placeholder.

Approving is a real disclosure: the tool result is `[TOKEN] = value`. That
result is part of the conversation, so it is sent to the model provider on the
agent's next step **and saved in the thread's history on disk** like any other
tool result. Only the reverse map itself is memory-only.

## After a restart

The reverse map is not persisted, so placeholders already in a thread cannot be
revealed after Copse restarts. Each app session tags its placeholders
differently, so an old placeholder is refused by `reveal_pii` rather than
resolving to a different value typed later; the same real value typed again
after a restart gets a new placeholder.

## When redaction cannot run

Redaction fails open: if Rampart cannot load, cannot build a guard, or throws
while scrubbing, the message is sent unchanged rather than blocking the turn.
When that happens the turn starts with a notice saying the message was sent
without redaction, and the cause is written to the Copse log. If only the
contextual model is unavailable, the heuristic layer still runs and no notice
is shown.

## How it's wired

- `src/main/services/security/pii-redactor.ts` — loads Rampart (optional
  dependency, indirected import), keeps one guard per thread per app session
  with the Copse keep-list and session-tagged placeholders, and exposes
  `redactUserContent` (returns the redacted content plus a fail-open notice) and
  `revealPlaceholder`.
- `src/main/services/agent-service.ts` — redacts the user prompt in `runAgent`,
  before any provider path, and sends the fail-open notice as a turn notice.
- `src/main/tools/reveal-pii-tool.ts` — the approval-gated `reveal_pii` tool.
- `packages/agent/src/plugins/pii-redaction-plugin.ts` — the plugin manifest,
  its Settings description, and the steering prompt block. The plugin toggle is
  the only switch: it registers the tool (`registry-bootstrap.ts`), appends the
  prompt block (`agent-system-prompt.ts`) and arms the input rewrite. The plugin
  is experimental and ships disabled.

## Limitations

- **Fails open** (see above). This reduces exposure; it does not guarantee it.
- **Heuristic-only in releases.** Names, phone numbers and addresses need the
  contextual model, which is not in the packaged installer.
- **URLs and IPs are kept**, including PII embedded inside a URL.
- **Latin-script only** (en, es, fr, de, it, pt, nl). Other scripts are out of
  scope.
- **Input only.** The model's own output is not rehydrated for display, and PII
  the agent reads from repo/tool content is out of scope — this protects what the
  user types, not the whole agent loop.
