// Real release notes for the RunContainer Updates tab (SideStore-style news feed).
// Entries describe what actually shipped in this repository; the current version
// badge is filled in at runtime from package.json via the main process.

export const UPDATES = [
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
