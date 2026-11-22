# Research: the long-chat figures after the transcript was windowed

Date: 2026-11-22 (UTC). Code at `main` eecf68972. This is the work of GU12 (`research/gui-usability-responsiveness-2026-11-21.md` section 3.8). No product code was changed. `bench/perf/webview-chat.mjs` ran as it is; it needed no fix.

## What this note is

PERF11, PERF12, PERF16 and UX60 quote figures from `research/performance-startup-resources.md` section 3.7. Those were taken with every message mounted. Since `39e9d7f73` the transcript mounts only the rows near the viewport (`gui/src/pages/gui/ChatTranscript.tsx`, `chatWindow.ts`), and since #1005 the compaction estimate is not computed while a reply streams. This note runs the same script again and gives every run.

## Method and limits

- Machine: AMD Ryzen 9 9950X3D (16 cores, 32 threads), 126 GB RAM, Windows 11 Pro 10.0.26300.
- Browser: headless Microsoft Edge 158.0.4370.33 driven by playwright-core, 400 by 900 viewport, `--disable-gpu`. This is a desktop browser, not the Electron webview of VS Code.
- The harness build of `bench/screenshots` (the real `<App/>` and store, a mock messenger, packages read from source). No model and no IDE.
- Load: other test runs were using the machine. CPU busy over 3 s before each run: 17.5%, 32.3%, 21.1%, 18.2%, 19.7%. Not an idle machine.
- Five runs, each a new build, a new browser and a new page per size. The table cells give the median and the range.
- The script waits one animation frame after each streamed chunk and each scroll step, so no time below 16.7 ms can be reported. A chunk at 16.8 ms means "within one frame", not "16.8 ms of work".
- The synthetic messages are a short question and a reply with one code block and a list. No tool cards, no long outputs, no math.

Commands, from the repository root:

```sh
node bench/perf/webview-chat.mjs --out "$SCRATCH/run1.json" --sizes 10,100,300,500,1000 --browser edge
# five times, run1.json to run5.json; before each:
powershell -NoProfile -Command "(Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 3 -MaxSamples 1).CounterSamples[0].CookedValue"
```

## Result

Median of five runs (range). "Before" is section 3.7 of the earlier note: two runs, every message mounted. Whether that was the same machine is not recorded there, so compare the shape, not the milliseconds. DOM nodes and editors are counts and do not depend on the machine.

| Messages | Mount (ms)             | Before         | DOM nodes | Before | Editors | Before | Heap growth (MB)    | Before |
| -------- | ---------------------- | -------------- | --------- | ------ | ------- | ------ | ------------------- | ------ |
| 10       | 102.6 (100.9 to 123.7) | 70             | 888       | 727    | 6       | 6      | 22.0 (21.8 to 22.0) | 16     |
| 100      | 171.7 (164.4 to 205.6) | 382 to 386     | 969       | 5,452  | 6       | 51     | 42.8 (42.7 to 42.9) | 54     |
| 300      | 173.4 (165.4 to 178.6) | 975 to 1,045   | 969       | 15,952 | 6       | 151    | 43.4 (43.3 to 43.5) | 209    |
| 500      | 172.4 (167.7 to 188.3) | not measured   | 969       | none   | 6       | none   | 43.9 (43.8 to 44.0) | none   |
| 1,000    | 178.5 (174.4 to 192.8) | 3,342 to 4,153 | 969       | 52,702 | 6       | 501    | 45.3 (45.3 to 45.4) | 562    |

| Messages | Chunk, median (ms)  | Before     | Chunk, p95 (ms)     | Before     | Scroll step, median (ms) | Before   | Scroll step, p95 (ms)  |
| -------- | ------------------- | ---------- | ------------------- | ---------- | ------------------------ | -------- | ---------------------- |
| 10       | 16.9 (16.6 to 17.1) | 16.7       | 18.5 (18.0 to 18.8) | 18         | 16.2 (16.2 to 16.4)      | 16       | 29.1 (28.4 to 30.4)    |
| 100      | 16.9 (16.9 to 17.1) | 25 to 38   | 18.8 (18.7 to 19.9) | 40 to 51   | 39.0 (37.4 to 60.3)      | 16       | 128.6 (94.4 to 155.3)  |
| 300      | 16.8 (16.8 to 16.9) | 67 to 107  | 18.7 (18.4 to 19.1) | 106 to 120 | 143.8 (135.9 to 149.4)   | 17       | 219.7 (202.0 to 233.5) |
| 500      | 16.8 (16.8 to 16.9) | none       | 19.5 (19.0 to 19.9) | none       | 144.5 (140.4 to 145.7)   | none     | 234.4 (217.2 to 275.0) |
| 1,000    | 16.9 (16.6 to 17.0) | 296 to 434 | 19.1 (18.7 to 20.5) | 423 to 552 | 171.7 (161.3 to 197.9)   | 18 to 33 | 294.5 (253.5 to 317.2) |

Reading:

- Mount, DOM size, editor count, heap and the time per streamed chunk no longer grow with the length of the chat from 100 messages up. A chunk takes one frame at every size.
- The scroll step is about 8 times slower than before at 300 messages and 5 to 10 times at 1,000. The script's step is a jump of one twentieth of the transcript (15 messages at 300, 50 at 1,000), so every step lands on rows that are not mounted and mounts a whole window of them: markdown is parsed and highlighted again. This is section 3.5 of the GUI note, now with a number.
- Figures whose range is more than 20% of the median: mount at 10 messages (22%) and at 100 (24%), scroll median at 100 (59%) and at 1,000 (21%), scroll p95 at 100, 500 and 1,000. The rest are within 15%.

## A wheel-sized scroll step (scratch variant, not in the repository)

The script's jump is not what a wheel does. A copy of the script outside the repository scrolled to the end and then up by 100 px, 40 times. Five runs:

| Messages | Step, median (ms)   | Step, p95 (ms)       | Step, max (ms)         |
| -------- | ------------------- | -------------------- | ---------------------- |
| 300      | 31.4 (29.8 to 32.5) | 86.2 (64.7 to 91.4)  | 124.1 (100.6 to 191.9) |
| 500      | 28.6 (21.2 to 30.0) | 67.0 (62.3 to 79.4)  | 101.9 (79.8 to 113.8)  |
| 1,000    | 24.2 (22.5 to 34.7) | 72.6 (62.6 to 116.0) | 80.1 (70.5 to 125.6)   |

A 100 px step takes about two frames at the median and four to five at p95, at any length. Before the windowing the script's larger jump took one frame. The medians at 500 and 1,000 swing by more than 20%.

## What this means for the rows

| Row    | What it said                                                                 | Now                                                                             | Verdict                                                                        |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| PERF11 | Chunk p95 under 50 ms at 300 messages; 106 to 120 ms                         | 18.7 ms (18.4 to 19.1), one frame                                               | The acceptance is met without the work. Dropped                                |
| PERF12 | 501 editors at 1,000 messages                                                | 6 at every size from 10 to 1,000                                                | The count no longer grows. Dropped                                             |
| PERF16 | Choose containment or a virtual list; under 10,000 nodes and 500 ms at 1,000 | A windowed list of our own is built; 969 nodes, 178.5 ms (174.4 to 192.8) mount | The choice is made and the budget is met. Dropped                              |
| UX60   | Measure 500 messages, then `content-visibility`; every message is mounted    | 172.4 ms mount, 969 nodes; rows outside the window are not in the DOM           | Measured; containment has nothing left to contain. Dropped. Scroll is the cost |

## Raw runs

Each row is one size in one run, as the script printed it. Times in ms, heap in MB.

| Run | Messages | Mount | DOM nodes | Editors | Heap | Chunk median | Chunk p95 | Chunk max | Scroll median | Scroll p95 |
| --- | -------- | ----- | --------- | ------- | ---- | ------------ | --------- | --------- | ------------- | ---------- |
| 0   | 10       | 97.5  | 888       | 6       | 21.8 | 17.0         | 18.6      | 19.1      | 15.8          | 29.1       |
| 0   | 100      | 173.1 | 969       | 6       | 42.7 | 16.8         | 19.1      | 20.1      | 39.2          | 123.2      |
| 0   | 300      | 173.2 | 969       | 6       | 43.3 | 16.8         | 19.5      | 19.7      | 139.0         | 190.3      |
| 0   | 500      | 176.8 | 969       | 6       | 44.0 | 16.9         | 18.1      | 18.8      | 148.9         | 221.2      |
| 0   | 1,000    | 180.8 | 969       | 6       | 45.3 | 16.9         | 18.6      | 18.8      | 169.7         | 219.9      |
| 1   | 10       | 102.3 | 888       | 6       | 22.0 | 16.9         | 18.0      | 18.5      | 16.2          | 30.0       |
| 1   | 100      | 164.4 | 969       | 6       | 42.8 | 16.9         | 18.8      | 19.5      | 39.0          | 127.5      |
| 1   | 300      | 176.0 | 969       | 6       | 43.5 | 16.8         | 18.7      | 21.7      | 143.8         | 209.7      |
| 1   | 500      | 167.7 | 969       | 6       | 44.0 | 16.8         | 19.4      | 19.6      | 140.4         | 235.5      |
| 1   | 1,000    | 174.4 | 969       | 6       | 45.3 | 17.0         | 18.7      | 19.4      | 190.3         | 317.2      |
| 2   | 10       | 113.0 | 888       | 6       | 22.0 | 16.6         | 18.4      | 20.5      | 16.3          | 29.1       |
| 2   | 100      | 169.4 | 969       | 6       | 42.9 | 16.9         | 18.8      | 20.4      | 37.4          | 94.4       |
| 2   | 300      | 167.2 | 969       | 6       | 43.3 | 16.8         | 18.4      | 18.5      | 135.9         | 233.5      |
| 2   | 500      | 172.4 | 969       | 6       | 43.9 | 16.9         | 19.6      | 21.0      | 144.5         | 275.0      |
| 2   | 1,000    | 181.8 | 969       | 6       | 45.3 | 16.9         | 20.3      | 21.6      | 197.9         | 253.5      |
| 3   | 10       | 100.9 | 888       | 6       | 22.0 | 16.9         | 18.8      | 19.6      | 16.2          | 28.4       |
| 3   | 100      | 205.6 | 969       | 6       | 42.8 | 17.1         | 18.7      | 22.0      | 51.2          | 155.3      |
| 3   | 300      | 178.6 | 969       | 6       | 43.3 | 16.8         | 18.7      | 19.7      | 143.7         | 224.0      |
| 3   | 500      | 174.2 | 969       | 6       | 43.9 | 16.8         | 19.0      | 20.7      | 142.0         | 217.2      |
| 3   | 1,000    | 178.5 | 969       | 6       | 45.3 | 16.6         | 20.5      | 21.0      | 171.7         | 311.7      |
| 4   | 10       | 102.6 | 888       | 6       | 21.8 | 17.0         | 18.5      | 18.8      | 16.4          | 30.4       |
| 4   | 100      | 171.7 | 969       | 6       | 42.7 | 16.9         | 19.6      | 21.3      | 37.6          | 128.6      |
| 4   | 300      | 165.4 | 969       | 6       | 43.4 | 16.8         | 18.8      | 19.6      | 146.8         | 202.0      |
| 4   | 500      | 169.4 | 969       | 6       | 43.8 | 16.8         | 19.9      | 20.5      | 145.7         | 234.4      |
| 4   | 1,000    | 175.0 | 969       | 6       | 45.4 | 16.9         | 19.1      | 19.8      | 171.5         | 266.8      |
| 5   | 10       | 123.7 | 888       | 6       | 21.9 | 17.1         | 18.6      | 19.3      | 16.2          | 28.9       |
| 5   | 100      | 193.6 | 969       | 6       | 42.7 | 17.1         | 19.9      | 27.7      | 60.3          | 135.1      |
| 5   | 300      | 173.4 | 969       | 6       | 43.4 | 16.9         | 19.1      | 23.3      | 149.4         | 219.7      |
| 5   | 500      | 188.3 | 969       | 6       | 44.0 | 16.9         | 19.5      | 20.3      | 144.8         | 222.0      |
| 5   | 1,000    | 192.8 | 969       | 6       | 45.3 | 16.8         | 19.0      | 20.4      | 161.3         | 294.5      |

Run 0 was a trial to see that the script ran. It is not in the medians or the ranges.

The wheel-sized variant, per run (median, p95, max of 40 steps):

| Run | 300 messages      | 500 messages      | 1,000 messages     |
| --- | ----------------- | ----------------- | ------------------ |
| 1   | 30.6, 75.3, 124.1 | 29.3, 62.3, 107.3 | 30.4, 75.4, 90.9   |
| 2   | 32.5, 91.4, 113.6 | 21.2, 67.0, 81.0  | 24.2, 62.6, 70.5   |
| 3   | 31.4, 64.7, 100.6 | 28.6, 79.4, 113.8 | 23.5, 72.6, 80.1   |
| 4   | 31.8, 86.2, 191.9 | 30.0, 63.9, 101.9 | 22.5, 69.2, 73.0   |
| 5   | 29.8, 90.7, 150.0 | 23.9, 69.2, 79.8  | 34.7, 116.0, 125.6 |

## Not measured

- **VS Code.** The Electron webview, a laptop, or a machine with nothing else running.
- **A figure at 500 messages from before the windowing.** The earlier note has 10, 100, 300 and 1,000 only, so UX60's "before and after" has no "before" at its own size.
- **`content-visibility`.** PERF16 asked for it to be measured first. A windowed list was built instead and it was never measured.
- **Find-in-page, copy across rows and scroll anchoring**, the tests PERF16 names. The script does not look at them. A row outside the window is not in the DOM, so the browser's find cannot reach it.
- **Rows with tool cards, terminal output, diffs or math**, and a reply long enough for its own parse to pass a frame (PERF13).
- **Which part of a scroll step is which**: markdown parse, highlighting, editor mount or layout. A profile of one step would say.
- **What a streamed chunk costs below one frame.** The script cannot report it.
- **Whether the earlier figures came from this machine.**

## Rows that would follow

None is added by this note. The scroll cost has no row: a row that comes back into the window is mounted from nothing. If it is to be tracked, the acceptance is a wheel-sized step in `webview-chat.mjs` (the scratch variant above) with a p95 under two frames.
