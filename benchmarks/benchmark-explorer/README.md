# Copse Benchmarks

Copse Benchmarks turns evaluation artifacts into a searchable static run catalog. It currently
normalizes SkillsBench v1 manifests and extracted Terminal-Bench schema-v2 run manifests, groups
trials by task and profile, flags suspicious low-work or errored trials, and exposes each trial's
trace, verifier state, download, and comparison views.

```sh
pnpm run bench:explore -- \
  --artifacts bench-results/run-a/skillsbench-capsules \
  --artifacts bench-results/run-b/terminal-bench
```

Each `--artifacts` root may contain one or more runs, so repeating the option builds a successive-run
catalog. The command writes `bench-results/benchmark-site/` and serves it on
`http://127.0.0.1:4174`. Pass `--build-only` for a portable static export.

For incremental publication, pass `--append` with only the new artifact root. Copse validates the
existing catalog, replaces an idempotent run with the same stable slug, preserves older run bundles,
and writes the merged catalog last. Without `--append`, the catalog is rebuilt from exactly the
supplied roots.

The generated site keeps summaries small and lazy-loads detail:

- `catalog.json` lists published runs.
- `runs/<run>/index.json` lists that run's trial summaries.
- `runs/<run>/trials/<trial>.json` contains one full trace.

Terminal-Bench inputs may be live result directories or safely extracted capsules containing
`run-manifest.json` and `agent/thread/`. Compressed capsule collections should first be retrieved
through `pnpm run bench:terminal:debug`, which owns digest verification and safe extraction.

The output contains task prompts, model output, reasoning, tool arguments, and results. Treat it
like the source artifacts: promotion to public hosting requires an explicit secrets/privacy review.

The default low-work flag matches the motivating #1310 trial: both fewer than 1,000 input tokens
and fewer than 3 tool calls. Override either floor from the CLI. Flags are diagnostic and never
rewrite the official reward.

Per-step token/cache-read accounting, cost, and full verifier output are not present in every source
harness, so the catalog does not invent them. Source-specific adapters preserve those differences
behind the shared run, trial, and trace schema.
