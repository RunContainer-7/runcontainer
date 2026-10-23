# RunContainer 0.7.0 — measured launch performance

Every number in this report was produced by `scripts/benchmark-launch.js` on the
machine below. Nothing here is estimated, extrapolated from a different machine,
or taken from a single run.

## Environment

| | |
| --- | --- |
| OS | Windows 10 (build 10.0.19045) |
| CPU | Intel Core i5-6440HQ @ 2.60 GHz, 4 logical processors |
| RAM | 8 GB |
| Shell used by the launcher | Windows PowerShell 5.1 |
| Backend | RCVM containment (Job Object caps + per-app profile) |
| Date | 2026-10-23 |

The benchmark launches `cmd.exe /c exit 0` through the real launcher, so it
measures RunContainer's launch path rather than an application's own startup.

## Method

`node scripts/benchmark-launch.js --runs N` measures, per run:

- **build** — generating the launcher script (pure JavaScript).
- **pid** — spawn until the launcher reports the started process ID.
- **verify** — spawn until the job membership and limits are verified.
- **exit** — spawn until the started process has exited and the launcher has
  reported its exit code.

It also times one Windows process-table query, which every launch and every
monitor tick performs. Medians are reported, plus min/max and every raw run.
`--no-cache` reproduces the 0.6.x launcher, which compiled its C# helper on
every launch.

## Results

Five runs each, same machine, same command, alternating only the launcher cache:

| Measurement | Before (compile every launch) | 0.7.0 (cached assembly) | Change |
| --- | ---: | ---: | ---: |
| Spawn → PID reported | 637 ms | 493 ms | −23% |
| Spawn → containment verified | 712 ms | 563 ms | −21% |
| Spawn → process exit reported | 1084 ms | 911 ms | −16% |
| Process-table query (unchanged) | 659 ms | 620 ms | within noise |

A separate seven-run series with the cache gave medians of 514 ms → PID,
586 ms → verified, and 929 ms → exit, with the first (cold-cache) run included.
The spread across runs was 489–613 ms to PID; the machine was otherwise idle but
is an ordinary laptop, so treat the medians as the useful figure, not the best
run.

## Monitoring overhead

One process-table query costs about 0.64 s. The 0.6.x monitor ran that query
every 1.5 s, which kept a PowerShell process busy for roughly 40% of the time an
application was open. 0.7.0 polls every 5 s, cutting that to roughly 13% while
still noticing a closed app within a few seconds. This is a CPU-overhead
reduction, not a launch-speed claim.

## What was not measured

- **Hyper-V and QEMU cold/warm VM startup.** No guest image was provisioned on
  this machine, so no VM figure is reported. They remain unmeasured rather than
  estimated.
- **Application readiness.** Timings stop when containment is confirmed, not when
  the application has drawn its first window. A Qt installer, for example, does
  further work after that point.
- **Steady-state memory of running applications.** Not instrumented in this
  release.
- **.NET JIT strategies.** No managed sample application was available to
  measure, so the runtime strategies are offered as documented runtime
  behaviour, not as a measured speedup.

## Reproducing

```powershell
node scripts/benchmark-launch.js --runs 7
node scripts/benchmark-launch.js --runs 7 --no-cache
```

The script prints progress on stderr and a JSON report on stdout, including the
machine description and every raw sample.
