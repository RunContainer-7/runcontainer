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

## How RunContainer Works

RunContainer lets you install, manage, and run Windows applications inside separate environments managed by RunContainer, rather than running them as ordinary applications directly on your desktop.

### Separate environments for your applications

Each application environment has its own managed files and lifecycle. You can install an application, launch it within its environment, stop it, and remove the environment when you no longer need it.

This makes RunContainer useful for trying unfamiliar software, keeping applications organised, and experimenting without immediately committing to a conventional installation on your main Windows environment.

### Installation and launching

When you install an application, RunContainer attempts to run its installer within the selected environment. Applications are then launched through that environment's execution mechanism rather than being deliberately launched as ordinary host applications.

RunContainer is designed to refuse operations when required isolation cannot be established, rather than silently switching to unrestricted execution.

### Isolation and compatibility

Isolation is intended to separate an application's execution environment from your normal Windows desktop. However, isolation is not a guarantee that every application will work, that every possible interaction with the host is prevented, or that software is automatically safe.

Compatibility depends on the application and the environment available on your system. Some installers and applications may require capabilities that an isolated environment does not provide. Applications that depend on particular drivers, services, hardware access, or elevated system permissions may not work as expected.

### System requirements

RunContainer's available isolation features depend on your Windows edition, system configuration, and the requirements of the selected environment. Some configurations may require additional Windows features, administrator permissions, hardware virtualisation, memory, and disk space.

Check the system requirements and setup guide before creating an environment.

### An important distinction

RunContainer manages isolated application environments; it is not simply a launcher that changes an application's settings or redirects its files. Its goal is to provide a more controlled way to install and experiment with Windows software.

Isolation reduces certain risks but does not eliminate them. Only use software you trust, and do not treat RunContainer as a substitute for security updates, backups, or appropriate precautions when testing untrusted applications.

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



Six bottom tabs are back: Sources, Apps, Tweaks, Settings, Profiles, Info. Tweaks
(launch arguments, VM memory/CPU, guest networking — all validated server-side) and
Profiles (default/relaxed/locked: real network-attachment and capability settings,
enforced at next boot/Reset) were removed by an earlier cleanup and are restored as
backed features, not placeholders. The guest display opens in VMConnect (a separate
supported console window); guest windows are never claimed to be embedded.

App states are Running, Stopped, Failed, and Unknown (RunContainer restarted, or the
guest stopped answering — Run reconciles, Stop attempts a clean stop, Reset reboots).
One run/install/delete/reset operation per environment at a time; concurrent attempts
are refused with a message instead of corrupting state. Installers reporting reboot
codes (3010/1641) record `InstalledNeedsReboot` and direct you to Reset before Run.

No promise is made that an arbitrary installer works unmodified in the guest —
it runs a real Windows, so most do, but guest requirements (drivers,
antivirus, licensing) are the app's own. Window hosting (re-parenting guest
app windows into Electron) is NOT implemented as guest UI integration and is
not claimed; the app's windows appear via the VM's normal display path.

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.
