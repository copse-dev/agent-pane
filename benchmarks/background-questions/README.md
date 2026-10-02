# Background question eval

Background questions are the fixed-choice judgements Copse makes on the user's behalf (see
[`docs/classifier-providers.md`](../../docs/classifier-providers.md#background-questions)). Each
one can be answered by the classifier connection chosen in Settings → Classifiers or by the
small-tasks model. This eval asks both backends the same labelled cases and compares them.

| Question   | Cases                | What a wrong answer costs                                           |
| ---------- | -------------------- | ------------------------------------------------------------------- |
| complexity | 24, 8 per rating     | A misleading badge                                                  |
| category   | 24, 8 per category   | A misleading badge                                                  |
| coverage   | 10 issues × 10 items | A wrong `likely` stops the user importing an issue (counted costly) |
| follow-ups | 14 finished turns    | A distracting bubble, or a missing useful one                       |
| fit        | 12, 4 per verdict    | A wrong `likely` tells the user a prompt will close its issue       |
| review     | 12, 3 per verdict    | A wrong `resolved` invites marking unfinished work done             |

Each arm is asked exactly what the product asks it. The classifier arm runs the product's own
classify functions, so request shape, thresholds and tie-breaking are the shipped ones. The
model arm sends the product's prompts and reads replies with the product's parsers, so an
off-format reply scores as no answer, as it does in the app.

## Running it

A classifier profile file (same format as `pnpm run eval:classifier`) adds the classifier arm; the
model arm uses LM Studio's small-tasks model unless told otherwise:

```bash
pnpm run eval:background-questions -- \
  --classifier-config benchmarks/classifiers/kev.json \
  --model google/gemma-4-e4b \
  --repeats 3
```

| Flag                       | Meaning                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `--questions fit,review`   | Run only these questions (default: all six)                               |
| `--arms classifier`        | Run only these arms (default: `model`, plus `classifier` with a config)   |
| `--classifier-config PATH` | Classifier profile; a bearer key is read from its `apiKeyEnv` variable    |
| `--model ID`               | Model id (default: the LM Studio small-tasks model or `$LM_STUDIO_MODEL`) |
| `--base-url URL`           | OpenAI-compatible or LM Studio endpoint (default: local LM Studio)        |
| `--model-timeout-ms N`     | Override the product's per-question model timeout                         |
| `--repeats N`              | Ask every case N times                                                    |
| `--out-dir DIR`            | Report directory (default: `bench-results/background-questions/<time>`)   |
| `--dry-run`                | Build and schema-check every request and prompt, then stop                |
| `--write-fixtures DIR`     | Write each question's classifier requests as `eval:classifier` JSONL      |

`report.md` has one row per question and arm: correct answers, how often an answer came back at
all, costly mistakes, failed or off-format calls, p50/p95 latency and tokens. It then gives a
confusion matrix for each label question and lists every miss. `report.json` keeps each raw reply.

## Reading the results

The labels are one author's judgement against the wording of each product question; a `note`
explains any label a careful reader could dispute. The cases are synthetic, shaped like Copse's own
backlog, and small. Treat the results as trend evidence for choosing a backend, a model or a
threshold (such as `FOLLOW_UP_PROBABILITY`), not as a merge gate or a general leaderboard. A
difference of one or two cases is noise.
