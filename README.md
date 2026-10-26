# RunContainer

RunContainer is a launcher for Windows apps. Add an app, press **Run**, and it starts from its own folder with its own data — not installed into the rest of your PC. Free forever, no account, no paid tiers, and open source.

It works like LiveContainer does on iOS: a launcher with a container per app, not a virtual machine or an emulator. You can run several copies of the same app with separate data, and remove an app together with everything it kept.

## Download & install

- **New users:** download the latest `RunContainer-Setup-<version>.exe` from the [Releases page](../../releases) or from our website https://runcontainer-7.github.io/9-runcontainer/ and run it.
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

## RC-Brain: its own AI model

RunContainer has a small neural model trained from scratch on its own architecture and failure modes. It is not a cloud chatbot, and it is not a rules table with an AI label.

- **RC-Brain 4** has **9,088 parameters** across two heads: one diagnoses, one chooses an action from a fixed catalogue. It reads 75 structured observation features, including how long a symptom has persisted, whether it recurred, exit-code classes, host pressure and what the specialist agents measured.
- While the app is open it watches running apps every few seconds: window handles, CPU/IO movement, engine liveness, the last 40 log lines and its own repair history.
- It knows 19 RunContainer-specific states, from a missing Microsoft runtime to a trapped VM engine, and abstains when the evidence is weak instead of guessing.
- **It has two tools.** One dispatches fixed specialist agents, once per incident: six read-only evidence probes (engine, window, process, filesystem, logs, setup), then three deterministic reasoning agents — a research agent that searches RunContainer's bundled documentation and the incidents verified on this machine (offline), an expert agent that works the whole documented rule set and names the measurement it is missing, and a harmony agent that resolves a disagreement between the model and the expert, refusing to choose when both rest on equal evidence and equal risk. The other consults the **Runbook**, a hard-coded table of exact documented signatures (Windows errors, setup exit codes) with their meaning. `src/ai/runbook.js` and `src/ai/specialists.js` are ordinary code, not networks: every conclusion is traceable to a document or a measurement.
- The model cannot author an agent, give one arguments, run a command through one, or add a table entry, and nothing either tool concludes bypasses the safety policy: arbitration decides *which* safe thing happens and can never make a decision more destructive than the model's own proposal.
- Low-risk repairs (restart the app, restart its engine, repair its own folder permissions) run automatically. Clearing an app's profile needs approval. It never installs system software, deletes app data, weakens isolation or follows instructions found in logs.
- After a repair it waits for three consecutive observations and re-checks the original condition; a restart alone is not reported as success.
- Evaluation, split by construction: **99.7%** on familiar holdout variants, **90.6%** on whole failure families absent from training, **95.1%** on an untouched final split, **0 unsafe destructive actions** and **0.6%** repairs proposed for normal behaviour (0% on familiar variants). A keyword baseline scores 45.9%, 68.8% and 49.5%. The `consult_runbook` action has no held-out figure, because the held-out splits contain no instance of it; that is stated rather than left out.
- Verified outcomes can be promoted, with consent, into a local curated dataset; training a candidate and activating it are separate, gated offline steps, and the previous model can be rolled back. Monitoring never updates weights by itself.
- If the model is missing or corrupt, the **AI** tab says so and no diagnosis or repair happens. There is no silent rule-based fallback.

Train and verify it locally:

```bash
node scripts/train-ai-brain.js       # retrain + split evaluation (≈6–8 min)
node scripts/promote-model.js --verify  # fail if the active model misses its gates
npm test -- --watchAll=false         # corpus audit, parity, policy, verification, UI
```

The model artefact, feature schema, knowledge specification and evaluation report live in `src/ai/` and `reports/ai-evaluation.md`. Details: the documentation's [RC-Brain page](https://runcontainer-7.github.io/9-runcontainer/guide/ai-brain).

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
├── src/        React interface, RC-Brain model and knowledge specification
├── scripts/    Build, training and verification helpers
├── reports/    Held-out AI evaluation
├── installer/  Installer build files
└── package.json
```

## Releasing

`package.json` is the single source of truth for the version. Cut a release by pushing a matching tag:

```bash
git tag v0.7.6 && git push origin v0.7.6
```

The release workflow tests, builds, and attaches `RunContainer-Setup-<version>.exe` to the GitHub Release. Forks can point the in-app update check at their own releases with `RUNCONTAINER_UPDATE_REPO=owner/repo`.

## Support

If you have an issue with the app, report any bugs, need assistance or just want to ask any questions/feature request, you can either head over to the official documentation website: https://runcontainer-7.github.io/9-runcontainer/, or you can join our support discord server, which included priority support over GitHub Issue: https://discord.gg/UKTGRMMmC4.
Prefer to watch step by step instead? Head over to the official RunContainer YouTube channel and watch some tutorials and showcase of it: https://m.youtube.com/@RunContainer?ra=m

MIT License.
