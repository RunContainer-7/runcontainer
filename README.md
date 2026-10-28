# RunContainer

RunContainer is a launcher for Windows apps. Add an app, press **Run**, and it starts from its own folder with its own data — not installed into the rest of your PC. Free forever, no account, no paid tiers, and open source.

It works like LiveContainer does on iOS: a launcher with a container per app, not a virtual machine or an emulator. You can run several copies of the same app with separate data, and remove an app together with everything it kept.

## Download & install

- **New users:** download the latest `RunContainer-Setup-<version>.exe` from the [Releases page](../../releases) or from our website https://runcontainer-7.github.io/9-runcontainer/ and run it.
- **Installed users:** you don't need to watch releases. When a new stable version is out, the app shows a notice with an **Update…** button, and the Updates tab lists what changed.

Requirements: Windows 10 or 11 (Home works), 64-bit. No admin rights needed for RunContainer itself; some apps or installers request administrator approval.

The 0.8.6 installer is named `RunContainer-Setup-0.8.6.exe`. Download it from the Releases page if available; otherwise use the latest published release. Installers are currently unsigned.

When an app needs an installer, RunContainer attempts to show the wizard and its dialogs in a RunContainer window. For recognised installer types, close the wizard and choose **Set up in the background** to try unattended setup; its progress is reported while it runs. RunContainer then looks for an executable inside the environment and attempts to start it. Some installers do not honour unattended switches or install elsewhere. Window hosting is best-effort: Windows may refuse to host certain windows, and system prompts can appear outside RunContainer.

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

## RC-Brain: its own AI model

RunContainer has a small neural model trained from scratch on its own architecture and failure modes. It is not a cloud chatbot, and it is not a rules table with an AI label.

- **RC-Brain 5** has **13,632 parameters** across two heads: one diagnoses, one chooses an action from a fixed catalogue. It reads 75 structured observation features, including how long a symptom has persisted, whether it recurred, exit-code classes, host pressure and what the specialist agents measured. It replaced RC-Brain 4, which had 9,088: the corpus now carries several wordings for each condition instead of one, and the wider pair of networks paid for that variety instead of guessing through it.
- While the app is open it watches running apps every few seconds: window handles, CPU/IO movement, engine liveness, the last 40 log lines and its own repair history.
- It knows 19 RunContainer-specific states, from a missing Microsoft runtime to a trapped VM engine, and abstains when the evidence is weak instead of guessing.
- **It has two tools.** One dispatches fixed specialist agents, once per incident: six read-only evidence probes (engine, window, process, filesystem, logs, setup), then three deterministic reasoning agents — a research agent that searches RunContainer's bundled documentation and the incidents verified on this machine (offline), an expert agent that works the whole documented rule set and names the measurement it is missing, and a harmony agent that resolves a disagreement between the model and the expert, refusing to choose when both rest on equal evidence and equal risk. The other consults the **Runbook**, a hard-coded table of exact documented signatures (Windows errors, setup exit codes) with their meaning. `src/ai/runbook.js` and `src/ai/specialists.js` are ordinary code, not networks: every conclusion is traceable to a document or a measurement.
- The model cannot author an agent, give one arguments, run a command through one, or add a table entry, and nothing either tool concludes bypasses the safety policy: arbitration decides *which* safe thing happens and can never make a decision more destructive than the model's own proposal.
- Low-risk repairs (restart the app, restart its engine, repair its own folder permissions) run automatically. Clearing an app's profile needs approval. It never installs system software, deletes app data, weakens isolation or follows instructions found in logs.
- After a repair it waits for three consecutive observations and re-checks the original condition; a restart alone is not reported as success.
- Evaluation, split by construction: **99.7%** on familiar holdout variants, **92.2%** on whole failure families absent from training, **94.8%** on an untouched final split, **0 unsafe destructive actions** on every split and **0%** repairs proposed for normal behaviour on the final split. A keyword baseline scores 45.3%, 68.8% and 48.1%. Two limits are reported rather than rounded away: a restraint set of 16 cases where the right move is to wait, gather evidence or escalate is answered correctly only 25% of the time — all twelve misses are the same honest scenario, an app that has logged nothing at all yet — and the `consult_runbook` action has no held-out figure, because the held-out splits contain no instance of it.
- Verified outcomes can be promoted, with consent, into a local curated dataset; training a candidate and activating it are separate, gated offline steps, and the previous model can be rolled back. Monitoring never updates weights by itself.
- If the model is missing or corrupt, **Settings** says so and no diagnosis or repair happens. There is no silent rule-based fallback.

Train and verify it locally:

```bash
node scripts/train-ai-brain.js       # retrain + split evaluation (≈6–8 min)
node scripts/promote-model.js --verify  # fail if the active model misses its gates
npm test -- --watchAll=false         # corpus audit, parity, policy, verification, UI
```

The model artefact, feature schema, knowledge specification and evaluation report live in `src/ai/` and `reports/ai-evaluation.md`. Details: the documentation's [RC-Brain page](https://runcontainer-7.github.io/9-runcontainer/guide/ai-brain).

## Developer mode and virtual machines

RunContainer's interface is deliberately plain by default. One switch in **Settings** — **Enable developer mode** — adds the technical detail behind RC-Brain, the launch timings, and an eighth tab, **Virtualise**, which configures and runs a whole operating system on RunContainer's own QEMU backend. The choice is recorded once per installation, survives updates, and changes nothing else about the app: RC-Brain's summaries stay where they were.

**Virtualise** creates a machine with its own virtual disk, memory and CPUs, boots installation media you supply, and draws the guest's screen inside the RunContainer window through an RFB (VNC) client written for the purpose — QEMU never opens a window of its own, and the socket stays in the main process so the window opens no connection itself. It is labelled experimental, and that is honest: frames are uncompressed over loopback, there are no guest additions, integration stops at the keyboard and the mouse, Stop is an immediate power-off, there are no snapshots, and a Windows guest needs the storage driver before setup can see its own disk. No guest operating system and no licence is shipped or downloaded.

Details: the documentation's [Developer mode & VMs page](https://runcontainer-7.github.io/9-runcontainer/guide/developer-mode).

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

## Verify the promise on real Windows

The point of RunContainer is that pressing Run draws the app's window INSIDE a RunContainer window. Unit tests cannot see that, so it is checked by running the real app:

```bash
npm run build
node scripts/windows-host-verify.js      # Run draws the app inside RunContainer
node scripts/windows-verify.js           # isolation, container tokens, deletion on real Windows
npx react-scripts test --testPathPattern vmConsoleLive --watchAll=false   # a guest's screen is really drawn
```

`windows-host-verify.js` installs a test graphical program through the app's own IPC and checks its window and an owned installer-style dialog are visible inside RunContainer. It also exercises background setup with a controlled test installer, verifies its unattended arguments, and checks the installed test app's window is hosted. It checks that a virtual machine left over from a previous session is stopped at startup. The test does not prove every third-party installer is compatible.

`src/services/vmConsoleLive.test.js` does the same for the Virtualise tab's own promise. It boots genuine QEMU with the exact arguments the app builds, connects to the guest with the same RFB client the window uses, and requires real non-blank pixels — a console that connects and draws nothing looks identical to one that works until you look at the pixels, which is how three separate bugs in this path shipped unnoticed. It reports what it measured (on the development PC: a 720x400 guest screen, one raw frame, 1679 lit pixels) and skips, never passes, where QEMU is not installed. All three checks run in CI (`.github/workflows/windows-verify.yml`); the workflow installs QEMU so the console check runs there too.

## Project layout

```
runcontainer
├── public/     Electron main process and runtime helpers
├── src/        React interface, RC-Brain model and knowledge specification
├── scripts/    Build, training and verification helpers
├── reports/    Held-out AI evaluation
├── installer/  Installer build files
└── package.json
```

## Releasing

`package.json` is the single source of truth for the version. Cut a release by pushing a matching tag:

```bash
git tag v0.8.6 && git push origin v0.8.6
```

The release workflow tests, builds, and attaches `RunContainer-Setup-<version>.exe` to the GitHub Release. Forks can point the in-app update check at their own releases with `RUNCONTAINER_UPDATE_REPO=owner/repo`.

## Code signing

**Release installers are not code-signed at the moment.** Windows shows "Unknown publisher", and SmartScreen may warn before the installer runs, so only run an installer downloaded from the [Releases page](../../releases) or the official website.

The release workflow is built for the [SignPath Foundation](https://signpath.io) program, which signs qualifying open-source Windows builds without charge, and its signing steps are skipped until they are configured, so a release publishes unsigned instead of failing. That application was declined for now: the Foundation issues its own certificate only to projects that already show public traction (stars, forks, contributors, outside articles or discussion) and invited a reapplication once RunContainer has more of it.

When a signing service is configured, it signs the installer that workflow built from the tagged commit, on GitHub-hosted runners, and only that file: the signature is read back off it with `Get-AuthenticodeSignature` before it is attached to the release, and the release fails if it is not valid. Every signing request is approved by a person, so a release waits for that approval instead of publishing anything unsigned. Signing needs these repository settings:

- Variable `SIGNPATH_ORGANIZATION_ID` — the service's organization id. Every signing step is skipped while it is empty.
- Variables `SIGNPATH_PROJECT_SLUG` and `SIGNPATH_SIGNING_POLICY_SLUG` — the project and the signing policy that authorises a release.
- Secret `SIGNPATH_API_TOKEN` — the submitter's API token.

A signature identifies who built the file and proves it was not modified afterwards. It is not a promise that Windows stays quiet: SmartScreen reputation builds from clean downloads over time, so a very new version can still prompt.

## Support

If you enjoy RunContainer, please [give the project a star on GitHub](https://github.com/RunContainer-7/runcontainer) to support us.

If you have an issue with the app, report any bugs, need assistance or just want to ask any questions/feature request, you can either head over to the official documentation website: https://runcontainer-7.github.io/9-runcontainer/, or you can join our support discord server, which included priority support over GitHub Issue: https://discord.gg/UKTGRMMmC4.
Prefer to watch step by step instead? Head over to the official RunContainer YouTube channel and watch some tutorials and showcase of it: https://m.youtube.com/@RunContainer?ra=m

MIT License.
