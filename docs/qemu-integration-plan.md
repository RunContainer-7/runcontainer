# RCVM genuine-VM backend — plan and integration tests

## Implementation plan (from the actual codebase)

- `public/qemu-runtime.js` (new, pure): QEMU discovery candidates, version gate
  (>= 8.0), WHPX/TCG probe builders + result parsing, qcow2 create/overlay/info
  builders, boot-arg builder (`-nic none`, virtio disk, virtio-serial agent
  channel, TCP QMP, pidfile), QMP framing/parsing and guest-agent commands,
  disk-deletion safety validator, per-env paths/ports/pipes.
- `public/main.js` (extended): QEMU store (`runcontainer-qemu.json`),
  discovery + accel probe + `refreshQemuStatus()`, one-shot QMP client,
  `bootQemuEnv` (overlay on read-only base, stale reaping), `waitQemuAgent`,
  `qemuGuestExec` + chunked `qemuTransferFile`, `qemuInstallApp`,
  `runWithQemu`, `monitorQemuApp`, `stopQemuEnv` (agent → ACPI → quit →
  taskkill), `qemuDeleteEnv` (validated disk removal, base untouched),
  `resetQemuEnv` (stop, disk kept). Existing op-locks, logging, and the host
  file-deletion flow are reused, not duplicated.
- `public/engine-select.js`: default/auto → `qemu` when provisioned,
  `qemu-unavailable` with setup guidance otherwise (never silent fallback).
  Legacy `rcvm` process containment stays as an explicitly labelled non-VM
  opt-in; Hyper-V and AppContainer paths untouched.
- UI: Settings reports the backend RunContainer picked (VM when an image is
  present, containment otherwise) in one line; detect, prepared-image select
  and Hyper-V readiness sit under Advanced. Manage keeps the engine override
  and guest-exe-path editor under its own Advanced disclosure. Updates keeps
  the update wizard (notes, download with progress, install & restart).
- Data preserved: old records keep working (undefined engine → QEMU path with
  guidance; `rcvm` records → legacy containment). No migration needed.

## What was proven on real hardware (2026-10-20)

- QEMU 11.0.50 at `C:\Program Files\qemu`, accels `tcg whpx`, displays
  `none gtk sdl egl-headless curses`.
- `qemu-img create -f qcow2` works.
- Node QMP probe: `-accel whpx` and `-accel tcg` both boot to QMP `prelaunch`
  and answer `query-status` (WHPX shows one benign perf-monitoring warning).
- Not proven here: Windows guest install/boot (no guest image on this machine).

## Manual integration matrix (real Windows machine)

1. Fresh Settings → Detect QEMU finds install, reports version + accel.
2. Provision: create staging disk → boot with owned Windows ISO → install
   Windows + virtio drivers + qemu-guest-agent → shut down → set as base.
3. Install an app → confirm it runs in the guest (Task Manager in the VM
   window shows it; host has only `qemu-system-x86_64.exe`).
4. Stop (agent shutdown), restart, Reset (disk kept), Delete (VM + overlay
   gone, base intact, sibling envs intact).
5. Crash: kill QEMU process → Run reconciles, Stop/Reset recover, no orphans.
6. Two envs simultaneously: separate disks, ports, pipes; delete one.
7. Home vs Pro: record accel used; TCG slowness expectations.
8. Missing QEMU / missing base / missing accel: exact actionable errors, no
   silent fallback, legacy mode only via explicit choice.
9. Boundary: `-nic none` default; guest cannot reach host files except the
   explicit installer transfer; QMP bound to 127.0.0.1 only.
10. Update wizard end-to-end against a published release with installer asset.

## Known limitations

- Guest exe path after install is user-confirmed in Manage (installers don't
  reliably report it).
- Installer transfer cap 512 MB; larger media should come from ISO.
- TCG fallback is slow for a Windows desktop guest; WHPX needs the Windows
  Hypervisor Platform feature + firmware virtualization.
