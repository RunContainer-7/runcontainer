# README.md

# RunContainer

RunContainer is a Windows-based container management application that allows users to install, run, and manage applications in a sandboxed environment. This project is designed to provide a seamless experience for managing applications without affecting the host system.

## Features

- **File Explorer Integration**: Open a file explorer to select an executable (EXE) file for installation.
- **Container Installation**: Install selected applications into a managed per-app folder.
- **Container Management**: View installed applications with their icons and names, and manage their lifecycle.
- **Sandbox Execution**: Run applications inside a real isolation engine, with the ability to terminate them easily.
- **State Management**: Efficiently manage the state of containers using custom hooks.
- **Responsive Design**: Styled components for a user-friendly interface.

## Project Structure

```
runcontainer
├── public
│   └── index.html
├── src
│   ├── App.jsx
│   ├── main.jsx
│   ├── components
│   │   └── ContainerManager.jsx
│   ├── hooks
│   │   └── useContainers.js
│   ├── services
│   │   └── containerService.js
│   ├── styles
│   │   └── index.css
│   └── utils
│       └── index.js
├── package.json
└── README.md
```

## Installation

1. Clone the repository:
   ```
   git clone <repository-url>
   cd runcontainer
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the application:
   ```
   npm start
   ```

## Usage

1. Launch the application.
2. Click on the "Install EXE" option to open the file explorer.
3. Select the desired EXE file to install it in a sandbox.
4. The installed application will appear in the container list.
5. Click "Run" to start the application inside a container.
6. To return to the Container Manager, simply terminate the running application.

## Architecture decision (audited, not assumed)

RunContainer must isolate arbitrary Windows installers and desktop apps with VM-like
management (install into an environment, run/stop inside it, delete the environment),
with no Sandboxie dependency and no silent unguarded fallback. The committed code was
audited against three options:

- **A. Windows AppContainer (kept, lightweight tier).** Genuine OS boundary: the child
  gets a container token via `CreateProcessW` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`,
  and RunContainer reports `isolated` only when the new process token carries
  `TokenIsAppContainer` (29) **and** the `TokenAppContainerSid` (31) equals the profile
  SID. Free and built into Windows 10/11 (all editions). Limitation, stated openly:
  it was designed for packaged apps. Arbitrary installers routinely fail inside it —
  no administrator rights, no drivers/services, no writes outside container locations,
  low integrity breaks many Win32 apps. It cannot cover the full "arbitrary software"
  range, so it is offered only for compatible apps, fail-closed.
- **B. Hyper-V virtual machine (new, full tier).** The only built-in Windows technology
  that isolates arbitrary installers/desktop software with a VM boundary: separate
  guest OS per environment (differencing VHDX off a base image), installer executes in
  the guest via `Copy-VMFile` + PowerShell Direct `Invoke-Command`, app launches in
  the guest, host only manages the VM. Requirements (not hidden): Windows 10/11
  **Pro/Enterprise/Education** (Home has no Hyper-V), virtualization enabled in
  firmware (Intel VT-x / AMD-V, SLAT), Hyper-V feature + `vmms` running, a sysprepped
  Windows base VHDX (Generation 2, set `RUNCONTAINER_HYPERV_BASE_IMAGE`), admin rights
  for VM/switch setup, and disk/RAM per environment (tens of GB + GBs of RAM).
  If Hyper-V is not ready, Run refuses to launch and names the exact missing piece.
- **C. Other built-in options (rejected as the boundary).** Windows Sandbox is an
  ephemeral lightweight VM (no persistent per-app environments, Pro+ only). Windows
  containers are server-side with no GUI desktop apps. Restricted-token/job-object
  sandboxes (Chrome-style) are real mitigations but share AppContainer's compatibility
  ceiling and are not a VM. A normal child process with redirected env vars is **not**
  isolation and is no longer a launch path. None of these is interchangeable with a
  full VM, and RunContainer does not pretend otherwise.

Required path: the Hyper-V VM. AppContainer stays ONLY as an explicit per-app
opt-in for compatible apps, labeled as NOT a VM and never used as a fallback.
Both are free with no third-party paid feature. Sandboxie is not used as a
backend (legacy boxes are only best-effort cleaned on Delete); unguarded
execution was removed entirely.

## How isolation actually works now

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

`Delete` on a VM environment is ordered and verified: launches blocked
(`deleteJobs` guard) → guest app stopped in-guest (graceful close, 15s, then
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

`package.json` is the single source of truth for the version. npm prints `RunContainer@<version>`
from it, the packaged installers and `electron-builder` artefact names derive from it, Electron's
`app.getVersion()` returns it, and the UI asks the main process for it over IPC instead of
hard-coding a number. Change it in `package.json` and in the two root entries of
`package-lock.json` (`version` and `packages[""].version`) and every place updates together.

## Verifying on Windows

Nothing in the isolation or deletion paths can be verified on Linux. On a Windows machine run:

```
node scripts/windows-verify.js
```

`scripts/windows-verify.js` needs no administrator rights and only touches its own
temp folder: launchers parse; AppContainer launch + verified token + profile
delete; boundary evidence; fail-closed selection; scoping; installer lineage;
host deletion cases; and a Hyper-V PROBE (read-only capability report + static
audits that builders are credential-wired, never assign `$pid`, shut down
graceful-first, select VM-first). CI (`windows-latest`) has no nested
virtualization, so it CANNOT create VMs — the probe passing there proves the
contract statically, not a live VM.

Live-VM proof runs on a capable host only:

```
# elevated PowerShell, base image + credential provisioned (see below)
node scripts/windows-hyperv-full.js
```

It creates two VMs from the base image, proves in-guest installer execution
(guest-written marker) and in-guest launch (guest PID in-guest, payload absent
on host), deletes one environment in order (VM absent, env disk absent, sibling
+ base intact), exercises a locked host file, and cleans up.

## Provisioning a host for VM isolation (do this on your Windows PC)

1. **Host OS:** Windows 10/11 Pro, Enterprise, or Education (Home has no
   Hyper-V). Firmware virtualization on (Intel VT-x / AMD-V, SLAT).
2. **Enable Hyper-V** (elevated): `DISM /Online /Enable-Feature /All
   /FeatureName:Microsoft-Hyper-V`, reboot, ensure `vmms` is Running.
3. **Base image:** build a reference VM (Gen 2, Windows 10/11 Pro/Enterprise),
   install guest Windows + updates + Hyper-V Integration Services, create the
   local admin account the guest credential will use, `sysprep /generalize
   /oobe /shutdown`, then copy its VHDX aside as the read-only base, e.g.
   `C:\VMs\base\win11-sysprepped.vhdx`. Set
   `RUNCONTAINER_HYPERV_BASE_IMAGE` to that path. Keep one licensed guest per
   base image: each environment is a differencing child of it, and guest
   Windows licensing follows your Microsoft license terms (check them for
   virtualization use).
4. **Guest credential:** RunContainer Settings → provision (or the
   `hyperv-provision-credential` IPC): shows `Get-Credential` once and stores
   it DPAPI-encrypted at `%APPDATA%\RunContainer\hyperv-guest-cred.xml`
   (same user, same host only). PowerShell Direct requires it.
5. **Network:** RunContainer ensures an Internal switch (`RunContainer-NAT`)
   idempotently; guest file copy and PowerShell Direct do not need a NAT, and
   no host folder sharing is configured (verify: no `New-SmbShare`/enhanced
   session file sharing is created by these scripts).
6. **Per environment:** ~20–40 GB disk for the differencing VHDX growth +
   4 GB RAM default. Delete removes the VM config + env VHDX only.

No promise is made that an arbitrary installer works unmodified in the guest —
it runs a real Windows, so most do, but guest requirements (drivers,
antivirus, licensing) are the app's own. Window hosting (re-parenting guest
app windows into Electron) is NOT implemented as guest UI integration and is
not claimed; the app's windows appear via the VM's normal display path.

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.