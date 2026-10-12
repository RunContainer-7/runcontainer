import React, { useEffect, useMemo, useState } from "react";
import { installContainer, importFromUrl, runContainer, killContainer, resetContainer, duplicateContainer, exportContainer, getAppLogs, onContainerStatus } from "../services/containerService";
import useContainers from "../hooks/useContainers";

function useBootAnimation() {
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setBooting(false), 900);
    return () => window.clearTimeout(timer);
  }, []);

  return booting;
}
const tabs = ["Sources", "Apps", "Settings", "Info"];
const tabIcons = {
  Sources: "◫",
  Apps: "▣",
  Settings: "⚙",
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
  const [activeSession, setActiveSession] = useState(null);
  const booting = useBootAnimation();

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
    duplicateContainer(container).then((duplicateApp) => {
      addContainer(duplicateApp);
      setInstallMessage(`Duplicated ${duplicateApp.name}`);
    });
  }

  function handleExport(container) {
    exportContainer(container).then((result) => {
      setInstallMessage(`Exported to ${result.path}`);
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
        if (!result || result.status !== 'Running' || !result.pid) {
          setActiveSession(null);
          const reason = result?.error || result?.reason || 'RunContainer did not confirm that an app process started.';
          setInstallMessage(`${container.name} was not launched: ${reason}`);
          updateContainerStatus(container.id, result?.status || 'Failed');
          await refreshContainers();
          return;
        }

        updateContainerStatus(container.id, result.status);
        setActiveSession({ ...container, ...result, status: 'Running', embedded: false });
        setInstallMessage(`${container.name} is running (PID ${result.pid}). ${result.reason || ''}`);
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

  function handleDelete(container) {
    if (!container) return;

    setInstallMessage(`Deleting ${container.name} and its sandbox...`);
    resetContainer(container)
      .then(async (result) => {
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
        setInstallMessage(`${container.name} and its sandbox were deleted.`);
      })
      .catch((error) => {
        setInstallMessage(`Could not delete ${container.name}: ${error?.message || 'Unknown deletion error.'}`);
      });
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
          <div className="eyebrow">Sandboxed app launcher</div>
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
            <p className="wizard-copy">RunContainer is preparing the app as a sandboxed container entry. The executable will be stored inside the container workspace and opened from there.</p>
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
              <h2>{activeSession.status === 'Launching' ? 'Starting isolated app' : activeSession.status === 'Running' ? 'Isolated app running' : 'Isolated app stopped'}</h2>
              <span className="muted">{activeSession.name} • {activeSession.launchMode === 'sandboxie' ? 'Sandboxie-Plus box (OS-level isolation)' : 'RunContainer per-app container'}</span>
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
                      ? `Running${activeSession.pid ? ` • PID ${activeSession.pid}` : ''}. The app opens in its own Windows window.`
                      : 'All processes for this app have exited.'}
                </div>
              </div>
              <div className="detail-actions">
                {activeSession.status === 'Running' && <button className="settings-button ghost" onClick={() => handleKill(activeSession)}>Stop app</button>}
                <button className="settings-button" onClick={() => setActiveSession(null)}>Back to app list</button>
                <button className="settings-button ghost" onClick={() => handleDelete(activeSession)}>Delete app and sandbox</button>
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === "Apps" && (
        <div className="apps-panel">
          <div className="panel-title-row">
            <div>
              <h2>My Apps</h2>
              <span className="muted">Sandboxed apps</span>
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
                        {container.metadata?.version ? `${container.metadata.version} • ` : ''}Status: {container.status}
                      </div>
                    </div>
                  </div>

                  <div className="container-actions">
                    <button className="settings-button" onClick={() => setSelectedApp(container)}>Manage</button>
                    <button className="settings-button" onClick={() => handleRun(container)}>Run</button>
                    <button className="settings-button ghost" onClick={() => handleKill(container)}>Close</button>
                    <button className="settings-button ghost" onClick={() => handleDelete(container)}>Delete</button>
                    <button className="settings-button ghost" onClick={() => handleDuplicate(container)}>Duplicate</button>
                    <button className="settings-button ghost" onClick={() => handleExport(container)}>Export</button>
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

      {activeTab === "Settings" && (
        <div className="placeholder-panel">
          <h3>Settings</h3>
          <p>How RunContainer isolates each app.</p>
          <div className="profile-list">
            <div className="profile-card active">
              <strong>Isolation engine</strong>
              <span>Apps run in a Sandboxie-Plus box (OS-level isolation) when Sandboxie-Plus is installed. Otherwise they run in RunContainer’s per-app container, which redirects the app’s AppData and Temp folders into its own folder. The container is not an OS security boundary.</span>
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
          <p>RunContainer is a sandboxed app launcher for Windows. It lets you install EXE-based apps into isolated container spaces, run them within a managed environment, and keep them separate from your normal desktop.</p>
          <div className="profile-list">
            <div className="profile-card active">
              <strong>How it works</strong>
              <span>Each app is copied into its own sandbox folder with isolated runtime, appdata, temp, and log paths.</span>
            </div>
            <div className="profile-card">
              <strong>Use cases</strong>
              <span>Use it for testing unfamiliar apps, isolating tools, preserving a clean desktop, or launching apps in a contained workspace.</span>
            </div>
            <div className="profile-card">
              <strong>Lifecycle</strong>
              <span>Run starts the app and confirms its process is running. Close or Stop ends the app’s processes. Delete ends them and removes the app and its folder.</span>
            </div>
            <div className="profile-card">
              <strong>Beta notice</strong>
              <span>RunContainer is still in beta, so bugs may appear. If you hit one, join the Discord server: https://discord.gg/rvMjMZJykE</span>
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
                <h4>Actions</h4>
                <div className="detail-actions">
                  <button className="settings-button" onClick={() => handleRun(selectedApp)}>Run</button>
                  <button className="settings-button ghost" onClick={() => handleKill(selectedApp)}>Close</button>
                  <button className="settings-button ghost" onClick={() => handleDelete(selectedApp)}>Delete</button>
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