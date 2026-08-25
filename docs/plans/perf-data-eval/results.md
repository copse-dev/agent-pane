| Metric | Electron 43.3.0 | Tauri + Servo (release) |
| --- | --- | --- |
| Cold start → renderer booted (wall clock) | 1079ms (951–1115, n=5) | 1402ms (1318–1428, n=5) |
| Tracer arm → renderer booted | 474ms (417–477, n=5) | 850ms (774–886, n=5) |
| Trace: layout mounted (workspace profiles only) | 438ms (398–443, n=5) | 641ms (561–670, n=5) |
| Trace: renderer boot span | 82.6ms (55.9–95.4, n=5) | 295.6ms (191.2–319.8, n=5) |
| Trace: main boot complete | 414.9ms (387.7–853.9, n=5) | 373.7ms (361.3–396.8, n=5) |
| Spawn → scripted turn complete (model-dominated) | 45544ms (32305–52018, n=5) | 35269ms (33487–57711, n=5) |
| Streaming: CPU ms per 1000 chars rendered | 3996.8 (3448.1–5186.7, n=5) | 2684 (2069.7–3519.2, n=5) |
| Streaming: token → frame committed (median) | 52.1ms (46.1–56.5, n=5) | 12.3ms (12.2–12.3, n=5) |
| Streaming: idle frame interval (control for the row above) | 33.3ms (33.3–33.4, n=5) | 38.9ms (36.8–40, n=5) |
| Streaming: time to first token | 30113ms (21827.6–41732.2, n=5) | 18592.6ms (14652.1–46075.4, n=5) |
| Streaming: first token → done | 14303.9ms (8582.8–15080.7, n=5) | 15197.2ms (9312.9–18303.5, n=5) |
| Streaming: tokens rendered | 164 (101–366, n=5) | 183 (118–198, n=5) |
| Streaming: characters streamed | 1888 (1868–1976, n=5) | 2005 (1807–2018, n=5) |
| Streaming: characters actually in the DOM | 1885 (1865–1973, n=5) | 2002 (1805–2015, n=5) |
| Idle memory, whole tree (footprint/PSS) | 391MB (368–445, n=5) | 761MB (647–819, n=5) |
| Idle RSS, whole tree (summed — over-counts sharing) | 673MB (564–772, n=5) | 610MB (574–694, n=5) |
| Idle CPU | 2.4% (2.2–3.3, n=5) | 0.8% (0–0.9, n=5) |
| Processes | 6 (6–6, n=5) | 3 (3–3, n=5) |
| Machine load during run (contamination check) | 1.9 (1.8–2.5, n=5) | 1.6 (1.5–1.9, n=5) |
| Disk footprint (dev tree) | 396MB | 260MB |
