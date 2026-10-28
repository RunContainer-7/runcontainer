# RunContainer

**Download an app, open it inside another app.**

RunContainer is a Windows launcher with its own small desktop. Add a program, press **Run**, and it opens inside a RunContainer window with its own folder for saves and settings — instead of being installed across the rest of your PC.

If you know LiveContainer on iOS, this is the same idea for Windows. No account, no subscription, no virtual machine required, and the source is open.

## Download

Get the latest **`RunContainer-Setup-<version>.exe`** from the [Releases page](https://github.com/RunContainer-7/runcontainer/releases) or from the [website](https://runcontainer-7.github.io/9-runcontainer/), then run it.

- Windows 10 or 11, 64-bit.
- No administrator rights needed for RunContainer itself. Some apps and installers will still ask for permission, and that prompt comes from Windows.
- Installers are not code-signed yet, so Windows may show "Unknown publisher". Only run an installer you downloaded from the links above.

Already installed? You do not have to watch for releases. When a new version is out, the app shows a notice with an **Update…** button and the Updates tab explains what changed.

## Your first app

1. Open RunContainer and press **+**.
2. Pick an `.exe`, or paste a download link in **Sources**.
3. Press **Run**.

A second RunContainer window opens with the app inside it. If the app comes as an installer, its wizard appears in that window too, and the app it produces opens there when setup finishes. You can close that window to stop looking at it, or use its buttons to stop the app or send the window back to your desktop.

## What is in the app

- **Apps** — your apps, each with its real icon. Run, close, duplicate, reset, delete.
- **Sources** — add an app from a URL.
- **Tweaks** — launch arguments, memory and CPU limits, and JIT settings for .NET apps.
- **Profiles** — how much access an app gets, from normal to locked (no network).
- **Settings** — installers, updates, RC-Brain, the beginner tour, and developer mode.
- **Manage** — per app: where it lives, its log, and how its window is shown.
- **Info** — version, links and support.
- **Updates** — what changed and the update button.

## Keeping apps apart

Each app runs in its own managed environment: its own folder, its own saved data, its own process tree with optional memory and CPU limits. Pressing **Duplicate** makes a second copy with separate data. **Delete** removes the app and its folder.

On a PC that supports it, RunContainer can use a stronger boundary — a full virtual machine — when a prepared VM image already exists. Otherwise it uses the managed environment, and it refuses to launch an app it cannot contain rather than starting it unprotected.

One honest limit: this is containment, not a security sandbox driver. A well-behaved app keeps its files and settings inside its folder. An app that writes to shared Windows places like the registry can still leave traces outside it.

## RC-Brain

RunContainer includes a small AI model, **RC-Brain 5**, trained from scratch to watch apps while they run and help when one misbehaves. It looks at what the app is doing, spots common problems, and can restart an app or repair its folder. It asks before doing anything that could remove data, and it says when it does not know.

While RC-Brain is checking an app it can call on specialist helpers — a researcher, an expert and a harmony agent — plus a fixed runbook of known Windows errors. It never installs system software, weakens isolation, or follows instructions found in an app's logs.

You can read the full story on the documentation's [RC-Brain page](https://runcontainer-7.github.io/9-runcontainer/guide/ai-brain).

## Developer mode

Settings has one switch, **Enable developer mode**. It adds a **Virtualise** tab for running a whole operating system on RunContainer's own QEMU backend, plus the technical details behind RC-Brain. It is labelled experimental, because it is. Nothing else about the app changes.

## Updating

When a new stable version exists, the app shows the changes and an **Update…** button that downloads the installer, checks it, installs it over your copy, and restarts. Your apps and settings are kept. **Remind tomorrow** hides that version for a day.

## Support

If RunContainer is useful to you, the easiest way to help is to [star the project on GitHub](https://github.com/RunContainer-7/runcontainer).

- Documentation and guides: https://runcontainer-7.github.io/9-runcontainer/
- Discord, for help and feature requests: https://discord.gg/UKTGRMMmC4
- YouTube, for walkthroughs and demos: https://m.youtube.com/@RunContainer
- Bugs and ideas: [open an issue](https://github.com/RunContainer-7/runcontainer/issues)

## Running from source

For anyone who wants to build it themselves:

```bash
npm install
npm run build
npm start
```

On Windows you can also double-click `run.bat`. The version in `package.json` is the version the whole app uses; releases are cut by pushing a matching tag such as `v0.9.0`.

## License

MIT.
