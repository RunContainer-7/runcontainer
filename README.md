# RunContainer

RunContainer is a launcher for Windows apps. Add an app, press **Run**, and it starts from its own folder with its own data — not installed into the rest of your PC. Free forever, no account, no paid tiers, and open source.

It works like LiveContainer does on iOS: a launcher with a container per app, not a virtual machine or an emulator. You can run several copies of the same app with separate data, and remove an app together with everything it kept.

## Download & install

- **New users:** download the latest `RunContainer-Setup-<version>.exe` from the [Releases page](../../releases) and run it.
- **Installed users:** you don't need to watch releases. When a new stable version is out, the app shows a notice with an **Update…** button, and the Updates tab lists what changed.

Requirements: Windows 10 or 11 (Home works), 64-bit. No admin rights needed.

## What you can do

- **Add an app** with the **+** button: pick an EXE, or import one from a URL.
- **Run / Close** starts and stops the app.
- **Duplicate** makes a second copy with its own separate data — handy for multiple accounts or trying a new version without losing the old one.
- **Reset** returns an app to a fresh state but keeps its data. **Delete** removes the app and its folder.
- **Tweaks** adds launch arguments and memory/CPU limits per app.
- **Profiles** sets how much access an app gets: `default`, `relaxed`, or `locked` (no network).
- **Manage** shows where an app lives, its log, and how its window appears.

## Where apps live

Every app has its own folder under RunContainer's data directory. Its settings, save files and temporary files go there. Duplicate creates a second folder; Delete removes the folder and the app's record.

## Keeping apps apart

Each app starts inside its own managed environment, never loose on your desktop. RunContainer picks the strongest option this PC supports, automatically:

- **Its own space** — the app runs with its own files and processes, memory and CPU limits, and a private app-data folder. This is the default and needs no setup.
- **Its own virtual machine** — if a prepared VM image is already available on the PC, RunContainer uses it for a stronger boundary. Nothing is downloaded, and no Windows licence is included.

Either way, if RunContainer can't establish the environment, it refuses to launch the app rather than run it unprotected.

A `locked` profile asks for no network access. That can only be enforced when the app runs in a virtual machine or a restricted container; on a standard environment Windows gives ordinary apps network access, and the app says so instead of pretending otherwise.

## One honest limit

This is containment, not a sandbox driver. Well-behaved apps keep their files, settings and child processes in their own folder. An app that writes to shared Windows places — the registry, or a system-wide install directory — can still leave traces outside its folder. If it needs a driver, a Windows service, or hardware access, it may not work at all.

Only add software you trust. RunContainer is not antivirus and not a guarantee; keep your normal backups and security software running.

## Updating

When a stable release is out, a notice appears with an **Update…** wizard:

1. **Notes** — your version, the new version, and what changed.
2. **Download** — the exact installer from the release, with progress and size plus checksum verification.
3. **Install & restart** — installs over your current copy, keeping your apps and settings.

**Remind tomorrow** snoozes that version for a day. If the check fails, the Updates tab says why instead of staying silent.

## Build from source

```bash
npm install
npm run build   # bundle the interface
npm start       # open the app
npm test        # run the test suite
```

On Windows you can also double-click `run.bat`, which installs dependencies and opens the app.

## Project layout

```
runcontainer
├── public/     Electron main process and runtime helpers
├── src/        React interface
├── scripts/    Build and verification helpers
├── installer/  Installer build files
└── package.json
```

## Releasing

`package.json` is the single source of truth for the version. Cut a release by pushing a matching tag:

```bash
git tag v0.6.4 && git push origin v0.6.4
```

The release workflow tests, builds, and attaches `RunContainer-Setup-<version>.exe` to the GitHub Release. Forks can point the in-app update check at their own releases with `RUNCONTAINER_UPDATE_REPO=owner/repo`.

MIT License.
