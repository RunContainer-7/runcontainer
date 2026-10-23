// Real release notes for the RunContainer Updates tab (SideStore-style news feed).
// Entries describe what actually shipped in this repository; the current version
// badge is filled in at runtime from package.json via the main process.

export const UPDATES = [
  {
    version: '0.7.2',
    date: '2026-10-23',
    title: 'Every window stays inside RunContainer, without the glitches',
    changes: [
      'RunContainer now keeps watching while an app runs, instead of looking for a window once at launch. Installer wizards that open their real window from a second process, apps that show a splash first, and dialogs that appear later are all hosted as they appear, usually within half a second, so they no longer sit on your desktop.',
      'Fixed the glitchy layout. When a hosted window was resized, RunContainer moved every descendant window it found — including the app’s own buttons, panels and text boxes — which threw the app’s interface apart. Only the window RunContainer actually hosts is moved now, so an app’s controls keep the layout its own code gave them.',
      'Dialogs keep their own size and are centred in the window instead of being stretched edge to edge. Maximised windows are restored before hosting, and windows are hidden while they are moved, so they no longer jump across the screen.',
      'A launched process is no longer confused with the window. RunContainer follows the app’s process tree (an installer that re-launches itself from a temporary folder is still recognised) and also matches windows running from the app’s own folder.',
      'A second RunContainer window only appears when there is something in it: it stays hidden until the first app window is hosted, and it closes when the app ends instead of leaving a blank window behind.',
      'Stopping an app no longer flashes its window on the desktop first; the window disappears with the process it belongs to.',
    ],
  },
  {
    version: '0.7.1',
    date: '2026-10-23',
    title: 'Installer wizards run inside RunContainer, not on your desktop',
    changes: [
      'Installer wizards are now hosted inside RunContainer. Pressing Run on a setup program used to show its wizard as an ordinary desktop window; RunContainer now waits longer for an installer to create its window and hosts it like any other app window, so you complete setup inside the app.',
      'If the main window cannot host it, a second RunContainer window opens and the installer (or the app) is shown there instead, under a RunContainer header with Stop app, Release window and a way back to the main window. Windows can still refuse hosting; when it does, RunContainer says so in that window instead of pretending the app is inside.',
      'Virtual-machine environments are shown in a RunContainer window too. The Hyper-V console (VMConnect) and the QEMU display are hosted there, so a wizard running inside the guest is visible without a stray Virtual Machine Connection window. The guest display opens automatically after a VM launch and before an in-guest install.',
      'Show app window now works for QEMU environments as well as Hyper-V, and it reports whether the window is really shown inside RunContainer or stayed on your desktop.',
      'The Info tab links the RunContainer YouTube channel under Support & documentation, and the documentation support panel does the same.',
    ],
  },
  {
    version: '0.7.0',
    date: '2026-10-23',
    title: 'Performance Engine: quicker launches, honest JIT reporting',
    changes: [
      'Launching is quicker. The launcher’s helper assembly is now compiled once and loaded from disk afterwards instead of being compiled on every Run; measured on this project’s test laptop the time from Run to confirmed containment fell from 712 ms to 563 ms (−21%) and to a reported PID from 637 ms to 493 ms (−23%). The benchmark and its raw samples ship in reports/performance-0.7.0.md.',
      'Background cost is lower. Checking whether an app is still running costs one Windows process query (about 0.64 s), and the monitor used to run it every 1.5 s. It now runs every 5 s, cutting that duty cycle from roughly 40% to roughly 13% while still noticing a closed app within seconds.',
      'Tweaks has a Runtime & JIT card. It reads the selected app’s own executable header: a native Windows program is reported as already compiled machine code, with no JIT strategy offered, because there is nothing for a JIT to translate. Managed .NET programs get a strategy choice (automatic, fast start, or maximum speed) that sets only documented .NET runtime switches at launch. RunContainer’s own Electron/V8 JIT is reported as built in rather than presented as a switch.',
      'Settings shows measured performance: the last launch time, the median of recent launches, the active backend, and the monitor interval. These are observations recorded locally from your own launches, never uploaded.',
      'Fixed containment killing a bootstrapper’s child. When an installer or launcher starts the real program and then exits, its job object used to close immediately, ending that child through kill-on-close. The job now stays alive until its last process exits, so hand-off launchers remain contained instead of being killed.',
      'Launch failures now name the app’s own exit code. “Exited before RunContainer could confirm it (exit code 1)” replaces a message that could not distinguish a crash from an app refusing to run inside a Job Object.',
    ],
  },
  {
    version: '0.6.10',
    date: '2026-10-23',
    title: 'RC-Brain moves into Settings, and the tab bar gets shorter',
    changes: [
      'The AI tab is gone. RC-Brain’s status, held-out results, monitoring switch, repair permissions, verified outcomes and recent diagnoses now live in Settings, below the cards about how apps are kept apart. The monitor’s “last check” line keeps refreshing while Settings is open.',
      'Nothing changed about what RC-Brain may do: the same low-risk repairs still run automatically, clearing an app profile still needs your approval, and the previous model can still be rolled back.',
      'The bottom bar now has seven tabs: Sources, Apps, Tweaks, Settings, Profiles, Info and Updates. The documentation points at Settings for everything RC-Brain.',
    ],
  },
  {
    version: '0.6.9',
    date: '2026-10-22',
    title: 'Upgrades wait for RunContainer to finish closing',
    changes: [
      'Fixed “Setup could not close RunContainer” during an upgrade. Setup now waits up to ten seconds for the old process tree to exit and only reports a problem if the app is still running; before, it checked once after 1.5 seconds and could fail while RunContainer was already closing.',
      'The same wait applies to silent installs and to a crashed copy that is showing an error window, so upgrades no longer stop halfway through.',
    ],
  },
  {
    version: '0.6.8',
    date: '2026-10-22',
    title: 'Policies live in the documentation, not in the launcher',
    changes: [
      'The Policies tab is gone. Terms, privacy, source code and community rules belong with the documentation, where they can be corrected without shipping a new build. Read them at runcontainer-7.github.io/9-runcontainer/policies; the Info tab still opens the documentation site.',
      'The launcher keeps one fewer panel to scroll through, and the bottom tab bar reflects it.',
      'The version shown during the first moment of startup now comes from this build instead of a hard-coded older number.',
    ],
  },
  {
    version: '0.6.7',
    date: '2026-10-22',
    title: 'Updates install cleanly, and the AI tab proves it is watching',
    changes: [
      'Installing over a running copy no longer fails. Setup used to abort with “Setup was unable to automatically close all applications” when RunContainer was open — including a crashed copy showing an error window. It now closes RunContainer itself: silently during an unattended install, and after asking you during a normal one.',
      'Fixed the 0.6.5 startup error for good. That build required a training-only package that packaging removed, so the installed app could stop with “Cannot find module” before opening. 0.6.6 removed that dependency; this release also keeps the installer from failing when an old broken copy is still in memory, which is how 0.6.5 users were getting stuck.',
      'The AI tab now shows the monitor is alive: how many checks it has completed, when the last check ran, and how many running apps it is watching. The heartbeat refreshes while the tab is open instead of showing a snapshot.',
      '“What it may do on its own” is now read from the shipped action catalogue, so the automatic and approval-only repairs listed are exactly the ones this build enforces.',
      'The safety gate no longer applies even a low-risk repair to an app the model just diagnosed as normal: a restart is never a repair for a working app.',
      'Documentation: the download answer and system requirements now describe the current release instead of saying none exists. Installation explains what to do if you are still on 0.6.5.',
    ],
  },
  {
    version: '0.6.6',
    date: '2026-10-22',
    title: 'RC-Brain 2: better evidence, verified repairs, a real learning loop',
    changes: [
      'RC-Brain 2 is a bigger model trained from scratch: 8,334 parameters over 66 structured observation features, 19 diagnoses and 11 actions. It now uses temporal evidence (how long a symptom persisted, recurrences, recoveries), exit-code classes, host pressure, misleading-log signals and contradictory evidence, not one error string.',
      'Repairs are verified independently: after a restart, RC-Brain waits for three consecutive observations and re-checks the original condition. “Verified”, “unresolved” and “inconclusive” are reported honestly; a zero exit code is not treated as success.',
      'A structured experience pipeline records the observation, the prediction, the action and the verified outcome locally, with paths and names redacted. Verified examples can be promoted with consent into a curated dataset; training a candidate and activating it are separate, gated offline steps, and the previous model can be rolled back in the AI tab.',
      'Evaluation is reported by split: 99.6% on familiar holdout variants, 96.8% on whole unseen failure families, 96.5% on an untouched final split, 0 unsafe destructive actions and 0 repairs proposed for normal behaviour. The ambiguous/restraint split is reported separately instead of being averaged into a headline.',
      'The AI tab now shows the model’s real capabilities and limits, the active and previous model files, monitoring health, verified outcomes, pending examples and the learning-loop status. It does not claim continuous learning while only collecting history.',
      'Fixed a startup failure in the 0.6.5 installer: it shipped a main process that required a training-only dependency which packaging pruned, so the app could show a JavaScript error instead of opening. Inference is now dependency-free, and a packaging test fails the build if the shipped runtime requires a pruned package.',
      'Fixed the Electron insecure-CSP warning on every launch, and the window now appears even if the renderer fails before its first paint. Startup failures are logged and explained instead of leaving invisible processes.',
      'New Policies tab: terms of service, privacy, source code and self-hosting, responsible use of apps (no piracy), community conduct, and the fact that RunContainer is free.',
      'Documentation: the installation guide now explains the Windows SmartScreen/Defender warning, how to verify the download and how to inspect or build the source. The FAQ no longer claims there is no official download.',
    ],
  },
  {
    version: '0.6.5',
    date: '2026-10-22',
    title: 'RC-Brain: RunContainer\'s own AI model',
    changes: [
      'RC-Brain 1 is a small neural network (4,229 parameters, two heads for diagnosis and action) trained from scratch on RunContainer\'s own scenarios. It runs locally and makes the diagnosis; a rules table no longer decides what is wrong.',
      'While RunContainer is open it watches running apps: visible windows, CPU and file activity, engine liveness and the live log tail. It abstains when the evidence is weak instead of inventing a cause.',
      'A new AI tab shows the model, its held-out results, a monitoring switch, what it may repair on its own, and recent diagnoses. A diagnosis banner shows the evidence, confidence and chosen action.',
      'Low-risk repairs (restart the app, restart its engine, repair its own folder permissions) run automatically. Clearing an app profile needs approval. It never installs system software, deletes app data, weakens isolation or follows instructions found in logs.',
      'Held-out evaluation: 98.9% diagnosis accuracy, 98.9% action accuracy, 0% false positives on normal behaviour and 0 unsafe actions across 348 unseen scenarios (keyword baseline: 49.7% / 58.6%).',
      'If the model is missing or corrupt, the app says so and monitoring will not diagnose or repair. There is no silent rule-based fallback.',
    ],
  },
  {
    version: '0.6.4',
    date: '2026-10-20',
    title: 'A launcher, not a virtual machine console',
    changes: [
      'The app now describes what it does: each app gets its own space and its own files. Settings no longer shows a backend to pick, and VM setup, prepared images and guest paths are gone from the everyday screens.',
      'Profiles are honest: locked means no network access, and the app tells you plainly when this PC cannot enforce that for a standard environment.',
      'Tweaks no longer offers a networking switch that containment could not honour, and saving tweaks can no longer put a locked app back online.',
      'Apps pinned to a backend can return to Automatic from Manage, and Automatic now stays automatic instead of turning into a VM request.',
    ],
  },
  {
    version: '0.6.3',
    date: '2026-10-20',
    title: 'A tidier launcher with an automatic isolation backend',
    changes: [
      'Settings no longer asks you to handle Windows ISOs, staging disks or base images: RunContainer detects the strongest backend this PC supports and shows it in one line.',
      'The app list is shorter: Manage, Run and Close stay on the row, and Reset, Duplicate, Export, Logs and Delete move into a More menu.',
      'The Info and Manage wording now matches what the app actually does: apps run in a managed VM when one is available, otherwise contained with Job Object caps and a private profile.',
      'Backend overrides and Hyper-V readiness moved behind an Advanced disclosure, so the everyday screens stay short.',
    ],
  },
  {
    version: '0.6.2',
    date: '2026-10-20',
    title: 'Documentation and Discord links in the Info tab',
    changes: [
      'The Info tab has a Support & documentation section: an Open documentation button that opens the official documentation site, and the Discord server as a real link.',
      'The Discord link in the beta notice is now clickable instead of showing the address as plain text.',
      'Links open in your default browser. RunContainer only opens its own documentation, Discord server and GitHub pages, and refuses every other address.',
    ],
  },
  {
    version: '0.6.1',
    date: '2026-10-20',
    title: 'New app icon, applied everywhere',
    changes: [
      'New mark: a mint-green container with a play glyph, shipped as one multi-resolution icon containing every size Windows asks for (16, 24, 32, 48, 64, 128 and 256 px).',
      'The icon now shows on the app window and taskbar, is stamped into the packaged RunContainer.exe, and is used by the installer wizard, Start menu and desktop shortcuts, and the uninstall entry. Before this, the window pointed at an SVG, which Windows silently ignores.',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-10-20',
    title: 'Genuine QEMU virtual machines, update wizard with downloads',
    changes: [
      'RCVM is now a genuine VM backend: per-environment QEMU virtual machines with overlay disks, QMP management, and a guest-agent channel. Verified against real QEMU (WHPX + TCG boot to QMP).',
      'First-run provisioning: install QEMU, create a staging disk, install your own licensed Windows + guest agent in the provisioning VM, then set it as the base image. No OS image is bundled or downloaded.',
      'Update wizard: release notes, in-app installer download with progress, and one-click install over your copy. Remind-tomorrow snooze per version; rate-limit and setup failures are reported, not silent.',
      'Legacy RCVM process containment stays as an explicitly labelled non-VM fallback; Hyper-V full VMs and AppContainer opt-ins are unchanged.',
    ],
  },
  {
    version: '0.5.1',
    date: '2026-10-20',
    title: 'In-app update notices, RCVM containment for every Windows edition',
    changes: [
      'Update notices: the app checks the latest stable GitHub Release and shows a banner with a one-click installer download; the Updates tab has a Check for updates button.',
      'RCVM containment is now the default backend: Job Object lifetime/resource caps with per-app profile folders. Works on Windows 10/11 Home with no admin rights, no reboot, and no guest image.',
      'Hyper-V full VMs stay available as a per-app opt-in for arbitrary software on Pro/Enterprise/Education; AppContainer stays as an explicit opt-in for compatible apps.',
      'Installers for new users are attached to each stable GitHub Release; the docs point there instead of duplicating setup steps.',
    ],
  },
  {
    version: '0.5.0',
    date: '2026-10-18',
    title: 'VM-first Hyper-V isolation, restored tabs, safe deletion',
    changes: [
      'Hyper-V guest VMs are the required execution path: differencing VHDX per environment, PowerShell Direct with guest credential, boot proven by in-guest probe.',
      'Fail-closed launches: VM failures refuse with actionable errors, never silent AppContainer or host fallback.',
      'Restored Tweaks (launch args, VM memory/CPU, guest networking) and Profiles (default/relaxed/locked) as enforced backend settings.',
      'True Reset (guest reboot, data kept) separate from ordered Delete (guest app stop, graceful shutdown, verified disk removal).',
      'Guest display via VMConnect console; per-environment operation locks; Running/Stopped/Failed/Unknown states with reconcile.',
    ],
  },
  {
    version: '0.4.x',
    date: '2026-09',
    title: 'Isolation hardening and store recovery',
    changes: [
      'Removed silent unguarded and Sandboxie launch paths; AppContainer kept as explicit opt-in labeled NOT a VM.',
      'Stale VM/disk records reconciled against Get-VM and the filesystem; restart marks Running entries Unknown.',
      'Deletion guards: launches blocked during delete, base image and sibling environments preserved and verified.',
    ],
  },
  {
    version: '0.3.x',
    date: '2026-08',
    title: 'AppContainer verification and window hosting',
    changes: [
      'AppContainer launches verify the container token SID before reporting isolation.',
      'Experimental window hosting is presentation-only and clearly labeled; failures keep the app in its own window.',
      'Per-app log files for launch, stop, and exit events with a Logs viewer.',
    ],
  },
];
