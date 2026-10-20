// Real release notes for the RunContainer Updates tab (SideStore-style news feed).
// Entries describe what actually shipped in this repository; the current version
// badge is filled in at runtime from package.json via the main process.

export const UPDATES = [
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
