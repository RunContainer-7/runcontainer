import React, { useEffect, useMemo, useState } from "react";
import { installContainer, importFromUrl, runContainer, killContainer, resetContainer, duplicateContainer, exportContainer, getAppLogs, onContainerStatus, cancelDeleteContainer, setIsolationEngine, setWindowHosting, getAppVersion, getHyperVStatus, provisionGuestCredential, setAppConfig, setAppProfile, resetEnvironment, openGuestDisplay } from "../services/containerService";
import useContainers from "../hooks/useContainers";

function useBootAnimation() {
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setBooting(false), 900);
    return () => window.clearTimeout(timer);
  }, []);

  return booting;
}
// Used only until the main process reports the version from package.json.
const APP_VERSION_FALLBACK = "0.5.0";
const tabs = ["Sources", "Apps", "Tweaks", "Settings", "Profiles", "Info"];
const tabIcons = {
  Sources: "◫",
  Apps: "▣",
  Tweaks: "✧",
  Settings: "⚙",
  Profiles: "◧",
  Info: "◌",
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
  const [tweakAppId, setTweakAppId] = useState(null);
  const [tweakArgs, setTweakArgs] = useState("");
  const [tweakMemory, setTweakMemory] = useState("4096");
  const [tweakCpu, setTweakCpu] = useState("2");
  const [tweakNetwork, setTweakNetwork] = useState(true);
  const booting = useBootAnimation();

  useEffect(() => {
    // Promise.resolve keeps this safe when the bridge is unavailable (for example in tests
    // or when the app runs outside Electron) instead of throwing on an undefined result.
    Promise.resolve(getAppVersion())
      .then((version) => {
        if (version) setAppVersion(version);
      })
      .catch(() => {});
  }, []);

  function isolationLabel(app) {
    if (app.status !== 'Running') return null;
    if (app.isolated && (app.activeEngine === 'hyperv' || app.isolationLevel === 'vm')) {
      return `Isolated in VM${app.hypervVm ? ` ${app.hypervVm}` : ''}${app.guestPid ? ` (guest PID ${app.guestPid})` : ''}`;
    }
    if (app.isolated) return 'AppContainer mode (NOT a VM — lightweight token boundary only)';
    return 'Not isolated — launch was refused (legacy unguarded record)';
  }

  const appContainers = useMemo(() => containers.filter((container) => container?.source), [containers]);

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
        setInstallMessage(duplicateApp?.cloneWarning ? `Duplicated ${duplicateApp.name}, but ${duplicateApp.cloneWarning}` : `Duplicated ${duplicateApp.name} (VM disk cloned where present).`);
        refreshContainers();
      })
      .catch((error) => {
        setInstallMessage(`Could not duplicate ${container.name}: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleExport(container) {
    exportContainer(container)
      .then((result) => {
        setInstallMessage(`Exported app metadata (not the VM disk) to ${result.path}.`);
      })
      .catch((error) => {
        setInstallMessage(`Could not export ${container.name}: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleReset(container) {
    setInstallMessage(`Resetting ${container.name} (reboots its guest, keeps data)...`);
    resetEnvironment(container)
      .then((result) => {
        if (!result?.reset) {
          setInstallMessage(`Could not reset ${container.name}: ${result?.error || 'Reset was not confirmed.'}`);
          return;
        }
        updateContainerStatus(container.id, 'Stopped');
        setActiveSession((current) => current?.id === container.id ? { ...current, ...result, status: 'Stopped' } : current);
        setSelectedApp((current) => current?.id === container.id ? { ...current, status: 'Stopped' } : current);
        setInstallMessage(`${container.name} reset: guest rebooted fresh, data kept.`);
        refreshContainers();
      })
      .catch((error) => {
        setInstallMessage(`Could not reset ${container.name}: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleOpenDisplay(container) {
    setInstallMessage(`Opening the guest display for ${container.name}...`);
    openGuestDisplay(container)
      .then((result) => {
        if (result?.status !== 'Displaying') {
          setInstallMessage(`Could not open the guest display: ${result?.error || 'Unknown error.'}`);
          return;
        }
        setInstallMessage(`Guest display open for VM ${result.vm} (separate VM console window, not embedding).`);
      })
      .catch((error) => {
        setInstallMessage(`Could not open the guest display: ${error?.message || 'Unknown error.'}`);
      });
  }

  function handleProvisionCredential() {
    setInstallMessage('Opening the Windows credential dialog for the guest administrator...');
    provisionGuestCredential()
      .then((result) => {
        if (!result?.provisioned) {
          setInstallMessage(`Guest credential was not provisioned: ${result?.error || 'Unknown error.'}`);
          return;
        }
        setInstallMessage('Guest credential provisioned (encrypted for this user on this host).');
        refreshHypervStatus();
      })
      .catch((error) => {
        setInstallMessage(`Guest credential was not provisioned: ${error?.message || 'Unknown error.'}`);
      });
  }

  function refreshHypervStatus() {
    Promise.resolve(getHyperVStatus())
      .then((status) => { if (status) setHypervStatus(status); })
      .catch(() => {});
  }

  function handleSaveTweaks(container) {
    if (!container) return;
    setAppConfig({ id: container.id, launchArgs: tweakArgs, vmMemoryMB: Number(tweakMemory), vmCpuCount: Number(tweakCpu), networkEnabled: tweakNetwork })
      .then((result) => {
        if (result?.status === 'Failed') {
          setInstallMessage(`Could not save tweaks: ${result.error}`);
          return;
        }
        setInstallMessage(`Tweaks saved for ${container.name}. CPU/memory and network changes apply when its VM is Off (use Reset).`);
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
          ? `${container.name} uses the locked profile: offline VM, container without capabilities. Takes effect at Reset.`
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
        setInstallMessage(result?.guestPid ? `${container.name} is running inside its VM (guest PID ${result.guestPid}). ${result.reason || ''}` : `${container.name} is running (PID ${result.pid}). ${result.reason || ''}`);
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
    });
  }

  function handleSetIsolationEngine(container, engine, requiresVm) {
    setIsolationEngine({ id: container.id, isolationEngine: engine, requiresVm }).then((result) => {
      if (result?.status === 'Failed') {
        setInstallMessage(`Could not change the engine for ${container.name}: ${result.error}`);
        return;
      }
      setSelectedApp((current) => current?.id === container.id ? { ...current, isolationEngine: result.isolationEngine, preferVm: result.preferVm } : current);
      updateContainerStatus(container.id, container.status);
      refreshContainers();
      setInstallMessage(engine === 'hyperv' || engine === 'auto'
        ? `${container.name} will run inside its Hyper-V VM (required path; needs Pro/Enterprise/Education + virtualization + base image + guest credential).`
        : `${container.name} opted into AppContainer mode: lightweight token boundary, NOT a VM, compatible apps only.`);
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
            <button className="icon-button" aria-label="Import from URL" onClick={() => { setActiveTab("Sources"); }}>🔗</button>
            <button className="icon-button" aria-label="Container manager" onClick={() => { setActiveTab("Apps"); }}>📦</button>
            <button className="icon-button" aria-label="Settings" onClick={() => { setActiveTab("Settings"); }}>▢</button>
          </div>
        )}
      </div>


      {showInstallWizard && (
        <div className="modal-backdrop" onClick={() => setShowInstallWizard(false)}>
          <div className="detail-panel wizard-panel" onClick={(event) => event.stopPropagation()}>
            <div className="detail-header">
              <h3>Installing into RunContainer</h3>
              <button className="icon-button" onClick={() => setShowInstallWizard(false)}>×</button>
            </div>
            <p className="wizard-copy">RunContainer prepares a managed environment folder. The installer runs inside that environment (AppContainer for compatible apps, Hyper-V VM for arbitrary software) and the app always runs inside it — never directly on the host without a boundary. If isolation cannot be established, Run refuses to launch.</p>
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
              <h2>{activeSession.status === 'Launching' ? 'Starting app' : activeSession.status === 'Running' ? (activeSession.isolated ? 'App running isolated' : 'App running') : activeSession.status === 'Unknown' ? 'App state unknown' : 'App stopped'}</h2>
              <span className="muted">{activeSession.name} • {isolationLabel(activeSession) || 'RunContainer app profile'}</span>
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
                      ? `Running${activeSession.guestPid ? ` • guest PID ${activeSession.guestPid} in VM ${activeSession.hypervVm || ''}` : activeSession.pid ? ` • PID ${activeSession.pid}` : ''}. ${activeSession.windowHosted ? 'Shown inside RunContainer (visual only, experimental).' : (activeSession.hypervVm ? 'View it through the guest display button.' : 'The app opens in its own Windows window.')}`
                      : 'All processes for this app have exited.'}
                </div>
                {(activeSession.status === 'Running' || activeSession.status === 'Unknown') && (
                  <div className="muted">
                    {activeSession.status === 'Unknown'
                      ? `State unknown${activeSession.statusNote ? `: ${activeSession.statusNote}` : '. Run reconciles, Stop attempts a clean stop, Reset reboots the guest.'}`
                      : activeSession.isolated
                        ? `Isolation: ${activeSession.activeEngine === 'hyperv' || activeSession.isolationLevel === 'vm' ? `VM ${activeSession.hypervVm || ''} (guest PID ${activeSession.guestPid ?? '—'}, verified in-guest)` : 'AppContainer mode (NOT a VM)'}.`
                        : 'Isolation: none. Only APPDATA, LOCALAPPDATA and TEMP are redirected, so this app can still reach the rest of Windows.'}
                  </div>
                )}
              </div>
              <div className="detail-actions">
                {activeSession.status === 'Running' && <button className="settings-button ghost" onClick={() => handleKill(activeSession)}>Stop app</button>}
                {(activeSession.status === 'Running' || activeSession.status === 'Unknown') && <button className="settings-button ghost" onClick={() => handleReset(activeSession)}>Reset</button>}
                {(activeSession.hypervVm || activeSession.activeEngine === 'hyperv') && <button className="settings-button ghost" onClick={() => handleOpenDisplay(activeSession)}>Guest display</button>}
                <button className="settings-button" onClick={() => setActiveSession(null)}>Back to app list</button>
                {deletingId === activeSession.id
                  ? <button className="settings-button ghost" onClick={() => handleCancelDelete(activeSession)}>Cancel delete</button>
                  : <button className="settings-button ghost" onClick={() => handleDelete(activeSession)}>Delete app and sandbox</button>}
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === "Apps" && (
        <div className="apps-panel">
          <div className="panel-title-row">
            <div>
              <h2>My Apps</h2>
              <span className="muted">Managed apps</span>
            </div>
            <div className="pill">Live container mode</div>
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
                        {!container.envDirPresent ? ' • folder missing' : ''}{container.diskPresent === false ? ' • VM disk missing' : ''}
                        {isolationLabel(container) ? ` • ${isolationLabel(container)}` : ''}
                        {container.isolationEngine === 'appcontainer' ? ' • AppContainer (optional, not a VM)' : ' • Hyper-V VM (required)'}
                      </div>
                    </div>
                  </div>

                  <div className="container-actions">
                    <button className="settings-button" onClick={() => setSelectedApp(container)}>Manage</button>
                    <button className="settings-button" onClick={() => handleRun(container)}>Run</button>
                    <button className="settings-button ghost" onClick={() => handleKill(container)}>Close</button>
                    <button className="settings-button ghost" onClick={() => handleReset(container)}>Reset</button>
                    {deletingId === container.id
                      ? <button className="settings-button ghost" onClick={() => handleCancelDelete(container)}>Cancel delete</button>
                      : <button className="settings-button ghost" onClick={() => handleDelete(container)}>Delete</button>}
                    <button className="settings-button ghost" onClick={() => handleDuplicate(container)}>Duplicate</button>
                    <button className="settings-button ghost" onClick={() => handleExport(container)}>Export info</button>
                    <button className="settings-button ghost" onClick={() => handleViewLogs(container)}>Logs</button>
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
          <p>Per-app launch arguments and VM resources. Everything here is enforced by the backend; invalid values are rejected, never stored.</p>
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
                  setTweakNetwork(picked.networkEnabled !== false);
                }
              }}
            >
              <option value="">Select an app…</option>
              {appContainers.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>
              ))}
            </select>
            <label className="muted" htmlFor="tweak-args">Launch arguments (passed to the app inside its VM)</label>
            <input id="tweak-args" type="text" placeholder="e.g. --safe-mode" value={tweakArgs} onChange={(event) => setTweakArgs(event.target.value)} />
            <label className="muted" htmlFor="tweak-memory">VM memory (MB, 512–32768)</label>
            <input id="tweak-memory" type="number" min="512" max="32768" value={tweakMemory} onChange={(event) => setTweakMemory(event.target.value)} />
            <label className="muted" htmlFor="tweak-cpu">VM CPUs (1–16)</label>
            <input id="tweak-cpu" type="number" min="1" max="16" value={tweakCpu} onChange={(event) => setTweakCpu(event.target.value)} />
            <label className="muted"><input type="checkbox" checked={tweakNetwork} onChange={(event) => setTweakNetwork(event.target.checked)} /> Guest networking (off = offline VM)</label>
            <div className="detail-actions">
              <button className="settings-button" onClick={() => handleSaveTweaks(appContainers.find((entry) => entry.id === tweakAppId))} disabled={!tweakAppId}>Save tweaks</button>
            </div>
            <p className="muted">CPU, memory, and network changes apply when the VM is Off — use Reset afterwards.</p>
          </div>
        </div>
      )}

      {activeTab === "Profiles" && (
        <div className="placeholder-panel">
          <h3>Profiles</h3>
          <p>Isolation presets with real, enforced settings. Assign one per app below.</p>
          <div className="profile-list">
            <div className="profile-card"><strong>default</strong><span>Online VM (network adapter attached) • AppContainer gets internetClient.</span></div>
            <div className="profile-card"><strong>relaxed</strong><span>Online VM • wider container capabilities (internetClient + privateNetworkClientServer).</span></div>
            <div className="profile-card"><strong>locked</strong><span>Offline VM (adapters removed) • container without capabilities. Needs Reset to take effect on a running VM.</span></div>
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
                      <div className="container-status">Profile: {container.profile || 'default'}{container.networkEnabled === false ? ' • offline' : ''}</div>
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
          <p>How RunContainer isolates each app.</p>
          <div className="detail-actions">
            <button className="settings-button" onClick={refreshHypervStatus}>Check Hyper-V readiness</button>
            <button className="settings-button ghost" onClick={handleProvisionCredential}>Provision guest credential</button>
          </div>
          {hypervStatus && (
            <div className="profile-list">
              <div className={`profile-card ${hypervStatus.ready ? 'active' : ''}`}>
                <strong>Hyper-V readiness: {hypervStatus.ready ? 'ready' : 'not ready'}</strong>
                <span>
                  {hypervStatus.ready
                    ? `VMs can be provisioned. Base image: ${hypervStatus.baseImage || '(RUNCONTAINER_HYPERV_BASE_IMAGE not set)'}.`
                    : `Missing: ${(hypervStatus.missing || []).join(' ')}`}
                </span>
              </div>
            </div>
          )}
          <div className="profile-list">
            <div className="profile-card active">
              <strong>VM isolation (required, free, no Sandboxie)</strong>
              <span>Every app runs inside its own Hyper-V guest VM: installer executes in the guest, app launches in the guest, guest PID verified in-guest with zero host processes. Needs Windows 10/11 Pro/Enterprise/Education, firmware virtualization, Hyper-V enabled, a provisioned base VHDX (RUNCONTAINER_HYPERV_BASE_IMAGE), and a provisioned guest credential. Failures refuse the launch — never AppContainer, never host.</span>
            </div>
            <div className="profile-card">
              <strong>Optional AppContainer mode (NOT a VM)</strong>
              <span>A lighter token-boundary mode stays available only by explicit per-app opt-in, for compatible apps that do not need admin rights, drivers, or services. It is never selected when VM isolation is required and never used as a fallback. There is no unguarded mode at all.</span>
            </div>
            <div className="profile-card">
              <strong>Windows inside RunContainer</strong>
              <span>Run also tries to host the app’s window inside RunContainer’s own window, which is how an app appears to run “inside” RunContainer. This is presentation only: it adds no isolation, and Windows often refuses to re-parent a window at a lower integrity level, in which case the app opens in its own window. Turn it off per app in Manage.</span>
            </div>
            <div className="profile-card">
              <strong>App storage</strong>
              <span>Each app has its own folder under RunContainer’s data directory. Duplicate creates a separate copy with separate data, and Delete removes that app’s folder.</span>
            </div>
            <div className="profile-card">
              <strong>Logs</strong>
              <span>Launch, stop, and exit events are written to each app’s log, which you can open with the Logs button.</span>
            </div>
          </div>
        </div>
      )}

      {activeTab === "Info" && (
        <div className="placeholder-panel info-panel">
          <h3>What RunContainer is</h3>
          <p>RunContainer is a VM-style manager for Windows apps: each app gets its own managed environment, its installer runs inside that environment, and the app always runs inside it. Lightweight environments use a verified AppContainer; full environments use a Hyper-V VM.</p>
          <div className="profile-list">
            <div className="profile-card active">
              <strong>How it works</strong>
              <span>Each app is copied into its own environment folder. Its installer runs inside that environment and the app always runs inside it: AppContainer (verified token) for compatible apps, Hyper-V guest VM for arbitrary software. Window hosting only re-parents the app window for display (experimental, unverified) and is never the isolation.</span>
            </div>
            <div className="profile-card">
              <strong>What isolation you actually get</strong>
              <span>AppContainer: restricted container token (verified before reporting). Hyper-V: separate guest OS per environment. AppContainer cannot run admin installers, drivers, or services — that range needs a VM. Failed isolation refuses the launch; nothing ever runs silently unguarded.</span>
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
              <span>RunContainer is still in beta, so bugs may appear. If you hit one, join the Discord server: https://discord.gg/UKTGRMMmC4</span>
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
          <p className="muted info-version">RunContainer v{appVersion}</p>
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
                <h4>Sandbox</h4>
                <p>{selectedApp.sandboxRoot}</p>
              </div>
              <div>
                <h4>Logs</h4>
                <div className="log-viewer">
                  {logs.length === 0 ? <p>No logs available yet.</p> : logs.map((entry, index) => <p key={`${entry}-${index}`}>{entry}</p>)}
                </div>
              </div>
              <div>
                <h4>Isolation: VM required (fail-closed)</h4>
                <p className="muted">
                  {selectedApp.isolationEngine === 'appcontainer'
                    ? 'OPTIONAL AppContainer mode: verified token boundary only — NOT a virtual machine. Compatible apps only; admin installers, drivers, and services cannot run here.'
                    : 'Hyper-V VM (required path): installer and app run inside this environment\'s own guest VM. Needs Pro/Enterprise/Education + firmware virtualization + provisioned base image + guest credential.'}
                </p>
                <div className="detail-actions">
                  <button className="settings-button ghost" onClick={() => handleSetIsolationEngine(selectedApp, 'hyperv')}>Hyper-V VM (required)</button>
                  <button className="settings-button ghost" onClick={() => handleSetIsolationEngine(selectedApp, 'appcontainer')}>AppContainer (optional, not a VM)</button>
                </div>
                <p className="muted">Profile: {selectedApp.profile || 'default'}. Change it in the Profiles tab.</p>
              </div>
              <div>
                <h4>Display</h4>
                {(selectedApp.hypervVm || selectedApp.activeEngine === 'hyperv' || selectedApp.isolationEngine !== 'appcontainer') ? (
                  <div>
                    <p className="muted">VM apps are viewed through the supported guest console (VMConnect): a separate display window, not embedding. Guest windows cannot appear inside RunContainer&apos;s window.</p>
                    <div className="detail-actions">
                      <button className="settings-button ghost" onClick={() => handleOpenDisplay(selectedApp)}>Open guest display</button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="muted">
                      {selectedApp.windowHosting === false
                        ? 'The app opens in its own Windows window (experimental hosting is off).'
                        : 'Experimental: RunContainer tries to host the app window inside its own window. Presentation only, adds no isolation, often refused by Windows.'}
                    </p>
                    <div className="detail-actions">
                      {selectedApp.windowHosting === false
                        ? <button className="settings-button ghost" onClick={() => handleSetWindowHosting(selectedApp, true)}>Try experimental hosting</button>
                        : <button className="settings-button ghost" onClick={() => handleSetWindowHosting(selectedApp, false)}>Open in its own window</button>}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <h4>Actions</h4>
                <div className="detail-actions">
                  <button className="settings-button" onClick={() => handleRun(selectedApp)}>Run</button>
                  <button className="settings-button ghost" onClick={() => handleKill(selectedApp)}>Close</button>
                  <button className="settings-button ghost" onClick={() => handleReset(selectedApp)}>Reset (reboot guest, keep data)</button>
                  {(selectedApp.hypervVm || selectedApp.activeEngine === 'hyperv') && (
                    <button className="settings-button ghost" onClick={() => handleOpenDisplay(selectedApp)}>Open guest display</button>
                  )}
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