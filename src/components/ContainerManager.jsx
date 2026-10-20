import React, { useEffect, useMemo, useState } from "react";
import { installContainer, importFromUrl, runContainer, killContainer, resetContainer, duplicateContainer, exportContainer, getAppLogs, onContainerStatus, cancelDeleteContainer, setIsolationEngine, setWindowHosting, getAppVersion, getHyperVStatus, setAppConfig, setAppProfile, resetEnvironment, openGuestDisplay, checkAppUpdates, openUpdateLink, snoozeUpdate, downloadUpdate, cancelUpdateDownload, getUpdateState, installDownloadedUpdate, onUpdateDownloadProgress, getQemuStatus, detectQemu, openExternalUrl } from "../services/containerService";
import useContainers from "../hooks/useContainers";
import { UPDATES } from "../data/updates";

function useBootAnimation() {
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setBooting(false), 900);
    return () => window.clearTimeout(timer);
  }, []);

  return booting;
}
// Used only until the main process reports the version from package.json.
const APP_VERSION_FALLBACK = "0.6.4";
// The only two project links the app opens, both official and public.
const DOCS_URL = "https://runcontainer-7.github.io/9-runcontainer/";
const DISCORD_URL = "https://discord.gg/rvMjMZJykE";
const tabs = ["Sources", "Apps", "Tweaks", "Settings", "Profiles", "Info", "Updates"];
const tabIcons = {
  Sources: "◫",
  Apps: "▣",
  Tweaks: "✧",
  Settings: "⚙",
  Profiles: "◧",
  Info: "◌",
  Updates: "↓",
};

export default function ContainerManager() {
  const { containers, addContainer, removeContainer, updateContainerStatus, refreshContainers } = useContainers();
  const [activeTab, setActiveTab] = useState("Apps");
  const [showInstallMenu, setShowInstallMenu] = useState(false);
  const [selectedExe, setSelectedExe] = useState(null);
  const [installMessage, setInstallMessage] = useState("");
  const [selectedApp, setSelectedApp] = useState(null);
  const [logs, setLogs] = useState([]);
  const [sourceUrl, setSourceUrl] = useState("");
  const [showInstallWizard, setShowInstallWizard] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  const [hypervStatus, setHypervStatus] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateChecking, setUpdateChecking] = useState(false);
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
  const booting = useBootAnimation();

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
        setInstallMessage(`App window opened for ${container.name}.`);
      })
      .catch((error) => {
        setInstallMessage(`Could not open the app window: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleSaveTweaks(container) {
    if (!container) return;
    // Network follows the profile only; saving tweaks must not turn a locked app
    // back online by writing a default networkEnabled.
    setAppConfig({ id: container.id, launchArgs: tweakArgs, vmMemoryMB: Number(tweakMemory), vmCpuCount: Number(tweakCpu) })
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
    setInstallMessage(`Starting ${container.name} in its RunContainer container...`);
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
        <div>
          <div className="eyebrow">Per-app profile launcher</div>
          <div className="header-title">RunContainer</div>
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

      {activeSession ? (
        <div className="apps-panel session-shell">
          <div className="panel-title-row">
            <div>
              <h2>{activeSession.status === 'Launching' ? 'Starting app' : activeSession.status === 'Running' ? 'App running' : activeSession.status === 'Unknown' ? 'App state unknown' : 'App stopped'}</h2>
              <span className="muted">{activeSession.name}{isolationLabel(activeSession) ? ` • ${isolationLabel(activeSession)}` : ''}</span>
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
                      ? `${activeSession.windowHosted ? 'Shown inside RunContainer (visual only, experimental).' : 'Running in its own window.'}`
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
              </div>
              <div className="detail-actions">
                {activeSession.status === 'Running' && <button className="settings-button ghost" onClick={() => handleKill(activeSession)}>Stop app</button>}
                {(activeSession.status === 'Running' || activeSession.status === 'Unknown') && <button className="settings-button ghost" onClick={() => handleReset(activeSession)}>Reset</button>}
                {(activeSession.hypervVm || activeSession.activeEngine === 'hyperv') && <button className="settings-button ghost" onClick={() => handleOpenDisplay(activeSession)}>Show app window</button>}
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
          {installMessage && <p className="status-line">{installMessage}</p>}
          <div className="container-list">
            {appContainers.length === 0 ? (
              <div className="empty-state">No apps installed yet. Use the + button to add your first EXE.</div>
            ) : (
              appContainers.map((container) => (
                <div key={container.id} className="container-item">
                  <div className="container-info">
                    <div className="app-icon">
                      {container.iconPath ? <img src={container.iconPath.startsWith('http') ? container.iconPath : `file://${container.iconPath}`} alt={container.name} /> : '📱'}
                    </div>
                    <div>
                      <div className="container-name">{container.name || container.metadata?.title || container.metadata?.originalName || 'Installed app'}</div>
                      <div className="container-status">
                        {container.metadata?.company ? `${container.metadata.company} • ` : ''}
                        {container.metadata?.version ? `${container.metadata.version} • ` : ''}Status: {container.status}{container.statusNote ? ` (${container.statusNote})` : ''}
                        {!container.envDirPresent ? ' • folder missing' : ''}{container.diskPresent === false ? ' • missing its files' : ''}
                        {isolationLabel(container) ? ` • ${isolationLabel(container)}` : ''}
                      </div>
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
        </div>
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
                <strong>Links open in your browser</strong>
                <span>RunContainer only opens its own documentation, Discord server and GitHub pages. Every other address is refused.</span>
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
            <div className="profile-card update-diagnostics">
              <strong>Update check diagnostics</strong>
              <span>Installed: v{appVersion} • Status: {updateInfo.status}{updateInfo.latestVersion ? ` • Latest seen: v${updateInfo.latestVersion}` : ''}</span>
              {updateInfo.reason && <span className="muted">{updateInfo.reason}</span>}
              <span className="muted">New installers are attached to each stable GitHub Release; this check only reads the release feed and never installs anything by itself.</span>
            </div>
          )}
          {updateInfo?.status === 'update-available' && (
            <div className="profile-card active update-available">
              <strong>v{updateInfo.latestVersion} available — you have v{appVersion}</strong>
              <span>{updateInfo.releaseName || 'A new stable release is out.'} Get the installer from the GitHub release.</span>
              <div className="detail-actions">
                {updateInfo.installerUrl && <button className="settings-button" onClick={() => handleOpenUpdateLink('installer')}>Download installer</button>}
                {updateInfo.releaseUrl && <button className="settings-button ghost" onClick={() => handleOpenUpdateLink('release')}>View release</button>}
              </div>
            </div>
          )}
          {updateInfo?.status === 'up-to-date' && (
            <p className="muted">You are on the latest release.</p>
          )}
          <div className="updates-list">
            {UPDATES.map((entry) => {
              const isCurrent = entry.version === appVersion;
              return (
                <div key={`${entry.version}-${entry.date}`} className={`update-card ${isCurrent ? 'current' : ''}`}>
                  <div className="update-head">
                    <strong>v{entry.version}</strong>
                    {isCurrent && <span className="pill">Installed</span>}
                    <span className="muted update-meta">{entry.date}</span>
                  </div>
                  <div className="update-title">{entry.title}</div>
                  <ul className="update-changes">
                    {entry.changes.map((change, index) => (
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                </div>
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
                      : 'Experimental: RunContainer can try to show the app inside its own window. This changes how it looks, not what it can reach, and Windows often refuses.'}
                  </p>
                  <div className="detail-actions">
                    {selectedApp.windowHosting === false
                      ? <button className="settings-button ghost" onClick={() => handleSetWindowHosting(selectedApp, true)}>Try experimental hosting</button>
                      : <button className="settings-button ghost" onClick={() => handleSetWindowHosting(selectedApp, false)}>Open in its own window</button>}
                    {(selectedApp.hypervVm || selectedApp.activeEngine === 'hyperv') && (
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

      <div className="bottom-nav">
        {tabs.map((tab) => (
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