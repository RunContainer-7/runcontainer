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

Conclusion: AppContainer stays for compatible apps; arbitrary software needs the
Hyper-V tier. Both are free and need no third-party paid feature. Sandboxie is not
used as a backend (legacy boxes are only best-effort cleaned on Delete); unguarded
execution was removed entirely.

## How isolation actually works now

- **AppContainer (compatible apps).** Profile per app (`RunContainer.App.<id>`), folder
  ACL grants (modify on the environment, read/execute on ancestors inside
  RunContainer's own root only), `internetClient` capability, verified token before
  reporting. Failure refuses the launch with the Windows error; admin-requiring apps
  are directed to Hyper-V instead of any unguarded mode.
- **Hyper-V VM (arbitrary software).** Per-environment VM (`RunContainer-<appId>`,
  differencing VHDX under the environment's `hyperv/` folder). Install: the installer
  is staged into the environment, copied into the guest, and executed in the guest.
  Run: the app is launched in the guest via PowerShell Direct and the guest process is
  confirmed. Stop ends the VM (disk kept); Delete stops the VM, removes the VM +
  VHDX, then removes host files and the AppContainer profile. No host fallback.
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

`Delete` stops only that environment's processes (executables under its folder, the
persisted launch/installer PIDs, and their descendants — bystanders that merely
mention the path are never touched), asks to close before forcing, stops/removes the
Hyper-V VM if present, repairs ACLs (root reset, ownership, inherited ACLs,
full-control grant) and read-only flags, and removes the tree via the `\\?\`
extended path. Locked files are reported with the holding process where identifiable;
an unrelated lock reports the OS error. The record is removed only after the folder
is confirmed gone; container-profile removal (`DeleteAppContainerProfile`) is
best-effort after processes stop and its warning is surfaced, never silent.

Admin-requiring software cannot run in an AppContainer — use the Hyper-V tier. There
is no unguarded mode anymore.

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

It needs no administrator rights and only touches its own temp folder. It checks: launchers parse; AppContainer launch + verified token + profile delete; boundary evidence (sandbox grants the SID, outside files do not); fail-closed bad launch + refused profile/sandboxie selection; scoping (app stopped, bystander spared); installer lineage tracked after the installer exits; deletion (read-only, DENY-ACL, long path, locked-then-released); and a Hyper-V readiness report (informational on CI, which lacks nested virtualization).

The same checks run in CI on a real Windows runner via
`.github/workflows/windows-verify.yml` (unit tests, `scripts/windows-verify.js`, production
build).

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.