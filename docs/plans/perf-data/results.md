| Metric | Electron 43.3.0 | Tauri + Servo (release) |
| --- | --- | --- |
| Cold start → renderer booted (wall clock) | 811ms (806–831, n=5) | 912ms (909–915, n=5) |
| Tracer arm → renderer booted | 322ms (317–329, n=5) | 447ms (437–451, n=5) |
| Trace: layout mounted (workspace profiles only) | n/a | n/a |
| Trace: renderer boot span | 20.3ms (19.1–20.8, n=5) | 58.4ms (56.6–58.7, n=5) |
| Trace: main boot complete | 253.7ms (247.2–256.8, n=5) | 265.7ms (260.1–327.3, n=5) |
| Idle memory, whole tree (footprint/PSS) | 240MB (236–248, n=5) | 626MB (511–635, n=5) |
| Idle RSS, whole tree (summed — over-counts sharing) | 616MB (615–617, n=5) | 589MB (518–592, n=5) |
| Idle CPU | 1.2% (0.9–1.2, n=5) | 0.1% (0.1–0.1, n=5) |
| Processes | 5 (5–5, n=5) | 2 (2–2, n=5) |
| Disk footprint (dev tree) | 396MB | 260MB |
