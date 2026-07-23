# Terminal-Bench PR #1149 experiment record

Source: [PR #1149](https://github.com/copse-dev/agent-pane/pull/1149), frozen profile
source commit `d993e981a03b7ec62ea96a1add07688dedc0c7a6`.

These historical runs used Terminal-Bench 2.0 and held the model and runtime inputs fixed unless a
row says otherwise: `qwen3.6-35b-a3b` via LM Studio, one attempt, no analyst steering, a 2,048-token
normal stream cap, and a 600-second maximum command timeout. The four tasks were
`cancel-async-tasks`, `circuit-fibsqrt`, `break-filter-js-from-html`, and `chess-best-move`.

These tasks are now a development cohort because their failures guided the interventions. Their 2.0
scores must not be compared directly with Terminal-Bench 2.1 scores or presented as held-out
evidence. A zero remains a failure even when a mechanism changes the trajectory.

| Commit / mechanism                             | Run                                                                             | Result and failure observed                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main` baseline                                | [29919412657](https://github.com/copse-dev/agent-pane/actions/runs/29919412657) | Four tasks, all zero. Cancel reached 5/6 assertions; circuit made no edit; HTML produced the wrong bypass; chess never created `move.txt`.                                                                           |
| `b6a7237c8`, action-oriented guidance          | [29921552045](https://github.com/copse-dev/agent-pane/actions/runs/29921552045) | Four zeros. Cancel was faster but remained 5/6. Circuit made no material edit. Chess still omitted `move.txt`. HTML fabricated `/tests` and treated it as verifier evidence.                                         |
| `c347b281f`, repeat exact output path          | [29923112614](https://github.com/copse-dev/agent-pane/actions/runs/29923112614) | Circuit and chess remained zero and omitted their requested output. Advisory wording alone reached its ceiling.                                                                                                      |
| `d0c6c0761`, bounded `write_file`              | [29924128442](https://github.com/copse-dev/agent-pane/actions/runs/29924128442) | Chess remained zero. It used `write_file` for helpers and notes but still omitted `move.txt`; tool availability did not change finalization intent.                                                                  |
| `c5eb0e575`, persistent output gate            | [29925349604](https://github.com/copse-dev/agent-pane/actions/runs/29925349604) | Regression: 900-second timeout, 70 tool calls, about 1.17M input tokens, and no output. The model ignored the rejection 61 times. Persistent rejection was superseded.                                               |
| `0c699efb2`, provider-forced constrained write | [29927496212](https://github.com/copse-dev/agent-pane/actions/runs/29927496212) | Chess remained zero, but the verifier advanced from a missing file to content validation. The model wrote an unfinished analysis script and then empty content. Schema constraints changed the envelope, not intent. |
| `0c699efb2`, cancel output review              | [29934243978](https://github.com/copse-dev/agent-pane/actions/runs/29934243978) | Cancel remained 5/6. Its self-test used in-process cancellation while the verifier sent SIGINT to a subprocess, isolating a validation-fidelity gap.                                                                 |
| `41fe6b84f`, external-boundary guidance        | [29936346482](https://github.com/copse-dev/agent-pane/actions/runs/29936346482) | Cancel remained 5/6. The model called `Task.cancel()` a KeyboardInterrupt simulation despite explicit guidance.                                                                                                      |
| `b29a8431c`, cancellation warning              | [29938187079](https://github.com/copse-dev/agent-pane/actions/runs/29938187079) | Cancel remained 5/6. A real-SIGINT test caught `BaseException`, allowing caller teardown to mask the same queued-task failure.                                                                                       |
| `6e4279095`, suppression warning               | [29939652212](https://github.com/copse-dev/agent-pane/actions/runs/29939652212) | Regression to 4/6. The replacement stopped using the semaphore; its checker printed success despite an unhandled traceback and asserted only cleanup output.                                                         |
| `c633ac819`, failed-evidence warning           | [29941310392](https://github.com/copse-dev/agent-pane/actions/runs/29941310392) | Cancel returned to 5/6. The model improved its checker and diagnosed the remaining issue, but exhausted its reasoning caps without applying the diagnosis.                                                           |

The capsules were checksum-verified and reviewed with `scripts/debug-terminal-bench.mts`. No
intervention improved official reward. Structured recovery changed trajectories, but further
task-specific nudges would overfit. The exact retained bundle is available only as the
`pr-1149@1` benchmark profile and is not regular-agent behavior.
