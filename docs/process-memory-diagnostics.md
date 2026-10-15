# Process memory diagnostics

Launch Copse with `COPSE_DEBUG_PROCESS_MEMORY_OUT=/tmp/copse-memory.json` to record a
rolling report at that exact path. Only the main process writes the report;
workers that inherit the environment variable do not collect diagnostics. The
same report and temporary file are reused across restarts, bounding file count.
Use a separate output path for each concurrently running Copse instance. The
feature is off by default.

The main process samples every 15 seconds even with Process Manager closed. The
report retains 120 samples (roughly 30 minutes), each containing total sampled
RSS, unassigned/shared RSS, process/thread counts, coverage of memory measurements,
and the 20 largest processes by PID and thread ID. It also retains 32 shutdown
observations. Reports are atomically replaced, not appended, and contain no
commands, labels, arguments, paths, environment, or conversation content.

For a reproduction, run 1, 5, 10, then 17 threads. Compare total RSS and thread
count during running, idle, eviction and resumed states. A rising idle baseline
across repeated cycles warrants further profiling; proportional growth with
active threads supports concurrency limiting. RSS totals may count shared pages
multiple times and are not an exact measure of machine memory pressure.

On macOS/Linux, ACP shutdown initiated in the main process records process group members that remain after
the graceful exit and force-kill deadlines, excluding zombies. A nonempty list
is evidence to investigate, not authority to kill those PIDs: PID/group reuse
is possible. Descendants which deliberately leave the original process group,
remote host processes, worker-initiated shutdowns inside sandbox hosts, and
Windows survivors are not covered. Unavailable `ps`
samples are explicitly marked. Shutdown timers are unreferenced and therefore
may not run when the whole app quits. At most 32 shutdown probes are pending;
additional concurrent shutdowns are not recorded. Survivor details cap at 100
PIDs per observation.

Copy reports before restarting or before the rolling window expires. No upload
occurs. Unset the environment variable to disable collection.
