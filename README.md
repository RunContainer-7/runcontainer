# RunContainer

RunContainer lets you install, run and manage Windows applications inside separate environments it manages, rather than installing them straight onto your PC.

Each environment keeps an application's files and settings apart from the rest of your system. You can install an app, launch it, stop it, and delete the environment when you no longer need it.

> RunContainer is in beta. There is no official installer or release yet, so you run it from source for now. Isolation reduces the impact an application can have on your PC, but it is not a guarantee. It is not antivirus, and not every Windows application will work.

## Run it on Windows

You need Windows 10 or 11 and [Node.js](https://nodejs.org) (LTS version).

**Easiest:** download or clone this repository, then double-click `run.bat`. The first run installs the dependencies, builds the interface and opens RunContainer.

**Or from a command prompt:**

```
cd runcontainer
npm install
npm run start:desktop
```

`npm run start:desktop` builds the interface before it opens the app, so you don't need a separate build step.

To reinstall dependencies after an update, delete the `node_modules` folder and run again.

## Using RunContainer

- **Apps:** Press **+** to install an application. Choose **Install EXE** to pick an installer from your PC, or **Import from URL**.
- **Sources:** Add an application from a source URL, or install a local EXE.
- **Tweaks:** Set launch arguments, memory, CPU cores and guest networking for an environment.
- **Profiles:** Choose **default**, **relaxed** or **locked** to control what an environment can do.
- **Info:** Read more about the isolation model and beta status.

## Compatibility and safety

- Some installers expect to be installed system-wide, or rely on drivers, services or hardware access. These may not work in an environment.
- Only install software you trust. Applications inside an environment can still see anything you type into them, so sign in only where you trust the software.
- Keep your normal antivirus and backups running.

## Get help and report issues

- **Questions and ideas:** [RunContainer Discord](https://discord.gg/UKTGRMMmC4)
- **Bugs and feature requests:** [Issue tracker](https://github.com/RunContainer-7/runcontainer/issues)
- **Documentation:** [RunContainer docs](https://RunContainer-7.github.io/9-runcontainer/)

## Contributing

Contributions are welcome. Talk through an idea on Discord first if you're not sure, then open an issue or a pull request.

## Project structure

```
runcontainer
├── public/        Electron main process and runtime scripts
├── src/           React interface
├── scripts/       Helper scripts
├── installer/     Installer build files
├── run.bat        Run from source on Windows
└── package.json
```

## Licence

RunContainer is released under the MIT Licence. See [LICENSE](LICENSE).
