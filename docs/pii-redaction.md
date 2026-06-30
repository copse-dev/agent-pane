# PII redaction (experimental)

On-device redaction of personal data in your messages before they leave for a
model provider. Off by default; enable it under **Settings → Experimental → PII
redaction**.

## What it does

When enabled, the text you type is passed through
[Rampart](https://github.com/nationaldesignstudio/rampart) (National Design
Studio, CC BY 4.0) before the prompt is sent to any provider — the local agent,
a remote agent, or an ACP agent. Rampart combines:

- **Synchronous heuristics + validators** for structured identifiers — emails,
  phone numbers, SSNs (structural rules), credit cards (Luhn), IPs, account /
  routing / government-ID / passport / licence numbers, and address components.
- An optional **small ONNX token-classifier** (~15 MB, MiniLM) for contextual
  PII the heuristics can't catch — split names, free-form address lines.

Each detected value is replaced with a stable, typed placeholder
(`[GIVEN_NAME_1]`, `[EMAIL_2]`, …). The same real value always maps to the same
placeholder within a thread, so the model can still reason coherently. The
reverse map lives only in memory in the main process, keyed per thread, and never
crosses the wire.

## Revealing a value

The model only ever sees placeholders. When the agent genuinely needs a real
value — e.g. to write it verbatim into a file — it calls the `reveal_pii` tool.
**Every call prompts you to approve revealing that specific placeholder.** If you
decline, the agent keeps using the placeholder. Approving reveals the value to
the agent and, on its next step, sends it to the provider.

## How it's wired

- `src/main/services/pii-redactor.ts` — loads Rampart (optional dependency,
  indirected import), keeps one guard per thread, exposes `redactUserContent`
  and `revealPlaceholder`.
- `src/main/services/agent-service.ts` — redacts the user prompt (and the derived
  parent goal) at the top of `runAgent`, before any provider path.
- `src/main/tools/reveal-pii-tool.ts` — the approval-gated `reveal_pii` tool,
  registered only while the feature is on (`registry-bootstrap.ts`).
- `piiRedactionEnabled` setting (renderer-writable, default `false`).

## Limitations

- **Fails open.** If Rampart or its model can't load, the prompt is sent
  unchanged rather than blocking the turn — so this reduces exposure, it does not
  guarantee it. If the model can't load but heuristics can, structured PII is
  still redacted with no network.
- **Latin-script only** (en, es, fr, de, it, pt, nl). Other scripts are out of
  scope.
- **Reveal map is in-memory only.** It is intentionally never persisted, so
  placeholders saved in thread history cannot be revealed after an app restart —
  the originals were never written to disk.
- **Input only.** The model's own output is not rehydrated for display, and PII
  the agent reads from repo/tool content is out of scope — this protects what the
  user types, not the whole agent loop.
