# Thread title prompt eval

This model-backed eval compares the previous title prompt with the current product prompt on
short software-work conversations that reproduce the failure shapes seen in the sidebar:
conversational openings, pasted Markdown, vague first sentences, technical identifiers, prompt
injection, and conversations whose goal changes.

Run it against the local small-tasks model loaded in LM Studio:

```bash
pnpm run eval:thread-titles -- --repeats 3
```

The default model is `google/gemma-4-e4b`. Override it or the local endpoint when testing another
configuration:

```bash
pnpm run eval:thread-titles -- \
  --model qwen/qwen3-4b-2507 \
  --base-url http://127.0.0.1:1234/v1 \
  --repeats 3 \
  --require-candidate-not-worse
```

Use `--case <id>` for one case and `--arms legacy,candidate` to select prompt arms. Reports are
written under `bench-results/thread-titles/` as JSON and Markdown.

The end-to-end score applies the same output cleanup as the product, then requires two to six words,
no conversational or Markdown wrapper, and at least one accepted phrase from every concept group in
the case. The report also records raw-format adherence so prompt improvements remain visible when
cleanup repairs a weak answer. This is trend evidence for prompt/model selection rather than a
merge gate or a general model leaderboard.
