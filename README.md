# RunContainer

RunContainer runs Windows apps contained: each app gets its own environment folder and always launches inside it — never loose on your system. Free forever, no accounts, no paid tiers.

## Download & install

- **New users:** download the latest `RunContainer-Setup-<version>.exe` from the **[Releases page](../../releases)** and run it. Always get it from a release, never from anywhere else.
- **Installed users:** you don't need to watch releases. When a new stable version is out, the app shows a notice banner with a **Download installer** button, and the Updates tab lists what changed.

Requirements: Windows 10/11 (Home works), 64-bit. No admin rights needed for the default containment.

## QEMU setup (first run)

1. Install QEMU for Windows (https://www.qemu.org/download/) — it is detected, never bundled.
2. Settings → QEMU VM setup → Detect QEMU (WHPX acceleration when available, TCG fallback otherwise).
3. Create a staging disk, boot it with your own licensed Windows ISO, install Windows + virtio drivers + qemu-guest-agent inside the VM window, shut Windows down.
4. Select the staging disk as the base image. Each app then gets its own overlay disk; the base is never modified.

## Updating

When a stable release is out, a notice banner appears with an **Update…** wizard: release notes, installer download with progress, then **Install & restart** (installs over your copy; apps and settings are kept). **Remind tomorrow** snoozes that version for a day. If the check fails, the Updates tab says why (not configured, rate-limited, offline) instead of staying silent.

## Using it

1. **Apps tab, ＋ button:** Install EXE or import from URL.
2. **Run** launches the app contained; **Close** stops it; **Delete** removes it with its folder.
3. **Tweaks tab:** per-app launch arguments, memory cap, CPU share.
4. **Profiles tab:** default / relaxed / locked presets (locked takes network off Hyper-V VMs; RCVM cannot cut network).
5. **Settings tab:** containment overview, Hyper-V readiness check, guest credential setup.
6. **Updates tab:** installed version, changelog, Check for updates.

## How apps are contained

| Mode | What it does | Needs |
| --- | --- | --- |
| **QEMU genuine VM (default)** | Each app runs in its own real virtual machine (overlay disk, guest agent, no virtual network). | Installed QEMU 8+, a provisioned base image from Windows media you own |
| **Hyper-V VM (per-app opt-in)** | The app runs in its own guest Windows VM. For software RCVM can't hold. | Pro/Enterprise/Education, firmware virtualization on, Hyper-V enabled, a sysprepped base image (`RUNCONTAINER_HYPERV_BASE_IMAGE`), one-time guest credential |
| **AppContainer (per-app opt-in)** | Verified container token for compatible apps. Not a VM. | Windows 10/11 |

QEMU VMs have no virtual network by default and are managed over localhost only. Legacy RCVM process containment remains as an explicitly labelled non-VM fallback (it doesn't cut network access). Anything that can't run in a VM refuses to launch instead of running loose.

Hyper-V setup (only if you opt an app into the full VM): enable virtualization in firmware, run as admin `DISM /Online /Enable-Feature /All /FeatureName:Microsoft-Hyper-V`, reboot, build a sysprepped Gen-2 base VHDX, set `RUNCONTAINER_HYPERV_BASE_IMAGE` to its path, then provision the guest credential from Settings.

## Reset vs Delete

`Reset` stops the app and returns the environment to a fresh state, keeping data. `Delete` stops everything and removes the app with its folder. There is no unguarded mode and no Sandboxie backend.

## (Old engineering notes below — kept for developers)

## How isolation actually works now (developer reference)

- **Hyper-V VM (REQUIRED path).** Per-environment VM (`RunContainer-<appId>`,
  differencing VHDX under the environment's `hyperv/` folder, shared base image
  never modified). Install: the installer is staged, copied into the guest
  (`Copy-VMFile`, Guest Service Interface), executed in the guest via PowerShell
  Direct with the provisioned guest credential, and its REAL exit code is waited
  on; the installed guest path is recorded. Run: the app launches in the guest,
  the guest PID is verified in the guest process list, AND the host process table
  is checked for strays (any host execution fails the launch closed). Stop ends
  the guest app (VM kept running for fast relaunch); Delete does the ordered
  lifecycle below. Any VM failure refuses — never AppContainer, never host.
- **AppContainer (OPTIONAL, not a VM, explicit opt-in only).** Profile per app,
  verified token before reporting. Compatible apps only; never selected when VM
  isolation is required and never a fallback.
- **Installers run inside the environment.** `install-in-environment` stages the
  installer into the environment and runs it under the same boundary as the app.
  Installer-spawned children are persisted (`knownPids` + parent-PID lineage), so a
  child that outlives its installer stays tracked for Stop/Delete.
- **Fail-closed everywhere.** Bad paths, missing Hyper-V, token mismatch, and legacy
  `profile`/`sandboxie` selections all refuse with an actionable error. Nothing is
  ever launched without a boundary.

Window hosting (re-parenting the app window into RunContainer) is **presentation
only, experimental, and unverified on Windows**: it adds no isolation, Windows often
refuses it across integrity levels, and it must never be mistaken for the boundary.
Do not claim it works until `scripts/windows-verify.js` + manual testing prove it.

### Deleting an environment

`Reset` and `Delete` are separate. Reset stops the guest app and reboots the guest OS
fresh (verified ready afterwards), keeping the disk, installed apps, and data; for
AppContainer mode it stops processes and drops the container profile. Use Reset after
changing CPU/memory/network tweaks or when the guest is wedged.

`Delete` on a VM environment is ordered and verified: launches blocked
(`deleteJobs` guard + per-environment operation lock) → guest app stopped in-guest (graceful close, 15s, then
force) → graceful guest shutdown with 120s wait for Hyper-V `Off` → power-off
escalation ONLY after timeout (and re-verified `Off` before touching disks) →
`Remove-VM` config with absence verification → remove ONLY this environment's
differencing VHDX (exact-name + inside-env + not-the-base-image validation, 5
unlink retries for the vmms handle window, absence verified) → host files via
`\\?\` extended path → record removed. Success is reported only when the VM
is absent AND the intended files are absent; the base image and sibling envs are
re-verified intact. A leftover lock reports the exact path, error, and recovery
(close antivirus/backup/indexer, run Delete again) — this is why deletion no
longer "locks up Windows": the VM is off and its disk detached before any file
is removed, instead of deleting a live VHDX out from under vmms.

There is no unguarded mode. There is no Sandboxie path.

## Versioning

`package.json` is the single source of truth. Stable releases are tags like `v0.5.1` with the installer attached (see `.github/workflows/release.yml`). The in-app Updates tab only tracks stable releases. Forks: set `RUNCONTAINER_UPDATE_REPO=owner/repo` so the update check reads your releases.

## For developers

- `npm install`, `npm start` (Electron), `npm run build`.
- `npm test`, plus on Windows `node scripts/windows-verify.js`.
- App states: Running, Stopped, Failed, Unknown. One operation per environment at a time.
- Hyper-V internals (differencing disks, PowerShell Direct, VMConnect display) live in `public/hyperv-runtime.js`; RCVM builders in `public/rcvm-runtime.js`; update checks in `public/update-check.js`.

MIT License.