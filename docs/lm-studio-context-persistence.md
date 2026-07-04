# Making LM Studio's context length survive a restart

**Symptom:** you set a large **Context Length** on your local model in LM Studio,
everything works, then you reboot (or LM Studio restarts) and the context is back
to a tiny default (often 4096). Copse then shows a **“Low context window”**
advisory and starts trimming agent history early.

This guide explains why that happens and how to make the context length stick,
including a fully restart-proof, scripted setup.

## Why doesn't Copse just reload the model at max context?

It can't do it reliably, so it deliberately doesn't:

- Copse talks to LM Studio over the **OpenAI-compatible `/v1` API**. That API has
  **no “load this model with _N_ tokens of context” call** — it only runs chat
  completions against whatever is already loaded. Copse can _read_ the loaded
  context length (and warns you when it's small), but it can't push a new one in.
- **“The maximum context this machine can handle” is a VRAM/RAM sizing decision**
  that only LM Studio's own loader can estimate safely. Loading a model at its
  catalog maximum (32K, 128K, 1M…) will silently spill to CPU, thrash, or fail to
  load on most machines. Picking that ceiling is LM Studio's job, not Copse's.

So the durable fix is to make your chosen context length part of the model's
**saved configuration in LM Studio**. Do that once and every future load — manual,
auto-load, or on-demand (JIT) — uses it.

## Fix A — Save a per-model default config (simplest)

LM Studio stores load settings _per model_. Bake the context length in once:

1. Load the model (**Chat** or **Developer** tab → select the model).
2. Open its **load settings** (the gear / “Load” panel) and set **Context Length**
   to the value you want. Watch LM Studio's own VRAM estimate as you drag it — stop
   before it warns you'll run out of memory.
3. **Save it as the model's default.** In current LM Studio builds this is the
   **“Save as default configuration”** action in that same settings panel (older
   builds: the gear/overflow menu next to the model in **My Models**). Once saved,
   the model reloads with this context length every time, across restarts.

Verify from Copse: **Settings → Providers → LM Studio → Test connection**. The
context length Copse reports should now match what you set, and the low-context
advisory should disappear.

## Fix B — Load on startup with the `lms` CLI (fully restart-proof)

For a deterministic “after every reboot the model is up at the right context”
setup, drive LM Studio's CLI from a login/startup script. The CLI ships with LM
Studio; enable it once with `lms bootstrap` (or **Developer → Install `lms`**).

```sh
# Start the local server (idempotent; safe to run when already up)
lms server start

# Load a model key at a specific context length, offloading as much as fits on GPU
lms load <model-key> --context-length 32768 --gpu max

# See what's loaded and at what context
lms ps
```

`--context-length` is the load-time context window; `--gpu max` offloads as many
layers as your GPU can hold. Find `<model-key>` with `lms ls`.

Run that at login so it re-applies on every boot:

- **macOS** — a `launchd` LaunchAgent in `~/Library/LaunchAgents/` (or, quick and
  dirty, a “Login Items” shell script) that runs the two `lms` commands above.
- **Windows** — a **Task Scheduler** task triggered **At log on** running a `.bat`
  with the same commands (`lms.exe server start` / `lms.exe load …`).
- **Linux** — a `systemd --user` service (`Type=oneshot`, `WantedBy=default.target`)
  that runs the commands, enabled with `systemctl --user enable`.

This is the most robust option because the context length lives in _your_ script,
not in any LM Studio setting that a future update or profile reset could revert.

## Fix C — Raise the default for on-demand (JIT) loads

If you rely on **Just-In-Time loading** (LM Studio auto-loads a model the first
time an API request names it), set a sane floor so JIT loads don't come up tiny:

- **Developer → Server settings → Just-In-Time model loading** — enable it.
- Set the **default context length for JIT-loaded models** (where available) to at
  least the recommended minimum below. When a model has a saved default config
  (Fix A), JIT uses that; this setting covers models that don't.

## How much context should I aim for?

Copse recommends **at least 16K tokens** for a model used as the main chat/agent
default — below that, tool round-trips and file reads overflow the window and
history gets trimmed aggressively. See `RECOMMENDED_MIN_CONTEXT_WINDOW` in
[`src/shared/context-window-advice.ts`](../src/shared/context-window-advice.ts).

To size a context length against your actual hardware, use a VRAM calculator such
as <https://apxml.com/tools/vram-calculator> — the same link Copse surfaces in the
low-context advisory.

## Checklist

- [ ] Set the context length and **save it as the model's default** (Fix A), or
      script `lms load … --context-length …` at login (Fix B).
- [ ] If you use JIT loading, raise its default context length (Fix C).
- [ ] Reboot, then **Test connection** in Copse and confirm the reported context
      length is what you set and the advisory is gone.
