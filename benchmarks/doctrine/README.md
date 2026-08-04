# Doctrine compliance matrix

This fixture set drives the model-backed prompt-section ablation tracked by
[#744](https://github.com/copse-dev/agent-pane/issues/744). It is trend evidence, not a
merge gate or model leaderboard.

```bash
# LM Studio (default real-model path)
LM_STUDIO_MODEL=<model-id> LM_STUDIO_API_KEY=<key> \
  npm run eval:doctrine -- --provider lmstudio --repeats 3 --sections tools

# Deterministic harness smoke
npm run eval:doctrine -- --provider mock --repeats 1 --sections tools \
  --require-solved --require-doctrine
```

Providers are `lmstudio`, `openai`, `anthropic`, `openrouter`, and `mock`. Cloud providers
read their normal API-key and model environment variables. `--sections` accepts any
comma-separated prompt section id and creates an independent omission arm beside the full
control. The default is `tools`.

Every run creates per-attempt JSONL traces and JSON/Markdown matrix reports under
`bench-results/doctrine/`. The report includes solve rate, overall and per-rule doctrine
pass rates, total input/output tokens, tokens per solve, and deltas against `full`.
Token figures prefixed with `~` are four-characters-per-token estimates because the provider
did not emit usage chunks.

`doctrine-baseline.json` is a reviewed snapshot store keyed by `provider:model`. Update it
only after inspecting a real report:

```bash
npm run eval:doctrine -- --provider lmstudio --repeats 3 --sections tools \
  --update-baseline
```

Task manifests explicitly allow exact shell commands. The harness rejects every other
model-generated command, and all file tools are jailed to a fresh temporary fixture copy.
`mockOnly` tasks prove the runner and are excluded from real-model matrices.
