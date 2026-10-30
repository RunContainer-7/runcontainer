import React, { useEffect, useMemo, useState } from "react";

// The beginner introduction.
//
// Why it exists: RunContainer's own idea is unusual — an app that opens other apps
// inside itself — and a new user's first minute decides whether that idea lands. This
// walks through it in ten steps (0/9 … 9/9): the idea, how a run works, what each tab
// is for, and where to get help.
//
// It is shown once per installation and never again, including after an update: the
// flag it reads and writes lives in an app-wide preferences file (see the
// get-preferences / set-preference handlers in public/main.js), not on an app record
// and not on the version. An installation that already had apps before this existed
// still sees it once, because the flag starts absent.
//
// Everything in here describes what the interface really does. Where a limit exists
// (a window Windows will not let RunContainer hold, a registry write an app can make
// in a shared place), the step says so instead of overselling the product.

const GH_URL = "https://github.com/RunContainer-7/runcontainer";
const DOCS_URL = "https://runcontainer-7.github.io/9-runcontainer/";
const DISCORD_URL = "https://discord.gg/rvMjMZJykE";
const YOUTUBE_URL = "https://www.youtube.com/@RunContainer";

function stepsFor(version) {
  return [
    {
      key: "what",
      title: "RunContainer is an app that opens other apps inside itself",
      lead:
        "You add a Windows app, press Run, and it starts with its own folder and its own data — "
        + "kept together instead of scattered through the rest of your PC.",
      bullets: [
        "Adding an app does not install it into Windows. RunContainer makes it its own folder and runs it from there.",
        "Each app keeps its own files, settings and limits, so one app's changes stay away from your other apps.",
        "Removing an app removes its managed folder with it, instead of leaving pieces behind in several places.",
      ],
      note: `You are using RunContainer ${version || ""}`.trim(),
    },
    {
      key: "run",
      title: "How an app runs inside the app",
      lead:
        "Press Run and the app's window opens inside a RunContainer window, with its own header keeping "
        + "Stop, Release window and RunContainer reachable while the app is open.",
      bullets: [
        "The app's first window is moved inside RunContainer before it is ever drawn on your desktop.",
        "If the file you added is an installer, RunContainer runs that setup inside the environment first: "
          + "either unattended in the background — where this same window reports its progress and the app starts "
          + "as soon as setup finishes — or as a wizard inside a RunContainer window when an installer has no "
          + "documented unattended mode.",
        "One honest limit: a few installers run at a higher privilege than RunContainer, and Windows will not let "
          + "their window be moved. RunContainer says so when that happens and the app keeps its own window. "
          + "Whether a window is hosted here or not never changes how the app is isolated.",
      ],
      note: "Close or Stop ends the app and everything it started.",
    },
    {
      key: "updates",
      title: "Updates",
      lead: "Keeps RunContainer itself current.",
      bullets: [
        "It shows the version you have, checks GitHub Releases, and tells you what the check found.",
        "When a newer version in your release channel exists, you get the release notes, a download with progress, and the installer runs over your copy.",
        "Remind tomorrow snoozes that version for a day. This check only reads the release feed; it never installs anything by itself.",
      ],
    },
    {
      key: "info",
      title: "Info",
      lead: "The plain-language description of the app, for when you want the short version of what it does.",
      bullets: [
        "How a launch works, what it keeps apart, and the app's lifecycle: Run, Close, Delete.",
        "It names one honest limit: a program that saves settings in shared Windows places, such as the registry, "
          + "can still leave traces outside its folder. RunContainer keeps the app together; it does not lock down all of Windows.",
      ],
    },
    {
      key: "profiles",
      title: "Profiles",
      lead: "Profiles decide how much access each app gets.",
      bullets: [
        "default: normal access.",
        "relaxed: normal access plus the extra permissions some apps ask for.",
        "locked: no network — RunContainer can only promise that when the app runs in a virtual machine or a restricted container, and it says which of the two you are getting on your PC.",
      ],
    },
    {
      key: "settings",
      title: "Settings",
      lead: "Everything RunContainer can tell you about this PC, and the RC-Brain panel.",
      bullets: [
        "Which isolation this PC can use, where each app's files live, and where the logs are written.",
        "Choose your appearance and how supported installers run.",
        "The iPhone companion: turn it on to use an app that is running here from an iPhone on the same Wi-Fi.",
        "RC-Brain, RunContainer's own on-device model, the incidents it diagnosed, and the switch that turns monitoring off.",
      ],
    },
    {
      key: "tweaks",
      title: "Tweaks",
      lead: "Per-app launch arguments and resource limits, plus the JIT launcher.",
      bullets: [
        "Launch arguments, memory limit and CPU limit are validated before they are saved, and apply the next time you press Run.",
        "Runtime & JIT reads the app's own executable header and says what it actually runs on.",
        "Enable JIT starts the selected app straight away with the chosen JIT strategy applied on the way in. For a native app there is no intermediate language for a just-in-time compiler to translate, and RunContainer says that plainly instead of pretending a switch helped.",
      ],
    },
    {
      key: "apps",
      title: "Apps",
      lead: "The list of everything you have added, which is what you will use most.",
      bullets: [
        "Each tile shows the app's own icon, its name, its status, and which isolation it is using.",
        "Run starts it, Close stops it, Manage opens the details.",
        "More holds Reset (keep your data), Duplicate (a second copy with separate data), Export info, Logs, and Delete (which ends the app and removes its folder).",
        "If a tile is really an installer, the tile says which installer it is, whether setup is running in the background, and how long it has been working.",
      ],
    },
    {
      key: "sources",
      title: "Sources",
      lead: "Where apps come from.",
      bullets: [
        "Import from URL, or Install local EXE to pick an executable from this PC.",
        "Either way the app is copied into its own managed folder and never installed into the rest of Windows.",
      ],
    },
    {
      key: "support",
      title: "Where to get help, and how to support the project",
      lead: "RunContainer is free and open source. All four links below are official.",
      bullets: [
        "The source code and issue tracker are on GitHub.",
        "The documentation covers every tab, the isolation model and the known limitations.",
        "The Discord server is the fastest place to ask a question or report a problem.",
        "The YouTube channel has videos on getting started.",
        "If it is useful to you: star the repository on GitHub, subscribe to the channel and join the Discord. That is what keeps it going.",
      ],
      links: [
        { label: "GitHub", url: GH_URL },
        { label: "Documentation", url: DOCS_URL },
        { label: "Discord", url: DISCORD_URL },
        { label: "YouTube", url: YOUTUBE_URL },
      ],
    },
  ];
}

export default function BeginnerSetup({ version, onFinish, onOpenLink }) {
  const steps = useMemo(() => stepsFor(version), [version]);
  const [index, setIndex] = useState(0);
  const [closing, setClosing] = useState(false);
  const step = steps[index];
  const last = index === steps.length - 1;

  const finish = () => {
    if (closing) return;
    setClosing(true);
    Promise.resolve(onFinish ? onFinish() : null).catch(() => {});
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish();
      if (event.key === "ArrowRight" && !last) setIndex((current) => Math.min(steps.length - 1, current + 1));
      if (event.key === "ArrowLeft") setIndex((current) => Math.max(0, current - 1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const openLink = (url) => {
    Promise.resolve(onOpenLink ? onOpenLink(url) : null).catch(() => {});
  };

  return (
    <div className="modal-backdrop beginner-backdrop" role="dialog" aria-modal="true" aria-label="Getting started with RunContainer">
      <div className="detail-panel beginner-panel">
        <div className="beginner-header">
          <div>
            <span className="beginner-kicker">Getting started</span>
            <h3>{step.title}</h3>
          </div>
          <span className="beginner-count" aria-live="polite">{index}/9</span>
        </div>

        <p className="beginner-lead">{step.lead}</p>

        {Array.isArray(step.bullets) && step.bullets.length > 0 && (
          <ul className="beginner-list">
            {step.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
          </ul>
        )}

        {Array.isArray(step.links) && step.links.length > 0 && (
          <div className="beginner-links">
            {step.links.map((link) => (
              <button key={link.url} className="settings-button ghost" onClick={() => openLink(link.url)}>
                {link.label}
              </button>
            ))}
          </div>
        )}

        {step.note && <p className="beginner-note muted">{step.note}</p>}

        <div className="beginner-footer">
          <div className="beginner-progress" aria-hidden="true">
            {steps.map((entry, dotIndex) => (
              <span key={entry.key} className={`beginner-dot${dotIndex === index ? " active" : ""}${dotIndex < index ? " done" : ""}`} />
            ))}
          </div>
          <div className="detail-actions">
            <button className="settings-button ghost" onClick={finish} disabled={closing}>
              {last ? "Close" : "Skip"}
            </button>
            {index > 0 && (
              <button className="settings-button ghost" onClick={() => setIndex((current) => Math.max(0, current - 1))}>Back</button>
            )}
            {!last ? (
              <button className="settings-button" onClick={() => setIndex((current) => Math.min(steps.length - 1, current + 1))}>Next</button>
            ) : (
              <button className="settings-button" onClick={finish} disabled={closing}>Start using RunContainer</button>
            )}
          </div>
        </div>

        <p className="beginner-foot-note muted">
          This walkthrough is shown once, on this installation. Updating RunContainer will not show it again.
        </p>
      </div>
    </div>
  );
}
