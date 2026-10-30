import React, { useEffect, useMemo, useState } from "react";
import { installContainer, importFromUrl, runContainer, killContainer, resetContainer, duplicateContainer, exportContainer, getAppLogs, onContainerStatus, cancelDeleteContainer, setIsolationEngine, setWindowHosting, getAppVersion, getHyperVStatus, setAppConfig, setAppProfile, resetEnvironment, openGuestDisplay, checkAppUpdates, openUpdateLink, snoozeUpdate, downloadUpdate, cancelUpdateDownload, getUpdateState, installDownloadedUpdate, onUpdateDownloadProgress, getQemuStatus, detectQemu, getPerformance, openExternalUrl, repairAppEnvironment, getAiStatus, getAiHistory, getAiExperiences, promoteAiExperiences, rollbackAiModel, setAiMonitoring, onAiDiagnosis, onAiRepairResult, onAiRecovered, onAiUnavailable, onAiStatus, onAiHistory, onAiVerified, onSetupProgress, onSetupComplete, runContainerWithJit, getPreferences, setPreference, getCompanionStatus, enableCompanion, disableCompanion, newCompanionCode, forgetCompanionDevices, onCompanionStatus } from "../services/containerService";
import useContainers from "../hooks/useContainers";
import BeginnerSetup from "./BeginnerSetup";
import VirtualiseTab from "./VirtualiseTab";
import { UPDATES } from "../data/updates";

// The same names the main process uses for these strategies (src/services/runtimeProfile.js),
// so the interface and the log describe a JIT run in identical words.
const JIT_STRATEGY_LABELS = { "fast-start": "Fast start", throughput: "Maximum speed", auto: "Automatic (runtime default)" };

// What "Enable JIT" honestly did for this app. A native executable has no intermediate
// language for a just-in-time compiler to translate, and the message says that instead
// of implying the switch did something.
function jitRunMessage(container, strategy) {
  const name = container?.name || "the app";
  const kind = container?.runtime?.kind;
  if (kind === "dotnet") return `${name} is starting with JIT: the .NET runtime will compile its IL with the “${JIT_STRATEGY_LABELS[strategy] || strategy}” strategy.`;
  if (kind === "native") return `${name} is starting. It is already machine code, so there is no JIT translation to enable — RunContainer says so rather than pretending a switch helped.`;
  return `${name} is starting. RunContainer could not read this executable's header, so no JIT strategy was applied.`;
}

function useBootAnimation() {
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setBooting(false), 900);
    return () => window.clearTimeout(timer);
  }, []);

  return booting;
}
// Used only until the main process reports the version from package.json.
// Shown only for the moment before the main process reports the real version; the
// test asserts that it tracks package.json, so it must be bumped with the release.
const APP_VERSION_FALLBACK = "0.9.4";
// "4m 07s" - how long a setup has been running, for the one place a long wait
// needs to be explained rather than look frozen.
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
// How long a background setup has been running, or null when the start time cannot be
// read: an unusable timestamp must leave the line out instead of printing "NaNs".
function formatSetupElapsed(startedAt, now) {
  const started = Date.parse(startedAt || '');
  if (!Number.isFinite(started) || !Number.isFinite(now)) return null;
  return formatElapsed(now - started);
}
// The only project links the app opens, all official and public.
const DOCS_URL = "https://runcontainer-7.github.io/9-runcontainer/";
const DISCORD_URL = "https://discord.gg/rvMjMZJykE";
const YOUTUBE_URL = "https://www.youtube.com/@RunContainer";
const GITHUB_URL = "https://github.com/RunContainer-7/runcontainer";
const tabs = ["Sources", "Apps", "Tweaks", "Settings", "Profiles", "Info", "Updates"];
const tabIcons = {
  Sources: "◫",
  Apps: "▣",
  Tweaks: "✧",
  Settings: "⚙",
  Profiles: "◧",
  Info: "◌",
  Updates: "↓",
  Virtualise: "▢",
};
// The one tab that only developer mode reveals. Everything else is the same app either
// way: developer mode adds the technical detail and the ability to run a VM, and takes
// nothing away.
const DEVELOPER_ONLY_TABS = ["Virtualise"];
// Only these actions have an executor in the main process. Advice and escalation
// are shown with the diagnosis and never disguised as a repair button.
const EXECUTABLE_AI_ACTIONS = ["restart_same_profile", "restart_engine", "repair_permissions", "restart_clean_profile"];

// A status line reports what the last action did; it is not a permanent label. Leaving it
// on screen meant an old "Installed …" or "Refreshing the app list…" read like the current
// state of the app long after it stopped being true, so it now fades out and clears.
const STATUS_MESSAGE_VISIBLE_MS = 6000;
const STATUS_MESSAGE_FADE_MS = 450;

function StatusLine({ message }) {
  const [shown, setShown] = useState(message);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!message) {
      setShown("");
      setFading(false);
      return undefined;
    }
    setShown(message);
    setFading(false);
    const fade = setTimeout(() => setFading(true), STATUS_MESSAGE_VISIBLE_MS);
    const clear = setTimeout(() => setShown(""), STATUS_MESSAGE_VISIBLE_MS + STATUS_MESSAGE_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(clear);
    };
  }, [message]);

  if (!shown) return null;
  return (
    <p className={`status-line${fading ? " fading" : ""}`} role="status" aria-live="polite">
      {shown}
    </p>
  );
}

export default function ContainerManager() {
  const { containers, addContainer, removeContainer, updateContainerStatus, refreshContainers } = useContainers();
  const [activeTab, setActiveTab] = useState("Apps");
  const [showInstallMenu, setShowInstallMenu] = useState(false);
  const [selectedExe, setSelectedExe] = useState(null);
  const [installMessage, setInstallMessage] = useState("");
  const [selectedApp, setSelectedApp] = useState(null);
  // Icons are data URLs extracted from the app's own executable. If one cannot be
  // decoded the tile falls back to a letter instead of showing a broken image.
  const [failedIcons, setFailedIcons] = useState({});
  const markIconFailed = (id) => setFailedIcons((current) => (current[id] ? current : { ...current, [id]: true }));
  const [logs, setLogs] = useState([]);
  const [sourceUrl, setSourceUrl] = useState("");
  const [showInstallWizard, setShowInstallWizard] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  const [hypervStatus, setHypervStatus] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  // Release notes are collapsed by default so the feed opens on what is new rather
  // than on every release at once. A version is only recorded here once the user
  // has chosen for it; until then the installed release is the one left open.
  const [openUpdates, setOpenUpdates] = useState({});
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [showUpdateWizard, setShowUpdateWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState('notes');
  const [wizardMessage, setWizardMessage] = useState('');
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [qemuStatus, setQemuStatus] = useState(null);
  const [tweakAppId, setTweakAppId] = useState(null);
  const [tweakArgs, setTweakArgs] = useState("");
  const [tweakMemory, setTweakMemory] = useState("4096");
  const [tweakCpu, setTweakCpu] = useState("2");
  const [tweakRuntime, setTweakRuntime] = useState("auto");
  const [performanceInfo, setPerformanceInfo] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);
  const [aiDecision, setAiDecision] = useState(null);
  const [aiRepairing, setAiRepairing] = useState(false);
  const [aiOutcome, setAiOutcome] = useState("idle");
  const [aiMessage, setAiMessage] = useState("");
  const [aiHistory, setAiHistory] = useState([]);
  const [aiExperiences, setAiExperiences] = useState([]);
  const [aiVerification, setAiVerification] = useState(null);
  const [aiWorking, setAiWorking] = useState(false);
  const [jitRunning, setJitRunning] = useState(false);
  const [jitNote, setJitNote] = useState("");
  // The beginner introduction is offered once for this installation, never once per
  // version. Nothing is shown until the preference has been read, so it cannot flash.
  const [showBeginnerSetup, setShowBeginnerSetup] = useState(false);
  // Developer mode: this installation's switch between the plain interface and the
  // technical one. It reveals the audit detail behind RC-Brain, the launch timings, and
  // the Virtualise tab. It is one preference, recorded once for this installation.
  const [developerMode, setDeveloperMode] = useState(false);
  const [channel, setChannel] = useState('stable');
  const isNightly = channel === 'nightly';
  // How a supported installer is handled when Run is pressed: completed unattended
  // inside its environment (default), or shown as its own wizard inside RunContainer.
  // It is one setting for the whole installation, not a button on every app card.
  const [installerMode, setInstallerMode] = useState("auto");
  // Appearance. Dark is the default and the app's identity; light is for daylight and
  // projectors. One preference, applied to <body>, so every surface follows it.
  const [theme, setTheme] = useState("dark");
  // The iPhone companion is off until it is turned on here. Its address and pairing
  // code are read from the main process, never guessed by this panel.
  const [companion, setCompanion] = useState(null);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [companionCopied, setCompanionCopied] = useState(false);
  // Ticks only while something is being set up, so a long setup is visibly still
  // working instead of looking like an app that never appears. It is declared here,
  // in the component that renders the app list and the setup line, because that is
  // where it is read; declaring it inside the boot hook left the read undefined and
  // threw once a second while an app was setting up, which blanked the whole window.
  const [setupClock, setSetupClock] = useState(Date.now());
  const booting = useBootAnimation();

  useEffect(() => {
    Promise.resolve(getPreferences())
      .then((preferences) => {
        if (preferences?.beginnerSetupSeen !== true) setShowBeginnerSetup(true);
        if (preferences?.channel === 'nightly') {
          setChannel('nightly');
          if (preferences?.developerMode === true) setDeveloperMode(true);
        }
        if (preferences?.installerMode === "manual") setInstallerMode("manual");
        if (preferences?.theme === "light") setTheme("light");
      })
      .catch(() => {});
  }, []);

  // The theme is a property of the document, not of each panel: one attribute repaints
  // every surface, including panels that have not been opened yet.
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.body.dataset.theme = theme;
      document.body.dataset.channel = channel;
      document.title = isNightly ? 'RunContainer Nightly' : 'RunContainer';
      const icon = isNightly ? './runcontainer-nightly-icon.png' : './runcontainer-icon.png';
      document.querySelectorAll('link[rel="icon"]').forEach((link) => { link.href = icon; link.type = 'image/png'; });
    }
  }, [theme, channel, isNightly]);

  function chooseTheme(next) {
    setTheme(next);
    Promise.resolve(setPreference({ theme: next })).catch(() => {});
  }

  // The companion panel is only read while Settings is open, and it follows the main
  // process: a phone pairing on another device updates the count and the code here.
  useEffect(() => {
    if (activeTab !== 'Settings') return undefined;
    // Outside the desktop app (or in a test bridge) these bindings may not exist; the
    // panel then simply stays as it was instead of throwing on the way in.
    if (typeof getCompanionStatus === 'function') {
      Promise.resolve(getCompanionStatus()).then((status) => { if (status) setCompanion(status); }).catch(() => {});
    }
    return typeof onCompanionStatus === 'function'
      ? onCompanionStatus((status) => { if (status) setCompanion(status); })
      : undefined;
  }, [activeTab]);

  async function toggleCompanion() {
    if (companionBusy) return;
    setCompanionBusy(true);
    try {
      const status = companion?.running ? await disableCompanion() : await enableCompanion();
      if (status) setCompanion(status);
    } catch (error) {
      // The panel keeps its last known state; the reason is written to the app's log.
    } finally {
      setCompanionBusy(false);
    }
  }

  async function refreshCompanionCode() {
    if (companionBusy) return;
    setCompanionBusy(true);
    try {
      const status = await newCompanionCode();
      if (status) setCompanion(status);
    } catch (error) { /* see toggleCompanion */ } finally {
      setCompanionBusy(false);
    }
  }

  async function forgetCompanion() {
    if (companionBusy) return;
    setCompanionBusy(true);
    try {
      const status = await forgetCompanionDevices();
      if (status) setCompanion(status);
    } catch (error) { /* see toggleCompanion */ } finally {
      setCompanionBusy(false);
    }
  }

  // The address is the one thing a person has to type on the phone, so copying it has
  // to work even where the clipboard API is unavailable.
  async function copyCompanionAddress() {
    const address = companion?.urls?.[0]?.url || (companion?.port ? `http://localhost:${companion.port}/` : '');
    if (!address) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address);
      } else {
        const area = document.createElement('textarea');
        area.value = address;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      setCompanionCopied(true);
      setTimeout(() => setCompanionCopied(false), 1800);
    } catch (error) {
      // A refused clipboard leaves the address on screen to be read and typed.
    }
  }

  function formatCompanionCode(code) {
    const text = String(code || '');
    if (text.length !== 6) return text;
    return `${text.slice(0, 3)} ${text.slice(3)}`;
  }

  // Switching developer mode on or off is one preference write. Nothing is hidden that
  // existed before it: the plain interface is the same either way, and leaving the
  // Virtualise tab closes it rather than leaving a dead tab open.
  function toggleDeveloperMode() {
    const next = !developerMode;
    setDeveloperMode(next);
    Promise.resolve(setPreference({
      developerMode: next,
      developerModeEnabledAt: next ? new Date().toISOString() : null,
    })).catch(() => {});
    if (!next) setActiveTab((current) => (DEVELOPER_ONLY_TABS.includes(current) ? "Settings" : current));
  }

  // The installer choice is one preference write; the app cards and the launch path
  // both read it, so Run behaves the way Settings says without a per-app button.
  function chooseInstallerMode(mode) {
    setInstallerMode(mode);
    Promise.resolve(setPreference({ installerMode: mode })).catch(() => {});
  }

  const visibleTabs = developerMode ? [...tabs, ...DEVELOPER_ONLY_TABS] : tabs;
  // Each edition reads its own feed: Stable never shows a Nightly prerelease, and
  // Nightly keeps the stable notes that its build is based on.
  const visibleUpdates = UPDATES.filter((entry) => isNightly || !entry.version.includes('-nightly.'));

  function finishBeginnerSetup() {
    setShowBeginnerSetup(false);
    // Recorded even when the walkthrough was skipped: it is a once-ever offer, and the
    // record is what guarantees an update does not replay it.
    Promise.resolve(setPreference({
      beginnerSetupSeen: true,
      beginnerSetupSeenAt: new Date().toISOString(),
      beginnerSetupSeenVersion: appVersion,
    })).catch(() => {});
  }

  useEffect(() => {
    // Promise.resolve keeps this safe when the bridge is unavailable (for example in tests
    // or when the app runs outside Electron) instead of throwing on an undefined result.
    Promise.resolve(getAppVersion())
      .then((version) => {
        if (version) setAppVersion(version);
      })
      .catch(() => {});
    // Installed users learn about new stable releases from a notice banner;
    // everyone else gets the installer from the GitHub Releases page.
    Promise.resolve(checkAppUpdates())
      .then((result) => {
        // Every outcome is stored so the Updates tab can always explain itself
        // (up-to-date, unavailable + reason); only update-available banners.
        if (result && result.status) {
          setUpdateInfo(result);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => onUpdateDownloadProgress((progress) => {
    setDownloadProgress(progress);
  }), []);

  useEffect(() => {
    Promise.resolve(getQemuStatus())
      .then((status) => { if (status) setQemuStatus(status); })
      .catch(() => {});
    Promise.resolve(getHyperVStatus())
      .then((status) => { if (status) setHypervStatus(status); })
      .catch(() => {});
  }, []);

  function isolationLabel(app) {
    if (app.status !== 'Running') return null;
    if (app.isolated && (app.activeEngine === 'hyperv' || app.activeEngine === 'qemu' || app.isolationLevel === 'vm')) {
      return 'In its own virtual machine';
    }
    if (app.isolated && (app.activeEngine === 'rcvm' || app.isolationLevel === 'container')) {
      return 'In its own space';
    }
    if (app.isolated) return 'Restricted mode';
    return 'Not running';
  }

  const appContainers = useMemo(() => containers.filter((container) => container?.source), [containers]);
  // A locked profile means "no network". Only a virtual machine (or an AppContainer
  // profile without the internet capability) can actually block it on Windows.
  const canEnforceOffline = Boolean(qemuStatus?.available || hypervStatus?.ready);

  useEffect(() => onContainerStatus((record) => {
    if (!record?.id) return;
    if (record.status) updateContainerStatus(record.id, record.status);
    setActiveSession((current) => current?.id === record.id ? { ...current, ...record } : current);
  }), [updateContainerStatus]);

  // Measured launch timings, read when Settings is opened. They are observations
  // from this PC, so the card can stay silent until something has been launched.
  useEffect(() => {
    if (activeTab !== 'Settings') return undefined;
    Promise.resolve(getPerformance()).then((info) => { if (info) setPerformanceInfo(info); }).catch(() => {});
    return undefined;
  }, [activeTab]);

  useEffect(() => {
    Promise.resolve(getAiStatus()).then((status) => { if (status) setAiStatus(status); }).catch(() => {});
    Promise.resolve(getAiHistory()).then((history) => { if (Array.isArray(history)) setAiHistory(history); }).catch(() => {});
    Promise.resolve(getAiExperiences()).then((items) => { if (Array.isArray(items)) setAiExperiences(items); }).catch(() => {});
  }, []);

  // Verification is a separate event from "the repair command finished".
  useEffect(() => onAiVerified((payload) => {
    if (!payload?.verdict) return;
    setAiVerification(payload);
    const status = payload.verdict.status;
    setAiOutcome(status === 'verified' ? 'repaired' : status === 'unresolved' ? 'failed' : 'idle');
    setAiMessage(status === 'verified'
      ? 'Verified: the original problem cleared and stayed clear.'
      : status === 'unresolved'
        ? `The repair did not clear the problem: ${payload.verdict.detail || 'it is still observable.'}`
        : `Verification was inconclusive: ${payload.verdict.detail || 'not enough observations.'}`);
    Promise.resolve(getAiExperiences()).then((items) => { if (Array.isArray(items)) setAiExperiences(items); }).catch(() => {});
    Promise.resolve(getAiStatus()).then((statusValue) => { if (statusValue) setAiStatus(statusValue); }).catch(() => {});
  }), []);

  // RC-Brain pushes each new diagnosis. The banner stays until the app recovers,
  // the user dismisses it, or the repair reports its result.
  useEffect(() => onAiDiagnosis((decision) => {
    if (!decision?.id) return;
    setAiDecision(decision);
    setAiOutcome(decision.outcome === 'repairing' ? 'repairing' : 'idle');
    setAiMessage(decision.outcome === 'repairing' ? 'RC-Brain is running its chosen repair…' : '');
  }), []);

  useEffect(() => onAiRepairResult(({ id, result, diagnosis }) => {
    setAiDecision((current) => (current?.id === id ? current : current));
    setAiOutcome(result?.status === 'repaired' ? 'repaired' : 'failed');
    setAiMessage(result?.status === 'repaired'
      ? (result.clearedProfile?.length > 0 ? 'Repaired. The app restarted with a clean profile.' : 'Repaired. The app is running again.')
      : (result?.error || result?.note || `Repair for ${diagnosis?.summary || 'the diagnosis'} did not complete.`));
    if (result?.status === 'repaired') refreshContainers();
  }), [refreshContainers]);

  useEffect(() => onAiRecovered(({ id }) => {
    setAiDecision((current) => (current?.id === id ? null : current));
    setAiOutcome("idle");
    setAiMessage("");
  }), []);

  useEffect(() => onAiUnavailable(({ error }) => {
    setAiStatus((current) => ({ ...(current || {}), available: false, error }));
  }), []);

  useEffect(() => onAiStatus((status) => { if (status) setAiStatus(status); }), []);

  // An app that is really its own setup program: either its wizard is waiting in a
  // RunContainer window, or its unattended setup is running in the background. The
  // message names which one it is, so a slow setup never looks like a frozen app.
  useEffect(() => onSetupProgress((payload) => {
    if (!payload?.id) return;
    if (payload.phase === 'failed') {
      setInstallMessage(payload.detail || payload.summary || 'Setup could not be started in the background.');
      return;
    }
    setInstallMessage(payload.summary || 'This app is its own setup program.');
    refreshContainers();
  }), [refreshContainers]);

  useEffect(() => onSetupComplete((payload) => {
    if (!payload?.id) return;
    setInstallMessage(payload.detail || 'Setup finished.');
    refreshContainers();
  }), [refreshContainers]);

  // The clock only runs while an unattended setup is in progress.
  const setupRunning = (containers || []).some((container) => container?.setupProgram
    && container.setupPlanMode === 'silent'
    && !container.installedExePath);
  useEffect(() => {
    if (!setupRunning) return undefined;
    const timer = setInterval(() => setSetupClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [setupRunning]);
  useEffect(() => onAiHistory((history) => { if (Array.isArray(history)) setAiHistory(history); }), []);

  // Keep RC-Brain's heartbeat current: "last check" must reflect the real
  // supervisor tick, not the snapshot taken when Settings opened.
  useEffect(() => {
    if (activeTab !== 'Settings') return undefined;
    const timer = setInterval(() => {
      Promise.resolve(getAiStatus()).then((status) => { if (status) setAiStatus(status); }).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [activeTab]);

  function describeLastCheck(lastTickAt) {
    if (!lastTickAt) return 'not yet';
    const seconds = Math.max(0, Math.round((Date.now() - lastTickAt) / 1000));
    if (seconds < 90) return `${seconds}s ago`;
    return `${Math.round(seconds / 60)} min ago`;
  }

  function handleAiRepair(approved = false) {
    if (!aiDecision || aiRepairing) return;
    setAiRepairing(true);
    setAiOutcome("repairing");
    setAiMessage(approved ? 'Approved. Running the repair RC-Brain chose…' : 'Stopping the app and running the repair RC-Brain chose…');
    Promise.resolve(repairAppEnvironment(aiDecision.id, aiDecision, approved))
      .then((result) => {
        if (result?.status === 'repaired') {
          setAiOutcome("repaired");
          setAiMessage(result.clearedProfile?.length > 0
            ? "Repaired. The app restarted with a clean profile."
            : "Repaired. The app is running again.");
          refreshContainers();
          return;
        }
        setAiOutcome(result?.status === 'awaiting_approval' ? 'awaiting_approval' : 'failed');
        setAiMessage(result?.error || result?.note || "The repair did not complete.");
      })
      .catch((error) => {
        setAiOutcome("failed");
        setAiMessage(error?.message || "The repair failed before it could start.");
      })
      .finally(() => setAiRepairing(false));
  }

  function handlePromoteExperiences() {
    const eligible = aiExperiences.filter((entry) => !entry.promoted && entry.labelsLocked === false && (entry.outcome === 'success' || entry.outcome === 'user_corrected'));
    if (eligible.length === 0) {
      setAiMessage('No verified experiences are waiting. A repair only becomes a training example after it is verified and reviewed.');
      return;
    }
    if (!window.confirm(`Add ${eligible.length} verified experience(s) to the local curated dataset? They are sanitised and stay on this PC. This does not retrain the model.`)) return;
    setAiWorking(true);
    Promise.resolve(promoteAiExperiences(eligible.map((entry) => entry.id), true))
      .then((result) => {
        setAiMessage(result?.promoted
          ? `${result.promoted} example(s) added to the local curated dataset. Training a candidate is a separate offline step.`
          : 'Nothing was added: no eligible verified examples.');
        return Promise.resolve(getAiStatus()).then((status) => { if (status) setAiStatus(status); });
      })
      .catch((error) => setAiMessage(error?.message || 'The experience could not be promoted.'))
      .finally(() => setAiWorking(false));
  }

  function handleRollbackModel() {
    if (!window.confirm('Load the previous RC-Brain model again? The current model stays on disk.')) return;
    setAiWorking(true);
    Promise.resolve(rollbackAiModel())
      .then((result) => {
        setAiMessage(result?.rolledBack ? 'Rolled back to the previous model. Monitoring restarted with it.' : (result?.reason || 'There is no previous model to roll back to.'));
        return Promise.resolve(getAiStatus()).then((status) => { if (status) setAiStatus(status); });
      })
      .catch((error) => setAiMessage(error?.message || 'The model could not be rolled back.'))
      .finally(() => setAiWorking(false));
  }

  function handleToggleAiMonitoring() {
    const next = !(aiStatus?.enabled);
    Promise.resolve(setAiMonitoring(next))
      // Merged, not replaced: the toggle's answer carries the monitoring state, and
      // replacing the whole status with it dropped the model, registry and capability
      // detail the same panel shows until the next poll put it back.
      .then((status) => { if (status) setAiStatus((current) => ({ ...(current || {}), ...status })); })
      .catch((error) => setAiMessage(error?.message || "Monitoring could not be changed."));
  }

  function handleInstallExe() {
    const pickFile = (file) => {
      if (!file) return;

      const resolvedName = typeof file === "string" ? file : file.name;
      setSelectedExe(resolvedName);
      setInstallMessage("Preparing installation wizard...");
      setShowInstallWizard(true);

      installContainer(file).then((newContainer) => {
        if (newContainer?.id) {
          addContainer(newContainer);
        }
        setActiveTab("Apps");
        setInstallMessage(`Installed ${newContainer?.name || resolvedName}`);
        setShowInstallWizard(false);
        // The card is rendered from the list, which is the one source that also carries
        // the icon and the folder state; the install answer is only used for the name.
        refreshContainers();
      }).catch((error) => {
        console.error("Install failed:", error);
        setShowInstallWizard(false);
        setInstallMessage(error?.message || "Unable to install that EXE.");
      });
    };

    if (window.electron?.openFileDialog) {
      window.electron
        .openFileDialog()
        .then((filePath) => {
          const resolvedPath = Array.isArray(filePath) ? filePath[0] : filePath;
          pickFile(resolvedPath);
        })
        .catch((error) => {
          console.error("Unable to open file dialog:", error);
        });
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".exe,application/x-msdownload";
    input.onchange = (event) => {
      const file = event.target.files?.[0];
      pickFile(file);
    };
    input.click();
  }

  function handleImportFromUrl(urlOverride) {
    const resolvedUrl = typeof urlOverride === "string" ? urlOverride : sourceUrl;
    if (!resolvedUrl) {
      setInstallMessage("Enter a source URL first.");
      return;
    }

    setInstallMessage("Preparing installation wizard...");
    setShowInstallWizard(true);
    importFromUrl(resolvedUrl)
      .then((newContainer) => {
        if (newContainer?.id) {
          addContainer(newContainer);
        }
        setActiveTab("Apps");
        setInstallMessage(`Imported ${newContainer?.name || resolvedUrl}`);
        setSourceUrl("");
        setShowInstallWizard(false);
        refreshContainers();
      })
      .catch((error) => {
        console.error("Import failed:", error);
        setShowInstallWizard(false);
        setInstallMessage(error?.message || "Unable to import from that URL.");
      });
  }

  function handleDuplicate(container) {
    duplicateContainer(container)
      .then((duplicateApp) => {
        addContainer(duplicateApp);
        setInstallMessage(duplicateApp?.cloneWarning ? `Duplicated ${duplicateApp.name}, but ${duplicateApp.cloneWarning}` : `Duplicated ${duplicateApp.name} with its own separate data.`);
        refreshContainers();
      })
      .catch((error) => {
        setInstallMessage(`Could not duplicate ${container.name}: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleExport(container) {
    exportContainer(container)
      .then((result) => {
        setInstallMessage(`Exported app details to ${result.path}.`);
      })
      .catch((error) => {
        setInstallMessage(`Could not export ${container.name}: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleReset(container) {
    setInstallMessage(`Resetting ${container.name} (fresh state, keeps data)...`);
    resetEnvironment(container)
      .then((result) => {
        if (!result?.reset) {
          setInstallMessage(`Could not reset ${container.name}: ${result?.error || 'Reset was not confirmed.'}`);
          return;
        }
        updateContainerStatus(container.id, 'Stopped');
        setActiveSession((current) => current?.id === container.id ? { ...current, ...result, status: 'Stopped' } : current);
        setSelectedApp((current) => current?.id === container.id ? { ...current, status: 'Stopped' } : current);
        setInstallMessage(`${container.name} reset: fresh state, data kept.`);
        refreshContainers();
      })
      .catch((error) => {
        setInstallMessage(`Could not reset ${container.name}: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleOpenDisplay(container) {
    setInstallMessage(`Opening the app window for ${container.name}...`);
    openGuestDisplay(container)
      .then((result) => {
        if (result?.status !== 'Displaying') {
          setInstallMessage(`Could not open the app window: ${result?.error || 'Unknown error.'}`);
          return;
        }
        setInstallMessage(result.embedded
          ? `${container.name}: window shown inside RunContainer.`
          : `${container.name}: ${result.note || 'the window opened on your desktop.'}`);
      })
      .catch((error) => {
        setInstallMessage(`Could not open the app window: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleSaveTweaks(container) {
    if (!container) return;
    // Network follows the profile only; saving tweaks must not turn a locked app
    // back online by writing a default networkEnabled.
    setAppConfig({ id: container.id, launchArgs: tweakArgs, vmMemoryMB: Number(tweakMemory), vmCpuCount: Number(tweakCpu), runtimeJit: tweakRuntime })
      .then((result) => {
        if (result?.status === 'Failed') {
          setInstallMessage(`Could not save tweaks: ${result.error}`);
          return;
        }
        setInstallMessage(`Tweaks saved for ${container.name}. Limits apply the next time you press Run.`);
        refreshContainers();
      })
      .catch((error) => {
        setInstallMessage(`Could not save tweaks: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleEnableJit(container) {
    if (!container) {
      setInstallMessage("Pick an app in Tweaks first, then press Enable JIT.");
      return;
    }
    setJitNote("");
    setJitRunning(true);
    setInstallMessage(`Starting ${container.name} with JIT…`);
    // The strategy is saved before the launch, because the launch is the point of the
    // button: it has to use the choice just made, not the one after it.
    Promise.resolve(setAppConfig({ id: container.id, runtimeJit: tweakRuntime }))
      .then((saved) => {
        if (saved?.status === "Failed") setJitNote(saved.error);
        return runContainerWithJit({ ...container, runtimeJit: tweakRuntime });
      })
      .then((result) => {
        if (!result || result.status !== "Running") {
          setInstallMessage(`${container.name} was not launched: ${result?.error || result?.reason || "RunContainer did not confirm that an app process started."}`);
          return;
        }
        updateContainerStatus(container.id, result.status);
        const jitRun = jitRunMessage(container, tweakRuntime);
        // The JIT line is shown with the running app, not only as a passing status line:
        // it is the answer to "what did pressing Enable JIT actually do?".
        setActiveSession({ ...container, ...result, status: "Running", embedded: false, jitRun });
        setInstallMessage(jitRun);
        refreshContainers();
      })
      .catch((error) => setInstallMessage(`Could not start ${container.name} with JIT: ${error?.message || "Unknown launch error."}`))
      .finally(() => setJitRunning(false));
  }

  function handleSetProfile(container, profile) {
    setAppProfile({ id: container.id, profile })
      .then((result) => {
        if (result?.status === 'Failed') {
          setInstallMessage(`Could not set profile: ${result.error}`);
          return;
        }
        setSelectedApp((current) => current?.id === container.id ? { ...current, profile: result.profile, networkEnabled: result.networkEnabled } : current);
        setInstallMessage(profile === 'locked'
          ? (canEnforceOffline
            ? `${container.name} is set to no network access.`
            : `${container.name} is set to no network access, but this PC can only block it when the app runs in a virtual machine, so it can still go online here.`)
          : `${container.name} uses the ${profile} profile.`);
        refreshContainers();
      })
      .catch((error) => {
        setInstallMessage(`Could not set profile: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleViewLogs(container) {
    getAppLogs(container).then((appLogs) => {
      setLogs(appLogs);
      setSelectedApp(container);
    }).catch((error) => {
      setLogs([]);
      setSelectedApp(container);
      setInstallMessage(`Could not read logs for ${container.name}: ${error?.message || 'Unknown error.'}`);
    });
  }

  function handleRun(container) {
    // An app whose display was switched to "its own window" is the one case where Run
    // opens no RunContainer window at all. Saying so turns a mysterious standalone window
    // into a setting with a stated place to change it.
    setInstallMessage(container?.windowHosting === false
      ? `Starting ${container.name}. This app is set to open in its own window; Manage → Display → “Show inside RunContainer” changes that.`
      : `Starting ${container.name} in its RunContainer container...`);
    setActiveSession({ ...container, embedded: false, status: 'Launching' });

    runContainer(container)
      .then(async (result) => {
        if (!result || result.status !== 'Running' || (!result.pid && !result.guestPid)) {
          setActiveSession(null);
          const reason = result?.error || result?.reason || 'RunContainer did not confirm that an app process started.';
          setInstallMessage(`${container.name} was not launched: ${reason}`);
          updateContainerStatus(container.id, result?.status || 'Failed');
          await refreshContainers();
          return;
        }

        updateContainerStatus(container.id, result.status);
        setActiveSession({ ...container, ...result, status: 'Running', embedded: false });
        setInstallMessage(result?.guestPid
          ? `${container.name} is running in its own virtual machine.`
          : `${container.name} is running in its own environment.`);
        refreshContainers();
      })
      .catch((error) => {
        setActiveSession(null);
        setInstallMessage(`${container.name} was not launched: ${error?.message || 'Unknown launch error.'}`);
      });
  }

  function handleKill(container) {
    killContainer(container)
      .then((result) => {
        if (result?.status !== 'Stopped') {
          setInstallMessage(`Could not stop ${container.name}: ${result?.error || 'RunContainer did not confirm that the app stopped.'}`);
          return;
        }
        updateContainerStatus(container.id, result.status);
        setActiveSession((current) => current?.id === container.id ? { ...current, ...result, status: 'Stopped', pid: null, sandboxPids: [] } : current);
        setInstallMessage(`${container.name} stopped.`);
        refreshContainers();
      })
      .catch((error) => {
        setInstallMessage(`Could not stop ${container.name}: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleCancelDelete(container) {
    if (!container) return;
    cancelDeleteContainer(container).then(() => {
      setInstallMessage(`Cancelling the deletion of ${container.name}...`);
    }).catch((error) => {
      setInstallMessage(`Could not cancel deletion: ${error?.message || 'Unknown error.'}`);
    });
  }

  function handleRefreshApps() {
    setInstallMessage("Refreshing the app list from RunContainer's persistent store...");
    refreshContainers().then((items) => {
      setInstallMessage(Array.isArray(items) ? `App list refreshed (${items.length} app${items.length === 1 ? '' : 's'}).` : 'App list refresh did not return a list.');
    }).catch((error) => {
      setInstallMessage(`Could not refresh the app list: ${error?.message || 'Unknown error.'}`);
    });
  }

  function handleCheckUpdates(force) {
    setUpdateChecking(true);
    setUpdateDismissed(false);
    Promise.resolve(checkAppUpdates({ force: force !== false }))
      .then((result) => {
        if (result) setUpdateInfo(result);
        setInstallMessage(result?.status === 'update-available'
          ? `RunContainer v${result.latestVersion} is available — use the notice above or the Updates tab to get it.`
          : result?.status === 'up-to-date'
            ? 'You are on the latest RunContainer release.'
            : 'Could not check for updates right now. New installers are always on the GitHub Releases page.');
      })
      .catch(() => {
        setInstallMessage('Could not check for updates right now.');
      })
      .finally(() => setUpdateChecking(false));
  }

  // Docs and Discord are anchors, so a browser click still works; inside the app the
  // click is handed to the main process, which opens the default browser.
  function handleOpenProjectLink(event, url) {
    if (event) event.preventDefault();
    Promise.resolve(openExternalUrl(url))
      .then((result) => {
        if (result && result.opened === false && result.error) setInstallMessage(result.error);
      })
      .catch(() => setInstallMessage('Could not open that link in your browser.'));
  }

  function handleOpenUpdateLink(which) {
    Promise.resolve(openUpdateLink(which))
      .then((result) => {
        if (result && result.opened === false) {
          setInstallMessage(result.error || 'No verified update link is available.');
        }
      })
      .catch(() => {});
  }

  function handleSnoozeTomorrow() {
    const version = updateInfo?.latestVersion;
    if (version) {
      Promise.resolve(snoozeUpdate({ version, untilMs: Date.now() + 24 * 60 * 60 * 1000 })).catch(() => {});
    }
    setUpdateDismissed(true);
    setShowUpdateWizard(false);
  }

  function openUpdateWizard() {
    // Main owns the download operation; resync the wizard so reopening
    // mid-download shows the live step instead of a stale one.
    Promise.resolve(getUpdateState())
      .then((state) => {
        if (state?.downloaded) {
          setWizardStep('ready');
          setWizardMessage('Installer is downloaded and verified. Install & restart runs it over your current copy — apps and settings are kept.');
        } else {
          setWizardStep('notes');
          setWizardMessage('');
        }
        setDownloadProgress(null);
        setShowUpdateWizard(true);
      })
      .catch(() => {
        setWizardStep('notes');
        setWizardMessage('');
        setShowUpdateWizard(true);
      });
  }

  function handleCancelDownload() {
    cancelUpdateDownload();
    setWizardStep('notes');
    setWizardMessage('Download cancelled. The partial file was removed.');
    setDownloadProgress(null);
  }

  function handleDownloadUpdate() {
    setWizardStep('downloading');
    setWizardMessage('');
    setDownloadProgress(null);
    Promise.resolve(downloadUpdate())
      .then((result) => {
        if (result?.downloaded) {
          setWizardStep('ready');
          setWizardMessage('Downloaded. Install & restart runs the installer wizard over your current copy — apps and settings are kept.');
        } else {
          setWizardStep('notes');
          setWizardMessage(result?.error || 'Download failed.');
        }
      })
      .catch((error) => {
        setWizardStep('notes');
        setWizardMessage(error?.message || 'Download failed.');
      });
  }

  function handleInstallUpdate() {
    Promise.resolve(installDownloadedUpdate())
      .then((result) => {
        if (!result?.started) setWizardMessage(result?.error || 'Could not start the installer.');
      })
      .catch((error) => setWizardMessage(error?.message || 'Could not start the installer.'));
  }

  function handleDetectQemu() {
    setInstallMessage('Checking isolation…');
    Promise.resolve(detectQemu())
      .then((status) => {
        if (status) setQemuStatus(status);
        setInstallMessage(status?.available
          ? 'Checked: apps also run inside a small virtual machine on this PC.'
          : 'Checked: apps run in their own space on this PC.');
      })
      .catch(() => setInstallMessage('Could not check isolation right now.'));
  }

  function handleUseAutomatic(container) {
    setIsolationEngine({ id: container.id, isolationEngine: 'auto' })
      .then((result) => {
        if (result?.status === 'Failed') {
          setInstallMessage(`Could not change how ${container.name} runs: ${result.error}`);
          return;
        }
        setSelectedApp((current) => current?.id === container.id ? { ...current, isolationEngine: 'auto', preferVm: false, requiresVm: false } : current);
        setInstallMessage(`${container.name} will use whichever option works on this PC.`);
        refreshContainers();
      })
      .catch((error) => {
        setInstallMessage(`Could not change how ${container.name} runs: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleSetWindowHosting(container, enabled) {
    setWindowHosting({ id: container.id, windowHosting: enabled }).then((result) => {
      if (result?.status === 'Failed') {
        setInstallMessage(`Could not change window hosting for ${container.name}: ${result.error}`);
        return;
      }
      setSelectedApp((current) => current?.id === container.id ? { ...current, windowHosting: result.windowHosting } : current);
      setInstallMessage(result.windowHosting
        ? `${container.name} will be shown inside RunContainer the next time it runs.`
        : `${container.name} will open in its own window the next time it runs.`);
    }).catch((error) => {
      setInstallMessage(`Could not change window hosting for ${container.name}: ${error?.message || 'Unknown error.'}`);
    });
  }

  function handleDelete(container) {
    if (!container) return;

    setDeletingId(container.id);
    setInstallMessage(`Deleting ${container.name} and its sandbox...`);
    resetContainer(container)
      .then(async (result) => {
        if (result?.status === 'Cancelled') {
          setInstallMessage(`Deletion of ${container.name} was cancelled. The app is still listed; run Delete again to finish removing its folder.`);
          await refreshContainers();
          return;
        }
        if (!result?.removed || result.status !== 'Reset') {
          setInstallMessage(`Could not delete ${container.name}: ${result?.error || 'RunContainer did not confirm deletion.'}`);
          return;
        }

        if (activeSession?.id === container.id) setActiveSession(null);
        if (selectedApp?.id === container.id) setSelectedApp(null);
        removeContainer(container.id);
        const remaining = await refreshContainers();
        if (!Array.isArray(remaining)) {
          setInstallMessage(`${container.name} was deleted, but the app list could not be refreshed.`);
          return;
        }
        if (remaining.some((entry) => entry.id === container.id)) {
          setInstallMessage(`${container.name} was removed from disk, but its launcher record is still present. Refresh RunContainer and check its app store.`);
          return;
        }
        setInstallMessage(result.containerCleanupWarning
          ? `${container.name} and its sandbox were deleted, but its container profile could not be confirmed removed: ${result.containerCleanupWarning}`
          : `${container.name} and its sandbox were deleted.`);
      })
      .catch((error) => {
        setInstallMessage(`Could not delete ${container.name}: ${error?.message || 'Unknown deletion error.'}`);
      })
      .finally(() => setDeletingId(null));
  }

  return (
    <div className={`screen ${booting ? "booting" : ""}`}>
      {booting && (
        <div className="boot-overlay">
          <div className="boot-ring" />
          <div className="boot-copy">Initializing RunContainer desktop…</div>
        </div>
      )}
      <div className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◧</span>
          <div>
            <div className="eyebrow">Per-app profile launcher</div>
            <div className="header-title">RunContainer{isNightly ? ' Nightly' : ''}</div>
            <div className="brand-version">v{appVersion} · {isNightly ? 'experimental early access' : 'an app inside an app'}</div>
          </div>
        </div>
        {activeTab === "Apps" && (
          <div className="header-actions">
            <div className="action-menu">
              <button className="icon-button" onClick={() => setShowInstallMenu((prev) => !prev)} aria-label="Install options">＋</button>
              {showInstallMenu && (
                <div className="dropdown-menu">
                  <button onClick={() => { setShowInstallMenu(false); handleInstallExe(); }}>Install EXE</button>
                  <button onClick={() => { setShowInstallMenu(false); handleImportFromUrl(); }}>Import from URL</button>
                </div>
              )}
            </div>
            <button className="icon-button" aria-label="Refresh app list" title="Refresh app list" onClick={handleRefreshApps}>⟳</button>
          </div>
        )}
      </div>

      {updateInfo?.status === 'update-available' && !updateDismissed && (
        <div className="update-banner">
          <span>RunContainer v{updateInfo.latestVersion} is available (you have v{appVersion}).</span>
          <div className="detail-actions">
            <button className="settings-button" onClick={openUpdateWizard}>Update…</button>
            <button className="settings-button ghost" onClick={handleSnoozeTomorrow}>Remind tomorrow</button>
            <button className="icon-button" aria-label="Dismiss update notice" onClick={() => setUpdateDismissed(true)}>×</button>
          </div>
        </div>
      )}

      {aiDecision && (
        <div className={`behavioral-banner ai-banner${aiOutcome === 'repaired' ? ' repaired' : ''}`} role="alert">
          <div className="behavioral-copy">
            <strong>
              {aiOutcome === 'repaired'
                ? '◈ RC-Brain · repair verified'
                : `◈ RC-Brain · ${aiDecision.diagnosis?.summary || 'Diagnosis'}`}
            </strong>
            {aiOutcome === 'repaired' ? (
              <span className="behavioral-repair-status">{aiMessage}</span>
            ) : (
              <>
                <span className="muted">
                  {aiDecision.name || 'App'}
                  {aiDecision.diagnosis?.confidenceText ? ` · ${aiDecision.diagnosis.confidenceText} confidence` : ''}
                  {aiDecision.action?.label ? ` · chosen action: ${aiDecision.action.label}` : ''}
                </span>
                <span>{aiDecision.explanation}</span>
                {/* Answered on every notice, including when the answer is "no":
                    whether RC-Brain used either of its two tools on this incident.
                    The main process summarizes it; the fallback covers notices
                    recorded before that summary existed. */}
                <span className="muted">
                  ◈ {aiDecision.tools?.label
                    || (aiDecision.agents
                      ? (aiDecision.agents.tool === 'consult_runbook'
                        ? `Tool used on this incident: Consult the Runbook${aiDecision.agents.runbook?.matched ? ` matched ${aiDecision.agents.runbook.rule.label}` : ' with no exact signature matched, so the components were measured'}.`
                        : `Tool used on this incident: Dispatch specialist agents: ${(aiDecision.agents.spawned || []).map((agent) => agent.label).join(', ') || 'none answered'}.`)
                      : 'No tool was used on this incident: RC-Brain did not dispatch specialist agents and did not consult the Runbook.')}
                </span>
                {aiDecision.agents?.arbitration && (
                  <span className="muted">
                    ◈ Harmony: {aiDecision.agents.arbitration.summary || aiDecision.agents.arbitration.reason}
                  </span>
                )}
                {aiDecision.agents && Array.isArray(aiDecision.agents.facts) && aiDecision.agents.facts.length > 0 && (
                  <ul className="ai-evidence ai-agent-facts">
                    {aiDecision.agents.facts.slice(0, 5).map((fact, index) => <li key={`agent-${fact}-${index}`}>{fact}</li>)}
                  </ul>
                )}
                {Array.isArray(aiDecision.evidence) && aiDecision.evidence.length > 0 && (
                  <ul className="ai-evidence">
                    {aiDecision.evidence.slice(0, 4).map((fact, index) => <li key={`${fact}-${index}`}>{fact}</li>)}
                  </ul>
                )}
                {aiMessage && <span className="behavioral-repair-status">{aiMessage}</span>}
                {aiDecision.canRepair === false && (
                  <span className="muted">
                    Automatic repair has already run twice in the last ten minutes, so RC-Brain will not act again until it is asked.
                    {aiDecision.tools?.used
                      ? ' It used its tools on this incident, so the measurements behind this diagnosis are already in.'
                      : ' It used no tool on this incident.'}
                  </span>
                )}
                <span className="muted behavioral-disclaimer">RC-Brain may restart the app, repair its own folder or restart its engine. It cannot delete app data, change Windows settings or weaken isolation without your approval.</span>
              </>
            )}
          </div>
          <div className="detail-actions">
            {aiOutcome !== 'repaired' && EXECUTABLE_AI_ACTIONS.includes(aiDecision.action?.id) && (
              aiDecision.action?.requiresApproval
                ? (
                  <button className="settings-button" disabled={aiRepairing} onClick={() => handleAiRepair(true)}>Approve &amp; run repair</button>
                )
                : (
                  <button
                    className="settings-button"
                    disabled={aiRepairing || aiDecision.canRepair === false}
                    onClick={() => handleAiRepair(false)}
                  >
                    {aiRepairing ? 'Repairing…' : '⚡ Automated Environment Repair'}
                  </button>
                )
            )}
            <button className="icon-button" aria-label="Dismiss diagnosis" onClick={() => setAiDecision(null)}>×</button>
          </div>
        </div>
      )}

      {showInstallWizard && (
        <div className="modal-backdrop" onClick={() => setShowInstallWizard(false)}>
          <div className="detail-panel wizard-panel" onClick={(event) => event.stopPropagation()}>
            <div className="detail-header">
              <h3>Installing into RunContainer</h3>
              <button className="icon-button" onClick={() => setShowInstallWizard(false)}>×</button>
            </div>
            <p className="wizard-copy">RunContainer creates a folder for this app. It runs from there with its own app data, so it doesn’t mix with your other apps or get installed into the rest of your PC.</p>
            <div className="wizard-steps">
              <div className="wizard-step active">1. Validate app</div>
              <div className="wizard-step active">2. Create sandbox</div>
              <div className="wizard-step active">3. Register in launcher</div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "Apps" && activeSession ? (
        <div className="apps-panel session-shell">
          <div className="panel-title-row">
            <div className="detail-heading">
              <div className="app-icon">
                {activeSession.iconUrl && !failedIcons[activeSession.id]
                  ? <img src={activeSession.iconUrl} alt="" onError={() => markIconFailed(activeSession.id)} />
                  : <span className="app-icon-letter" aria-hidden="true">{(activeSession.name || '?').trim().charAt(0).toUpperCase()}</span>}
              </div>
              <div>
                <h2>{activeSession.status === 'Launching' ? 'Starting app' : activeSession.status === 'Running' ? 'App running' : activeSession.status === 'Unknown' ? 'App state unknown' : 'App stopped'}</h2>
                <span className="muted">{activeSession.name}{isolationLabel(activeSession) ? ` • ${isolationLabel(activeSession)}` : ''}</span>
              </div>
            </div>
            <div className="pill">{activeSession.status || 'Launching'}</div>
          </div>
          <div className="session-surface">
            <div className="session-surface-header">
              <div>
                <strong>{activeSession.name}</strong>
                <div className="muted">
                  {activeSession.status === 'Launching'
                    ? 'Waiting for RunContainer to confirm the process.'
                    : activeSession.status === 'Running'
                      ? activeSession.elevated
                        ? 'Running with administrator approval. Windows does not let the normal RunContainer window host an elevated window, so the app (or its installer wizard) opens inside a RunContainer administrator window. The Job Object caps and its own data folder still apply.'
                        : `${activeSession.windowHosted ? 'Shown in its own RunContainer window (visual only).' : 'Running. Its window opens in a RunContainer window.'}`
                      : 'All processes for this app have exited.'}
                </div>
                {(activeSession.status === 'Running' || activeSession.status === 'Unknown') && (
                  <div className="muted">
                    {activeSession.status === 'Unknown'
                      ? `State unknown${activeSession.statusNote ? `: ${activeSession.statusNote}` : '. Run checks again, Stop closes the app, Reset starts it fresh.'}`
                      : activeSession.isolated
                        ? 'Its files and settings stay in its own folder.'
                        : 'This app could not be kept in its own space, so it shares your normal Windows environment.'}
                  </div>
                )}
                {activeSession.status === 'Running' && activeSession.jitRun && (
                  <div className="muted">{activeSession.jitRun}</div>
                )}
              </div>
              <div className="detail-actions">
                {activeSession.status === 'Running' && <button className="settings-button ghost" onClick={() => handleKill(activeSession)}>Stop app</button>}
                {(activeSession.status === 'Running' || activeSession.status === 'Unknown') && <button className="settings-button ghost" onClick={() => handleReset(activeSession)}>Reset</button>}
                {(activeSession.hypervVm || activeSession.activeEngine === 'hyperv' || activeSession.activeEngine === 'qemu') && <button className="settings-button ghost" onClick={() => handleOpenDisplay(activeSession)}>Show app window</button>}
                <button className="settings-button" onClick={() => setActiveSession(null)}>Back to app list</button>
                {deletingId === activeSession.id
                  ? <button className="settings-button ghost" onClick={() => handleCancelDelete(activeSession)}>Cancel delete</button>
                  : <button className="settings-button ghost" onClick={() => handleDelete(activeSession)}>Delete app and its files</button>}
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === "Apps" && (
        <div className="apps-panel">
          <div className="panel-title-row">
            <div>
              <h2>My Apps</h2>
              <span className="muted">Managed apps · {appContainers.length}</span>
            </div>
          </div>

          {selectedExe && <p className="status-line">Selected: {selectedExe}</p>}
          <StatusLine message={installMessage} />
          <div className="container-list">
            {appContainers.length === 0 ? (
              <div className="empty-state">No apps installed yet. Use the + button to add your first EXE.</div>
            ) : (
              appContainers.map((container) => (
                <div key={container.id} className="container-item">
                  <div className="container-info">
                    <div className="app-icon">
                      {container.iconUrl && !failedIcons[container.id]
                        ? <img src={container.iconUrl} alt="" onError={() => markIconFailed(container.id)} />
                        : <span className="app-icon-letter" aria-hidden="true">{(container.name || '?').trim().charAt(0).toUpperCase()}</span>}
                    </div>
                    <div>
                      <div className="container-name">{container.name || container.metadata?.title || container.metadata?.originalName || 'Installed app'}</div>
                      <div className="container-status">
                        {container.metadata?.company ? `${container.metadata.company} • ` : ''}
                        {container.metadata?.version ? `${container.metadata.version} • ` : ''}Status: {container.status}{container.statusNote ? ` (${container.statusNote})` : ''}
                        {/* Only an explicit "the folder is gone" answer may say so. An older
                            record, or one that came from an action rather than the app list,
                            carries no flag at all, and undefined is not a missing folder. */}
                        {container.envDirPresent === false ? ' • folder missing' : ''}{container.diskPresent === false ? ' • missing its files' : ''}
                        {container.windowHosting === false ? ' • opens in its own window' : ''}
                        {isolationLabel(container) ? ` • ${isolationLabel(container)}` : ''}
                      </div>
                      {container.setupSummary && (
                        <div className="container-setup" role="note">
                          <span className="muted">
                            {container.setupProgram
                              ? `Setup program${container.setupFamilyName ? ` (${container.setupFamilyName})` : ''}: `
                              : 'Setup: '}
                            {container.setupSummary}
                          </span>
                          {container.setupProgram && container.setupFamily && container.status !== 'Running' && !container.installedExePath && (
                            <span className="muted">
                              {installerMode === 'manual'
                                ? 'Run opens the installer wizard inside a RunContainer window.'
                                : 'Run completes this setup unattended inside its environment, then starts the app it installs.'}
                            </span>
                          )}
                          {container.setupProgram && container.status === 'Running' && container.setupPlanMode === 'silent' && !container.installedExePath && formatSetupElapsed(container.setupStartedAt, setupClock) && (
                            <span className="muted">
                              Setup has been running for {formatSetupElapsed(container.setupStartedAt, setupClock)} · it is still
                              working inside this environment, and Run starts the app it produces.
                            </span>
                          )}
                          {container.installedExePath && (
                            <span className="muted">Run starts {container.installedAppName || 'the installed app'}.</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="container-actions">
                    <button className="settings-button" onClick={() => setSelectedApp(container)}>Manage</button>
                    <button className="settings-button" onClick={() => handleRun(container)}>Run</button>
                    <button className="settings-button ghost" onClick={() => handleKill(container)}>Close</button>
                    <details className="more-menu">
                      <summary className="settings-button ghost">More</summary>
                      <div className="more-menu-panel">
                        <button onClick={() => handleReset(container)}>Reset (keep data)</button>
                        <button onClick={() => handleDuplicate(container)}>Duplicate</button>
                        <button onClick={() => handleExport(container)}>Export info</button>
                        <button onClick={() => handleViewLogs(container)}>Logs</button>
                        {deletingId === container.id
                          ? <button onClick={() => handleCancelDelete(container)}>Cancel delete</button>
                          : <button className="danger" onClick={() => handleDelete(container)}>Delete</button>}
                      </div>
                    </details>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === "Sources" && (
        <div className="placeholder-panel">
          <h3>Sources</h3>
          <p>Import packages and sources from URLs, local repositories, or trusted app origins.</p>
          <div className="source-form">
            <input
              type="url"
              placeholder="Source URL"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
            />
            <div className="detail-actions">
              <button className="settings-button" onClick={() => handleImportFromUrl(sourceUrl)}>Import from URL</button>
              <button className="settings-button ghost" onClick={handleInstallExe}>Install local EXE</button>
            </div>
          </div>
        </div>
      )}

      {activeTab === "Tweaks" && (
        <div className="placeholder-panel">
          <h3>Tweaks</h3>
          <p>Launch arguments and resource limits for one app. Invalid values are rejected and not saved.</p>
          <div className="source-form">
            <label className="muted" htmlFor="tweak-app">App</label>
            <select
              id="tweak-app"
              value={tweakAppId || ""}
              onChange={(event) => {
                const id = event.target.value || null;
                setTweakAppId(id);
                const picked = appContainers.find((entry) => entry.id === id);
                if (picked) {
                  setTweakArgs(picked.launchArgs || "");
                  setTweakMemory(String(picked.vmMemoryMB || 4096));
                  setTweakCpu(String(picked.vmCpuCount || 2));
                  setTweakRuntime(picked.runtimeJit || "auto");
                }
              }}
            >
              <option value="">Select an app…</option>
              {appContainers.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>
              ))}
            </select>
            <label className="muted" htmlFor="tweak-args">Launch arguments</label>
            <input id="tweak-args" type="text" placeholder="e.g. --safe-mode" value={tweakArgs} onChange={(event) => setTweakArgs(event.target.value)} />
            <label className="muted" htmlFor="tweak-memory">Memory limit (MB, 512–32768)</label>
            <input id="tweak-memory" type="number" min="512" max="32768" value={tweakMemory} onChange={(event) => setTweakMemory(event.target.value)} />
            <label className="muted" htmlFor="tweak-cpu">CPU limit (1–16)</label>
            <input id="tweak-cpu" type="number" min="1" max="16" value={tweakCpu} onChange={(event) => setTweakCpu(event.target.value)} />
            <div className="detail-actions">
              <button className="settings-button" onClick={() => handleSaveTweaks(appContainers.find((entry) => entry.id === tweakAppId))} disabled={!tweakAppId}>Save tweaks</button>
            </div>
            <p className="muted">Memory and CPU limits apply the next time you press Run.</p>
          </div>
          {(() => {
            // JIT is a property of a runtime, not a dial for a native exe. This
            // card reports what the selected app actually runs on, and only
            // offers a strategy when the .NET runtime is the one doing the work.
            const picked = appContainers.find((entry) => entry.id === tweakAppId);
            const runtime = picked?.runtime;
            const isManaged = runtime?.kind === "dotnet";
            return (
              <div className="profile-list runtime-panel">
                <div className="profile-card active">
                  <strong>Runtime &amp; JIT</strong>
                  <span>
                    {runtime
                      ? `${runtime.label}${runtime.machine ? ` · ${runtime.machine}` : ""}${runtime.subsystem && runtime.subsystem !== "unknown" ? ` · ${runtime.subsystem}` : ""}`
                      : "Select an app to see what it runs on."}
                  </span>
                  <span className="muted">
                    {runtime?.jit || "Detection reads the app’s own executable header; nothing is launched."}
                  </span>
                </div>
                <div className="profile-card">
                  <strong>.NET JIT strategy</strong>
                  <span>
                    {isManaged
                      ? "The .NET runtime compiles this app’s IL itself. Pick how it balances startup work against long-run speed."
                      : "Not applicable: a native app is already machine code, so there is no JIT strategy to set."}
                  </span>
                  <div className="detail-actions">
                    <select
                      aria-label="JIT strategy"
                      value={tweakRuntime}
                      onChange={(event) => setTweakRuntime(event.target.value)}
                      disabled={!isManaged || !picked}
                    >
                      <option value="auto">Automatic (runtime default)</option>
                      <option value="fast-start">Fast start (less background compilation)</option>
                      <option value="throughput">Maximum speed (tiered compilation + PGO)</option>
                    </select>
                    <button
                      className="settings-button"
                      onClick={() => handleEnableJit(picked)}
                      disabled={!picked || jitRunning}
                      title={picked ? `Start ${picked.name} now with this JIT strategy` : 'Select an app first'}
                    >
                      {jitRunning ? 'Starting…' : 'Enable JIT'}
                    </button>
                  </div>
                  <span className="muted">
                    Enable JIT starts the app selected above straight away, with the strategy chosen here applied on the way in —
                    no second press. {picked?.lastRunWithJit
                      ? `This app was last started as a JIT run${picked.jitRuntimeKind === 'dotnet' ? ' (strategy applied)' : ''}.`
                      : ''}
                  </span>
                  {jitNote && <span className="muted">Note: {jitNote}</span>}
                  <span className="muted">
                    RunContainer runs on Electron’s V8, which already JIT-compiles JavaScript. That is built in, and there is no per-app switch for it.
                    Changes apply the next time you press Run.
                  </span>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {activeTab === "Profiles" && (
        <div className="placeholder-panel">
          <h3>Profiles</h3>
          <p>Choose how much access an app gets. Pick a profile for each app below.</p>
          <div className="profile-list">
            <div className="profile-card"><strong>default</strong><span>Normal access.</span></div>
            <div className="profile-card"><strong>relaxed</strong><span>Normal access, plus extra permissions for apps that ask for them.</span></div>
            <div className="profile-card"><strong>locked</strong><span>No network access. RunContainer can only block that when the app runs in a virtual machine or a restricted container.</span></div>
          </div>
          <div className="container-list">
            {appContainers.length === 0 ? (
              <div className="empty-state">No apps installed yet.</div>
            ) : (
              appContainers.map((container) => (
                <div key={container.id} className="container-item">
                  <div className="container-info">
                    <div>
                      <div className="container-name">{container.name || 'Installed app'}</div>
                      <div className="container-status">
                        Profile: {container.profile || 'default'}
                        {container.networkEnabled === false ? (canEnforceOffline ? ' • no network' : ' • no network requested (not enforced on this PC)') : ''}
                      </div>
                    </div>
                  </div>
                  <div className="container-actions">
                    {['default', 'relaxed', 'locked'].map((option) => (
                      <button key={option} className={`settings-button ${(container.profile || 'default') === option ? '' : 'ghost'}`} onClick={() => handleSetProfile(container, option)}>{option}</button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === "Settings" && (
        <div className="placeholder-panel">
          <h3>Settings</h3>
          <p>Nothing to set up. RunContainer decides how to keep each app apart from the rest of your PC.</p>
          <div className="profile-list">
            <div className={`profile-card companion-card ${companion?.running ? 'companion-on' : ''}`}>
              <div className="companion-heading">
                <strong>iPhone companion</strong>
                <span className="companion-pill">Experimental</span>
              </div>
              {companion?.running ? (
                <>
                  <span>
                    On. Use an app that is running on this PC from an iPhone. The app keeps running here; the phone is
                    its screen and keyboard.
                  </span>
                  <ol className="companion-steps">
                    <li>
                      Open this address in <strong>Safari</strong> on the iPhone:
                      <span className="companion-address">
                        {companion.urls?.length
                          ? companion.urls.map((entry) => <code key={entry.url}>{entry.url}</code>)
                          : <code>http://localhost:{companion.port}/</code>}
                      </span>
                      <button className="settings-button ghost" type="button" onClick={copyCompanionAddress}>
                        {companionCopied ? 'Copied' : 'Copy address'}
                      </button>
                    </li>
                    <li>Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. It then opens like an app.</li>
                    <li>
                      Type this code on the phone:
                      <span className="companion-code">{formatCompanionCode(companion.code) || 'Ask for a new code'}</span>
                    </li>
                  </ol>
                  <span className="muted">
                    The code works once and expires after five minutes. The phone keeps its place until you forget it.
                    {companion.connected > 0 ? ` ${companion.connected} phone${companion.connected === 1 ? '' : 's'} connected now.` : ''}
                  </span>
                  <span className="muted">
                    {companion.devices?.length
                      ? `Paired: ${companion.devices.map((entry) => entry.device).join(', ')}.`
                      : 'No phone is paired yet.'}
                    {' '}The PC must stay on, and the phone must reach it: the same Wi-Fi, or a private network such as
                    Tailscale when you are away. An address beginning with 100. is that private network.
                  </span>
                </>
              ) : (
                <>
                  <span>
                    Off. Turn it on to use an app from an iPhone: the phone shows an app that is already running here and
                    sends your taps and typing to it. Nothing is installed on the phone.
                  </span>
                  <span className="muted">
                    You need the PC switched on and the phone on the same Wi-Fi, or on a private network such as Tailscale
                    when you are away. It is experimental, and it shows one app window rather than your screen.
                  </span>
                </>
              )}
              <div className="detail-actions">
                <button
                  className={`settings-button ${companion?.running ? '' : 'ghost'}`}
                  onClick={toggleCompanion}
                  disabled={companionBusy}
                >
                  {companion?.running ? 'Turn off' : 'Turn on'}
                </button>
                {companion?.running && (
                  <button className="settings-button ghost" onClick={refreshCompanionCode} disabled={companionBusy}>
                    New code
                  </button>
                )}
                {companion?.running && companion.devices?.length > 0 && (
                  <button className="settings-button ghost" onClick={forgetCompanion} disabled={companionBusy}>
                    Forget paired phones
                  </button>
                )}
              </div>
            </div>
            <div className={`profile-card ${theme === 'dark' ? 'active' : ''}`}>
              <strong>Appearance</strong>
              <span>
                {theme === 'dark'
                  ? `Dark. The graphite and ${isNightly ? 'blue' : 'teal'} interface.`
                  : 'Light. The same interface on a pale, high-contrast surface for daylight and projectors.'}
              </span>
              <span className="muted">
                This changes colour only. No app, environment or file is affected, and the choice is remembered.
              </span>
              <div className="detail-actions">
                <button className={`settings-button ${theme === 'dark' ? '' : 'ghost'}`} onClick={() => chooseTheme('dark')}>Dark</button>
                <button className={`settings-button ${theme === 'light' ? '' : 'ghost'}`} onClick={() => chooseTheme('light')}>Light</button>
              </div>
            </div>
            {isNightly && <div className={`profile-card ${developerMode ? 'active' : ''}`}>
              <strong>Developer mode</strong>
              <span>
                {developerMode
                  ? 'On. The technical detail behind RC-Brain, the launch timings, and the Virtualise tab — which runs a whole operating system on RunContainer\u2019s QEMU backend — are shown.'
                  : 'Off. This is the normal interface. Turn it on for the technical detail behind RC-Brain, the launch timings, and a Virtualise tab that runs a whole operating system inside its own window, separate from your PC. Nothing else about the app changes.'}
              </span>
              <span className="muted">
                Experimental features can be buggy. This choice stays on until you turn it off.
              </span>
              <div className="detail-actions">
                <button className={`settings-button ${developerMode ? '' : 'ghost'}`} onClick={toggleDeveloperMode}>
                  {developerMode ? 'Turn off developer mode' : 'Enable developer mode'}
                </button>
              </div>
            </div>}
            <div className={`profile-card ${installerMode === 'auto' ? 'active' : ''}`}>
              <strong>Installers</strong>
              <span>
                {installerMode === 'auto'
                  ? 'Run completes a supported installer unattended, inside its own environment, and starts the app it installs. The RunContainer window shows the setup’s progress until then.'
                  : 'Run opens the installer’s own wizard inside a RunContainer window, so you complete setup yourself. Nothing installs outside the app’s environment.'}
              </span>
              <span className="muted">
                Only installers with documented unattended switches are completed automatically; every other
                installer always shows its wizard. Changing this applies to the next Run — no restart needed.
              </span>
              <div className="detail-actions">
                <button
                  className={`settings-button ${installerMode === 'auto' ? '' : 'ghost'}`}
                  onClick={() => chooseInstallerMode('auto')}
                >
                  Complete them automatically
                </button>
                <button
                  className={`settings-button ${installerMode === 'manual' ? '' : 'ghost'}`}
                  onClick={() => chooseInstallerMode('manual')}
                >
                  Show the installer wizard
                </button>
              </div>
            </div>
            <div className="profile-card active">
              <strong>Each app runs in its own space</strong>
              <span>
                {qemuStatus?.available
                  ? 'Apps keep their own files, and on this PC they also run inside a small virtual machine for a stronger boundary.'
                  : 'Apps keep their own files and processes, separate from your other apps and the rest of your PC.'}
              </span>
              <div className="detail-actions">
                <button className="settings-button ghost" onClick={handleDetectQemu}>Check again</button>
              </div>
            </div>
            <div className="profile-card">
              <strong>Where app files live</strong>
              <span>Each app has its own folder under RunContainer’s data directory. Duplicate gives a second copy with separate data, and Delete removes that app’s folder.</span>
            </div>
            <div className="profile-card">
              <strong>Logs</strong>
              <span>Launch, stop and exit events are written to each app’s log, which you can open with the Logs button.</span>
            </div>
          </div>

          {developerMode && (
          <div className="profile-list performance-panel">
            <div className="profile-card">
              <strong>Performance on this PC</strong>
              <span className="muted">{performanceInfo?.backend || "RCVM containment: Job Object caps and a per-app profile."}</span>
              {performanceInfo?.sampleCount > 0 ? (
                <>
                  <span>
                    Last launch: <strong>{performanceInfo.lastLaunchMs} ms</strong>
                    {performanceInfo.lastAppName ? ` (${performanceInfo.lastAppName})` : ""}. Median of the last {performanceInfo.sampleCount} launch{performanceInfo.sampleCount === 1 ? "" : "es"}: <strong>{performanceInfo.medianLaunchMs} ms</strong>.
                  </span>
                  <span className="muted">
                    Measured from the moment you press Run to the moment containment is confirmed; application readiness is not included. These numbers are recorded locally and never uploaded.
                  </span>
                </>
              ) : (
                <span className="muted">
                  No launch has been measured yet. Press Run once and the time from request to confirmed containment appears here.
                </span>
              )}
              <span className="muted">
                Running apps are checked every {Math.round((performanceInfo?.monitorIntervalMs || 5000) / 1000)} seconds. Each check queries Windows for the app’s processes, so this interval is the main background cost.
              </span>
            </div>
          </div>
          )}

          <div className="ai-panel">
          <div className="panel-title-row">
            <div>
              <h3>RC-Brain</h3>
              <span className="muted">RunContainer’s own on-device model</span>
            </div>
            <div className="pill">{aiStatus?.available ? 'Loaded' : 'Unavailable'}</div>
          </div>
          <p>
            RC-Brain watches the apps RunContainer starts and tells you what it thinks is wrong when one misbehaves. It runs on this
            PC, and its explanations and repairs are the only things it offers — it cannot touch your files or weaken isolation.
          </p>
          <div className="profile-list">
            <div className="profile-card active">
              <strong>{aiStatus?.model?.name || 'RC-Brain'}{aiStatus?.model?.version ? ` ${aiStatus.model.version}` : ''}</strong>
              <span>
                A small model that runs on this PC. It watches the apps RunContainer starts, notices when one stops behaving
                normally, and says what it thinks is wrong and what to try next.
              </span>
              <span className="muted">
                Trained {aiStatus?.model?.createdAt ? new Date(aiStatus.model.createdAt).toLocaleDateString() : 'unknown'} · works offline, and never uploads anything.
              </span>
            </div>
            {developerMode && (
            <>
            <div className="profile-card">
              <strong>Held-out evaluation</strong>
              <span>
                {aiStatus?.model?.evaluation?.familiar
                  ? `Familiar cases: ${(aiStatus.model.evaluation.familiar.diagnosisAccuracy * 100).toFixed(1)}% diagnosis. Unseen failure families: ${(aiStatus.model.evaluation.unseen.diagnosisAccuracy * 100).toFixed(1)}%. Final untouched split: ${(aiStatus.model.evaluation.final.diagnosisAccuracy * 100).toFixed(1)}%. False positives on normal behaviour: ${(aiStatus.model.evaluation.familiar.falsePositiveRate * 100).toFixed(1)}%.`
                  : aiStatus?.model?.evaluation
                    ? `${(aiStatus.model.evaluation.diagnosisAccuracy * 100).toFixed(1)}% diagnosis accuracy across ${aiStatus.model.evaluation.samples} held-out scenarios.`
                    : 'The evaluation results ship inside the model artefact and appear here once it is loaded.'}
              </span>
              <span className="muted">
                All evaluation scenarios are synthetic and built from RunContainer’s own code and tests; no user logs or machines were used. Unseen-family numbers are lower on purpose: they measure generalisation, not memorisation.
              </span>
            </div>
            <div className="profile-card">
              <strong>What the model can and cannot do</strong>
              <span>
                {aiStatus?.capabilities
                  ? `Fixed-label classifier: ${aiStatus.capabilities.diagnosisLabels} diagnoses, ${aiStatus.capabilities.actionLabels} actions. It reads structured observation features, not arbitrary log text, and cannot invent a diagnosis outside its labels. Unknown evidence becomes “unknown failure” plus “gather more evidence”.`
                  : 'Capabilities are reported by the loaded model.'}
              </span>
              <span className="muted">
                {aiStatus?.model?.parameters ? `${aiStatus.model.parameters.toLocaleString()} parameters, ` : ''}
                {aiStatus?.model?.features ? `${aiStatus.model.features} observation features, ` : ''}
                diagnosis head {aiStatus?.model?.hiddenLayers?.diagnosis?.join('×') || '—'}, action head {aiStatus?.model?.hiddenLayers?.action?.join('×') || '—'}.
              </span>
              <span className="muted">
                Model file: {aiStatus?.registry?.current || 'unknown'} · previous for rollback: {aiStatus?.registry?.previous || 'none'} · knowledge {aiStatus?.knowledgeVersion || 'unknown'}
              </span>
              <div className="detail-actions">
                <button className="settings-button ghost" disabled={aiWorking || !aiStatus?.registry?.previous} onClick={handleRollbackModel}>Roll back model</button>
              </div>
            </div>
            </>
            )}
            <div className="profile-card">
              <strong>Monitoring</strong>
              <span>Checks running apps every few seconds while RunContainer is open. It is not a Windows service and stops when the app closes.</span>
              {aiStatus?.monitor && (
                <span className="muted">
                  {aiStatus.monitor.running
                    ? `Running: ${Number(aiStatus.monitor.ticks || 0).toLocaleString()} checks done, last check ${describeLastCheck(aiStatus.monitor.lastTickAt)}, ${aiStatus.monitor.watchedApps || 0} running app(s) watched.`
                    : 'The monitor is not running.'}
                </span>
              )}
              <div className="detail-actions">
                <button className={`settings-button ${aiStatus?.enabled ? '' : 'ghost'}`} onClick={handleToggleAiMonitoring}>
                  {aiStatus?.enabled ? 'Pause monitoring' : 'Start monitoring'}
                </button>
              </div>
            </div>
            <div className="profile-card">
              <strong>What it may do on its own</strong>
              {Array.isArray(aiStatus?.permissions) ? (
                <>
                  <span>
                    May run automatically:{' '}
                    {aiStatus.permissions.filter((entry) => entry.autonomous && !entry.requiresApproval && entry.risk !== 'none').map((entry) => entry.label).join(', ') || 'none'}.
                  </span>
                  <span>
                    Needs your approval:{' '}
                    {aiStatus.permissions.filter((entry) => entry.requiresApproval).map((entry) => entry.label).join(', ') || 'none'}.
                  </span>
                  <span className="muted">
                    This list is read from the action catalogue shipped with this build. It never installs system software, deletes app files, weakens isolation, or follows instructions written in a log.
                  </span>
                </>
              ) : (
                <span>Restart the app, restart its isolation engine, or repair access to its own folder. Clearing the app’s profile needs approval. It never installs system software, deletes app files, weakens isolation, or follows instructions written in a log.</span>
              )}
            </div>
            <div className="profile-card">
              <strong>Privacy</strong>
              <span>Inference happens on this PC. Nothing is uploaded unless this build has been given an explicit, configured registry endpoint, and then only an anonymised diagnosis with no paths, names or log text beyond the scrubbed snippet.</span>
            </div>
          </div>

          {!aiStatus?.available && (
            <p className="status-line">RC-Brain is not loaded{aiStatus?.error ? `: ${aiStatus.error}` : '.'} Monitoring will not diagnose or repair anything until it is available.</p>
          )}

          {developerMode && (
          <>
          <h4>Verified outcomes and experience</h4>
          <div className="profile-card">
            <strong>Repair verification</strong>
            <span>
              {aiVerification?.verdict
                ? `${aiVerification.verdict.status.replace('_', ' ')}: ${aiVerification.verdict.detail} (${aiVerification.verdict.observedChecks} check(s)).`
                : `After a repair, RC-Brain waits for ${aiStatus?.verification?.minObservations || 3} consecutive observations and re-checks the original condition. A restart alone is not counted as success.`}
            </span>
            <span className="muted">
              Verified: {aiStatus?.experiences?.verified || 0} · unresolved: {aiStatus?.experiences?.failed || 0} · inconclusive: {aiStatus?.experiences?.inconclusive || 0} · promoted to curated data: {aiStatus?.experiences?.promoted || 0}
            </span>
          </div>
          <div className="profile-card">
            <strong>Learning loop (honest version)</strong>
            <span>
              History remembers incidents. Retrieval shows similar past incidents next to a diagnosis. Verified outcomes can be added to a local curated dataset with your consent.
              None of those change the model’s weights. Weights only change through an offline, gated training run, and the previous model stays available for rollback.
            </span>
            <span className="muted">
              Curated examples: {aiStatus?.candidate?.examples || 0} (minimum {aiStatus?.candidate?.minExamples || 20} to train a candidate). Pending review: {aiStatus?.experiences?.pendingPromotion || 0}.
            </span>
            <div className="detail-actions">
              <button className="settings-button" disabled={aiWorking} onClick={handlePromoteExperiences}>Promote verified examples</button>
            </div>
            <span className="muted">{aiStatus?.candidate?.note}</span>
          </div>
          {aiExperiences.length > 0 && (
            <div className="ai-history">
              {aiExperiences.slice(0, 5).map((entry) => (
                <div className="ai-history-row" key={entry.id}>
                  <div>
                    <strong>{entry.diagnosis?.id || 'Diagnosis'} → {entry.action?.id || 'action'}</strong>
                    <span className="muted"> {entry.app?.name || 'App'} · {entry.verification?.status || entry.outcome} · {new Date(entry.at).toLocaleString()}</span>
                  </div>
                  <div className="muted">{entry.action?.justification || ''}</div>
                </div>
              ))}
            </div>
          )}

          <h4>Recent diagnoses</h4>
          {aiHistory.length === 0 ? (
            <p className="muted">No diagnoses yet. RC-Brain only records a decision when something departs from normal behaviour.</p>
          ) : (
            <div className="ai-history">
              {aiHistory.slice(0, 8).map((entry, index) => (
                <div className="ai-history-row" key={`${entry.detectedAt || 'decision'}-${index}`}>
                  <div>
                    <strong>{entry.diagnosis?.summary || entry.diagnosis?.id || 'Diagnosis'}</strong>
                    <span className="muted"> {entry.name || 'App'} · {entry.diagnosis?.confidenceText || ''} · {entry.action?.label || ''} · {entry.outcome}</span>
                  </div>
                  <div className="muted">{entry.explanation}</div>
                  {entry.agents && (
                    <div className="muted ai-agent-row">
                      Agents: {(entry.agents.spawned || []).map((agent) => agent.label).join(', ') || 'none'}
                      {Array.isArray(entry.agents.facts) && entry.agents.facts.length > 0 ? ` · ${entry.agents.facts.slice(0, 2).join(' · ')}` : ''}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {(aiStatus?.capabilities?.specialistAgents || []).length > 0 && (
            <>
              <h4>Specialist evidence agents</h4>
              <p className="muted">
                When the evidence is incomplete, the model can dispatch these fixed agents. Each one measures a single
                component and reports; none of them can start, stop, repair or delete anything, and the model cannot
                author one or give it arguments. Dispatch happens at most once per incident, and the model decides again
                with the completed evidence.
              </p>
              <div className="ai-history">
                {(aiStatus.agents?.catalogue || []).map((agent) => (
                  <div className="ai-history-row" key={agent.id}>
                    <div>
                      <strong>{agent.label}</strong>
                      <span className="muted"> registered: {agent.available ? 'yes' : 'no probe in this build'}</span>
                    </div>
                    <div className="muted">{agent.purpose}</div>
                  </div>
                ))}
              </div>
              {(aiStatus?.agents?.specialists || []).length > 0 && (
                <>
                  <h4>Reasoning agents</h4>
                  <p className="muted">
                    Dispatched by the same action, after the measurements. They are not neural networks: each one works
                    from RunContainer’s own documentation and from what the probes just measured, and the harmony
                    agent reports rather than forces a decision when the model and the expert disagree.
                  </p>
                  <div className="ai-history">
                    {(aiStatus.agents.specialists || []).map((agent) => (
                      <div className="ai-history-row" key={agent.id}>
                        <div>
                          <strong>{agent.label}</strong>
                        </div>
                        <div className="muted">{agent.purpose}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {(aiStatus?.agents?.tools || []).length > 0 && (
                <>
                  <h4>The model’s two tools</h4>
                  <div className="ai-history">
                    {(aiStatus.agents.tools || []).map((tool) => (
                      <div className="ai-history-row" key={tool.id}>
                        <div>
                          <strong>{tool.label}</strong>
                          <span className="muted"> {tool.id}</span>
                        </div>
                        <div className="muted">{tool.description}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          <p className="muted">Limits: {(aiStatus?.limits || []).join(' ')}</p>
          </>
          )}
          </div>
        </div>
      )}

      {activeTab === "Virtualise" && (
        <VirtualiseTab />
      )}

      {activeTab === "Info" && (
        <div className="placeholder-panel info-panel">
          <h3>What RunContainer is</h3>
          <p>RunContainer is a launcher for Windows apps, like a container for your programs. Each app gets its own folder and always starts inside it, never installed into the rest of your PC.</p>
          <div className="profile-list">
            <div className="profile-card active">
              <strong>How it works</strong>
<span>Install an app and press Run. It starts from its own folder with its own app data, and closes with everything it started.</span>
            </div>
            <div className="profile-card">
              <strong>What it keeps apart</strong>
<span>Each app gets its own folder for files and settings, so it doesn’t mix with your other apps or get installed into the rest of your PC.</span>
            </div>
            <div className="profile-card">
              <strong>One honest limit</strong>
<span>A program that saves settings in shared Windows places, such as the registry, can still leave traces outside its folder. RunContainer keeps the app together without locking down all of Windows.</span>
            </div>
            <div className="profile-card">
              <strong>Use cases</strong>
              <span>Use it to keep common app data separate, test software, and remove an app together with its managed profile.</span>
            </div>
            <div className="profile-card">
              <strong>Lifecycle</strong>
              <span>Run starts the app and confirms its process is running. Close or Stop ends the app’s processes. Delete ends them and removes the app and its folder.</span>
            </div>
            <div className="profile-card">
              <strong>Beta notice</strong>
              <span>
                RunContainer is still in beta, so bugs may appear. If you hit one, ask in the
                {" "}
                <a
                  className="info-link"
                  href={DISCORD_URL}
                  onClick={(event) => handleOpenProjectLink(event, DISCORD_URL)}
                >
                  RunContainer Discord server
                </a>
                .
              </span>
            </div>
          </div>
          <div className="panel-section">
            <h3>Completely free</h3>
            <p>RunContainer is free forever and open source. There are no paid tiers, no locked features, and no trial countdown.</p>
            <div className="profile-list">
              <div className="profile-card active">
                <strong>Free forever</strong>
                <span>You can use every feature without paying. The app stays free for personal and everyday use.</span>
              </div>
              <div className="profile-card">
                <strong>Open source</strong>
                <span>The code is public and transparent, so you can inspect how it works, suggest changes, or build on it yourself.</span>
              </div>
            </div>
          </div>
          <div className="panel-section">
            <h3>Support &amp; documentation</h3>
            <p>The documentation is the official reference for setup, guides, troubleshooting and release notes.</p>
            <div className="profile-list">
              <div className="profile-card active">
                <strong>Documentation</strong>
                <span>Installation, first launch, everyday guides, safety notes and known limitations.</span>
                <div className="detail-actions">
                  <a
                    className="settings-button info-link-button"
                    href={DOCS_URL}
                    onClick={(event) => handleOpenProjectLink(event, DOCS_URL)}
                  >
                    Open documentation
                  </a>
                </div>
              </div>
              <div className="profile-card">
                <strong>Video guides</strong>
                <span>
                  Watch the RunContainer YouTube channel to see how it works: installing your first
                  app, keeping apps apart, and each feature demonstrated step by step. The videos are
                  a good place to get help when a written guide is not enough.
                </span>
                <div className="detail-actions">
                  <a
                    className="settings-button info-link-button"
                    href={YOUTUBE_URL}
                    onClick={(event) => handleOpenProjectLink(event, YOUTUBE_URL)}
                  >
                    Watch on YouTube
                  </a>
                </div>
              </div>
              <div className="profile-card">
                <strong>Community</strong>
                <span>
                  Join the{" "}
                  <a
                    className="info-link"
                    href={DISCORD_URL}
                    onClick={(event) => handleOpenProjectLink(event, DISCORD_URL)}
                  >
                    RunContainer Discord server
                  </a>{" "}
                  for questions, bug reports and release announcements.
                </span>
              </div>
              <div className="profile-card">
                <strong>Support RunContainer</strong>
                <span>If you enjoy RunContainer, please give the project a star on GitHub.</span>
                <div className="detail-actions">
                  <a className="settings-button info-link-button" href={GITHUB_URL} onClick={(event) => handleOpenProjectLink(event, GITHUB_URL)}>Star on GitHub</a>
                </div>
              </div>
              <div className="profile-card">
                <strong>Links open in your browser</strong>
                <span>RunContainer only opens its own documentation, YouTube channel, Discord server and GitHub pages. Every other address is refused.</span>
              </div>
            </div>
          </div>
          <p className="muted info-version">RunContainer v{appVersion}</p>
        </div>
      )}

      {activeTab === "Updates" && (
        <div className="placeholder-panel updates-panel">
          <div className="panel-title-row">
            <div>
              <h3>Updates</h3>
              <span className="muted">RunContainer v{appVersion} • installed version</span>
            </div>
            <div className="pill">Current: v{appVersion}</div>
          </div>
          <div className="detail-actions">
            <button className="settings-button" onClick={() => handleCheckUpdates(true)} disabled={updateChecking}>{updateChecking ? 'Checking…' : 'Check for updates'}</button>
            {updateInfo?.status === 'update-available' && (
              <button className="settings-button ghost" onClick={openUpdateWizard}>Update…</button>
            )}
          </div>
          {updateInfo && (
            <details className="profile-card update-diagnostics">
              <summary>Update check diagnostics</summary>
              <span>Installed: v{appVersion} • Status: {updateInfo.status}{updateInfo.latestVersion ? ` • Latest seen: v${updateInfo.latestVersion}` : ''}</span>
              {updateInfo.reason && <span className="muted">{updateInfo.reason}</span>}
              <span className="muted">New installers are attached to each {isNightly ? 'Nightly prerelease' : 'stable release'} on GitHub; this check never installs anything by itself.</span>
            </details>
          )}
          {updateInfo?.status === 'update-available' && (
            <div className="profile-card active update-available">
              <strong>v{updateInfo.latestVersion} available — you have v{appVersion}</strong>
              <span>{updateInfo.releaseName || `A new ${isNightly ? 'nightly' : 'stable'} release is out.`} Get the installer from the GitHub release.</span>
              <div className="detail-actions">
                {updateInfo.installerUrl && <button className="settings-button" onClick={() => handleOpenUpdateLink('installer')}>Download installer</button>}
                {updateInfo.releaseUrl && <button className="settings-button ghost" onClick={() => handleOpenUpdateLink('release')}>View release</button>}
              </div>
            </div>
          )}
          {updateInfo?.status === 'up-to-date' && (
            <p className="muted">You are on the latest release.</p>
          )}
          <div className="updates-list-head">
            <strong>{isNightly ? 'Nightly releases' : 'Stable releases'}</strong>
            <span className="muted">{visibleUpdates.length} {visibleUpdates.length === 1 ? 'release' : 'releases'}</span>
          </div>
          <div className="updates-list">
            {visibleUpdates.map((entry) => {
              const isCurrent = entry.version === appVersion;
              const isOpen = openUpdates[entry.version] === undefined ? isCurrent : openUpdates[entry.version];
              return (
                <details
                  key={`${entry.version}-${entry.date}`}
                  className={`update-card ${isCurrent ? 'current' : ''}`}
                  open={isOpen}
                  onToggle={(event) => {
                    const next = event.currentTarget.open;
                    if (next === isOpen) return;
                    setOpenUpdates((previous) => ({ ...previous, [entry.version]: next }));
                  }}
                >
                  <summary className="update-summary">
                    <span className="update-head">
                      <strong>v{entry.version}</strong>
                      {isCurrent && <span className="pill">Installed</span>}
                      <span className="muted update-meta">{entry.date}</span>
                    </span>
                    <span className="update-title">{entry.title}</span>
                  </summary>
                  <ul className="update-changes">
                    {entry.changes.map((change, index) => (
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </div>
      )}

      {showUpdateWizard && updateInfo?.status === 'update-available' && (
        <div className="modal-backdrop" onClick={() => setShowUpdateWizard(false)}>
          <div className="detail-panel wizard-panel" onClick={(event) => event.stopPropagation()}>
            <div className="detail-header">
              <h3>Update to v{updateInfo.latestVersion}</h3>
              <button className="icon-button" onClick={() => setShowUpdateWizard(false)}>×</button>
            </div>
            <div className="wizard-steps">
              <div className="wizard-step active">1. You have v{appVersion}; v{updateInfo.latestVersion} is ready{updateInfo.releaseName ? `: ${updateInfo.releaseName}` : ''}.</div>
              <div className="wizard-step active">2. {updateInfo.releaseNotes ? updateInfo.releaseNotes.slice(0, 500) : 'See the Updates tab for the changelog.'}</div>
              <div className="wizard-step active">3. Download the installer, then install over your current copy — apps and settings are kept.</div>
            </div>
            {wizardStep === 'downloading' && (
              <p className="status-line">{downloadProgress?.percent != null
                ? `Downloaded ${(downloadProgress.received / 1048576).toFixed(1)} MB of ${(downloadProgress.total / 1048576).toFixed(1)} MB (${downloadProgress.percent}%)…`
                : `Downloaded ${((downloadProgress?.received || 0) / 1048576).toFixed(1)} MB…`}</p>
            )}
            {wizardMessage && <p className="status-line">{wizardMessage}</p>}
            <div className="detail-actions">
              {wizardStep !== 'ready'
                ? <button className="settings-button" onClick={handleDownloadUpdate} disabled={wizardStep === 'downloading'}>{wizardStep === 'downloading' ? 'Downloading…' : 'Download installer'}</button>
                : <button className="settings-button" onClick={handleInstallUpdate}>Install & restart</button>}
              {wizardStep === 'downloading' && <button className="settings-button ghost" onClick={handleCancelDownload}>Cancel</button>}
              {updateInfo.releaseUrl && <button className="settings-button ghost" onClick={() => handleOpenUpdateLink('release')}>View release</button>}
              <button className="settings-button ghost" onClick={handleSnoozeTomorrow}>Remind tomorrow</button>
            </div>
          </div>
        </div>
      )}

      {selectedApp && (
        <div className="modal-backdrop" onClick={() => setSelectedApp(null)}>
          <div className="detail-panel" onClick={(event) => event.stopPropagation()}>
            <div className="detail-header">
              <h3>{selectedApp.name}</h3>
              <button className="icon-button" onClick={() => setSelectedApp(null)}>×</button>
            </div>
            <div className="detail-grid">
              <div>
                <h4>Folder</h4>
                <p>{selectedApp.sandboxRoot}</p>
              </div>
              <div>
                <h4>Logs</h4>
                <div className="log-viewer">
                  {logs.length === 0 ? <p>No logs available yet.</p> : logs.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}
                </div>
              </div>
              <div>
                <h4>Isolation</h4>
                <p className="muted">This app runs in its own managed environment. RunContainer chooses the isolation it can use on this PC.</p>
                <p className="muted">Profile: {selectedApp.profile || 'default'}. Change it in the Profiles tab.</p>
                {selectedApp.isolationEngine && selectedApp.isolationEngine !== 'auto' && (
                  <div className="detail-actions">
                    <button className="settings-button ghost" onClick={() => handleUseAutomatic(selectedApp)}>Use automatic</button>
                  </div>
                )}
              </div>
              <div>
                <h4>Display</h4>
                <div>
                  <p className="muted">
                    {selectedApp.windowHosting === false
                      ? 'The app opens in its own window.'
                      : 'RunContainer shows the app in an app window of its own, with Stop, Release window and a way back to the main window. This changes how the app looks, not what it can reach, and Windows can still refuse (an app that asks for administrator rights cannot be hosted).'}
                  </p>
                  <div className="detail-actions">
                    {selectedApp.windowHosting === false
                      ? <button className="settings-button ghost" onClick={() => handleSetWindowHosting(selectedApp, true)}>Show inside RunContainer</button>
                      : <button className="settings-button ghost" onClick={() => handleSetWindowHosting(selectedApp, false)}>Open in its own window</button>}
                    {(selectedApp.hypervVm || selectedApp.activeEngine === 'hyperv' || selectedApp.activeEngine === 'qemu') && (
                      <button className="settings-button ghost" onClick={() => handleOpenDisplay(selectedApp)}>Show app window</button>
                    )}
                  </div>
                </div>
              </div>
              <div>
                <h4>Actions</h4>
                <div className="detail-actions">
                  <button className="settings-button" onClick={() => handleRun(selectedApp)}>Run</button>
                  <button className="settings-button ghost" onClick={() => handleKill(selectedApp)}>Close</button>
                  <button className="settings-button ghost" onClick={() => handleReset(selectedApp)}>Reset (fresh state, keep data)</button>
                  {deletingId === selectedApp.id
                    ? <button className="settings-button ghost" onClick={() => handleCancelDelete(selectedApp)}>Cancel delete</button>
                    : <button className="settings-button ghost" onClick={() => handleDelete(selectedApp)}>Delete</button>}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showBeginnerSetup && (
        <BeginnerSetup
          version={appVersion}
          onFinish={finishBeginnerSetup}
          onOpenLink={openExternalUrl}
        />
      )}

      <div className="bottom-nav">
        {visibleTabs.map((tab) => (
          <button
            key={tab}
            className={`nav-button ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            <span className="nav-icon">{tabIcons[tab]}</span>
            <span>{tab}</span>
          </button>
        ))}
      </div>
    </div>
  );
}