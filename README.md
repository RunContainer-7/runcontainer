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

## How isolation actually works

RunContainer gives every installed app its own folder, and `Run` starts the app inside an
isolation engine:

- **Windows AppContainer (default, no extra software).** The app is created with an
  AppContainer token through `CreateProcessW` and `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`.
  RunContainer then reads the new process token back and only reports the app as isolated when
  that token really carries the container SID. The container gets write access to the app's own
  folder and the `internetClient` capability; it cannot reach the rest of your profile, registry
  or processes.
- **Sandboxie-Plus box (used automatically when the tools are on PATH or in `SANDBOXIE_HOME`).**
  Sandboxie adds registry isolation and write redirection on top of the filesystem isolation.
- **Unguarded profile mode (opt-in per app, in Manage).** Only `APPDATA`, `LOCALAPPDATA`, `TEMP`
  and `TMP` are redirected into the app folder. This is **not** a security boundary, and the UI
  and app log label every launch in this mode as not isolated.

The app always runs as its own Windows application; RunContainer does not embed or redirect
another program's window, and window placement is unrelated to process isolation.

### Windows inside RunContainer, and what LiveContainer does differently

RunContainer also tries to host the app's window inside its own window, so the app appears to run
"inside" RunContainer. That is **presentation only** and adds no isolation; Windows frequently
refuses to re-parent a window that belongs to a lower-integrity process, in which case the app
opens in its own window and the log says so. Turn it off per app in Manage.

iOS apps like LiveContainer can run a guest app inside the host process because they load the
guest's Mach-O binary as a library. Windows has no supported in-process loader for an arbitrary
PE executable (only DLLs can be loaded that way), so on Windows "inside RunContainer" is always
this combination: a real isolated process (AppContainer or Sandboxie) plus optional window
hosting. RunContainer does not pretend otherwise.

### Deleting an app

`Delete` stops only processes RunContainer can tie to that app (an executable running from its
folder, the recorded launch PIDs, and their descendants). Nothing else is ever terminated, and a
bystander that merely mentions the folder on its command line is never touched. The app is asked
to close first and only force-closed if it does not. RunContainer then resets the folder's ACLs
(root first, because an explicit DENY also denies traversal, then ownership, inherited ACLs and a
full-control grant), clears read-only attributes and removes the tree through the `\\?\` extended
path so deep installer folders are reachable. If Windows still refuses, the error names any
process whose executable or loaded modules come from that folder; for an unrelated holder it
reports the OS error and asks you to retry. The deletion can be cancelled while it is waiting.

If the app ran inside an AppContainer, Delete also removes its container profile with
`DeleteAppContainerProfile` once the processes are confirmed stopped, so the container's
storage under `%LOCALAPPDATA%\Packages\<container name>` goes with it. Windows returns
success for a profile that does not exist, but an open handle inside the container can leave
storage behind; Windows documents that the call should then be retried, so RunContainer logs
the failure and keeps the app listed until Delete succeeds.

Installers and apps that require administrator rights generally cannot run inside a container.
Switch those apps to unguarded profile mode in Manage, and remember that mode does not isolate
them.

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

It needs no administrator rights and only touches its own temp folder. It checks that the
generated launchers parse, that an app really is created inside an AppContainer with a verified
container token, that the profile is removed, that only the app's own processes are stopped while
a bystander survives, and that sandbox deletion really removes read-only files, a DENY-ACL tree, a
path longer than `MAX_PATH`, and a tree with an exclusively locked file (which must fail loudly,
then succeed once released).

The same checks run in CI on a real Windows runner via
`.github/workflows/windows-verify.yml` (unit tests, `scripts/windows-verify.js`, production
build).

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.