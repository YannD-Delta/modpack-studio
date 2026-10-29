# Performance and parallelism

[← README](../README.md) · [Architecture](architecture.md)

## What runs where

| Work | Mechanism |
|---|---|
| Request handling, orchestration | Node event loop (one thread) |
| File system calls | libuv thread pool, raised from 4 to **32** threads by the launcher (`UV_THREADPOOL_SIZE=32`) |
| Hashing jars (sha256) | piscina worker threads |
| Config scan | Async, 16 concurrent reads or directory listings per directory |
| Diff reading | Concurrency 8 |
| Jobs | Up to 4 at once; per-resource lock keys keep two jobs off the same profile |

`UV_THREADPOOL_SIZE` must be set before Node starts: setting it from code is too late. `src/server/threadpool.ts` is imported first in `main.ts` to guard it.

## Lesson: the bottleneck was latency, not CPU

Config instances live on a synced drive. Listing one `kubejs` folder cold took about 100 s, so a full scan took roughly 282 s and sat at 39 % for a long time. The CPU was idle. Fix: issue many reads and listings concurrently, raise the thread pool, and cache inventories. The scan dropped to about 10 s, and later scans of clean and launched profiles are free (cached until a forced rescan).

## Practical rules

- Prefer a quick scan for a first look; run a deep scan when you need certainty.
- Played profiles are rescanned every time on purpose: they change under you.
- If a job shows "session expired", log in again: sessions are in memory and a restart ends them (jobs in flight are marked interrupted).
