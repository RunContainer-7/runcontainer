import React, { useEffect, useMemo, useState } from "react";
import { installContainer, importFromUrl, runContainer, killContainer, launchDesktopContainer, updatePermissions, resetContainer, duplicateContainer, exportContainer, getAppLogs } from "../services/containerService";
import useContainers from "../hooks/useContainers";

function useBootAnimation() {
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setBooting(false), 900);
    return () => window.clearTimeout(timer);
  }, []);

  return booting;
}
const tabs = ["Sources", "Apps", "Tweaks", "Settings", "Profiles", "Info"];
const tabIcons = {
  Sources: "◫",
  Apps: "▣",
  Tweaks: "⚙",
  Settings: "⚙",
  Profiles: "◧",
  Info: "◌",
};

export default function ContainerManager() {
  const { containers, setContainers, addContainer, removeContainer, updateContainerStatus, refreshContainers } = useContainers();
  const [activeTab, setActiveTab] = useState("Apps");
  const [showInstallMenu, setShowInstallMenu] = useState(false);
  const [selectedExe, setSelectedExe] = useState(null);
  const [installMessage, setInstallMessage] = useState("");
  const [selectedApp, setSelectedApp] = useState(null);
  const [permissions, setPermissions] = useState({ network: true, filesystem: false, registry: false });
  const [logs, setLogs] = useState([]);
  const [profile, setProfile] = useState("default");
  const [sourceUrl, setSourceUrl] = useState("");
  const [settings, setSettings] = useState({ autoIsolateAppData: true, persistentLogs: true });
  const [showInstallWizard, setShowInstallWizard] = useState(false);
  const [activeSession, setActiveSession] = useState(null);
  const [launchChoice, setLaunchChoice] = useState(null);
  const booting = useBootAnimation();

  const appContainers = useMemo(() => containers.filter((container) => container?.source), [containers]);

  useEffect(() => {
    if (!selectedApp) return;
    setPermissions({
      network: selectedApp.permissions?.network ?? true,
      filesystem: selectedApp.permissions?.filesystem ?? false,
      registry: selectedApp.permissions?.registry ?? false,
    });
  }, [selectedApp]);

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
        setInstallMessage("Unable to install that EXE.");
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
        setInstallMessage("Unable to import from that URL.");
      });
  }

  function handlePermissionsSave() {
    if (!selectedApp) return;

    updatePermissions(selectedApp, permissions).then((updatedApp) => {
      setSelectedApp(updatedApp);
      setInstallMessage(`Permissions updated for ${updatedApp.name}`);
    });
  }

  function handleReset(container) {
    const removedId = container?.id;
    if (removedId) {
      setContainers((prevContainers) => prevContainers.filter((entry) => !(
        entry.id === removedId ||
        (container?.source && entry.source === container.source) ||
        (container?.sandboxRoot && entry.sandboxRoot === container.sandboxRoot)
      )));
      removeContainer(removedId);
    }
    setActiveSession(null);
    setSelectedApp(null);
    setInstallMessage(`Reset ${container.name}`);
    resetContainer(container).then(() => {
      refreshContainers();
    }).catch(() => {
      refreshContainers();
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

  function applyProfile(option) {
    const profileMap = {
      default: { network: true, filesystem: false, registry: false },
      relaxed: { network: true, filesystem: true, registry: false },
      locked: { network: false, filesystem: false, registry: false },
    };

    const resolvedPermissions = profileMap[option] || { network: true, filesystem: false, registry: false };
    setProfile(option);
    setPermissions(resolvedPermissions);
    if (selectedApp) {
      updatePermissions(selectedApp, resolvedPermissions).then((updatedApp) => {
        setSelectedApp(updatedApp);
      });
    }
    setInstallMessage(`Profile set to ${option}`);
  }

  function handleRun(container) {
    setInstallMessage(`Launching ${container.name} inside its sandbox...`);
    setActiveSession({ ...container, embedded: false, embedReason: null, status: 'Launching' });

    runContainer(container)
      .then((updatedContainer) => {
        if (updatedContainer?.status) {
          updateContainerStatus(container.id, updatedContainer.status);
        }

        if (updatedContainer?.status === 'NeedsDesktopChoice' || updatedContainer?.needsDesktopChoice) {
          setActiveSession(null);
          setInstallMessage(`${container.name} will use the sandbox fallback prompt if the app does not appear immediately.`);
          return;
        }

        if (updatedContainer?.status === 'Cancelled' || updatedContainer?.status === 'Failed' || updatedContainer?.error) {
          setActiveSession(null);
          setLaunchChoice({ container, reason: updatedContainer.reason || updatedContainer.error || 'RunContainer could not start this app.' });
          setInstallMessage(updatedContainer.reason || updatedContainer.error || 'Launch was cancelled.');
          return;
        }

        setActiveSession((prev) => prev && prev.id === container.id
          ? { ...prev, status: updatedContainer?.status || 'Running', embedded: Boolean(updatedContainer?.embedded), embedReason: updatedContainer?.reason || null }
          : { ...container, status: updatedContainer?.status || 'Running', embedded: Boolean(updatedContainer?.embedded), embedReason: updatedContainer?.reason || null });

        setInstallMessage(updatedContainer?.reason || `Launched ${container.name} from the sandbox runtime.`);
      })
      .catch((error) => {
        setActiveSession(null);
        setLaunchChoice({ container, reason: error?.message || 'RunContainer could not start this app.' });
        setInstallMessage(`${container.name} could not be launched. RunContainer reported a runtime error.`);
      });
  }

  function handleLaunchChoice(choice) {
    if (!launchChoice?.container) {
      setLaunchChoice(null);
      return;
    }

    if (choice === 'desktop') {
      const container = launchChoice.container;
      setLaunchChoice(null);
      setActiveSession(null);
      setInstallMessage(`Opening ${container.name} on the desktop...`);
      launchDesktopContainer(container).then((result) => {
        if (result?.status) {
          updateContainerStatus(container.id, result.status);
        }
        setInstallMessage(result?.reason || `Opened ${container.name} on the desktop.`);
      });
      return;
    }

    setLaunchChoice(null);
    setInstallMessage('Launch cancelled.');
  }

  function handleKill(container) {
    killContainer(container).then((updatedContainer) => {
      if (updatedContainer?.status) {
        updateContainerStatus(container.id, updatedContainer.status);
      }
      setActiveSession(null);
      setInstallMessage(`${container.name} closed. Re-open it from the app launcher.`);
    });
  }

  function handleDelete(container) {
    if (!container) return;

    const removedId = container?.id;
    if (removedId) {
      setContainers((prevContainers) => prevContainers.filter((entry) => !(
        entry.id === removedId ||
        (container?.source && entry.source === container.source) ||
        (container?.sandboxRoot && entry.sandboxRoot === container.sandboxRoot)
      )));
      removeContainer(removedId);
    }
    setActiveSession(null);
    setSelectedApp(null);
    setInstallMessage(`Deleting ${container.name}...`);

    resetContainer(container)
      .then((result) => {
        refreshContainers();
        setInstallMessage(result?.status === 'Reset' ? `${container.name} deleted from RunContainer.` : `${container.name} removed from RunContainer.`);
      })
      .catch(() => {
        refreshContainers();
        setInstallMessage(`${container.name} removed from the launcher view.`);
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
            <button className="icon-button" aria-label="App permissions" onClick={() => { setActiveTab("Settings"); }}>▢</button>
          </div>
        )}
      </div>

      {launchChoice && (
        <div className="modal-backdrop" onClick={() => setLaunchChoice(null)}>
          <div className="detail-panel" onClick={(event) => event.stopPropagation()}>
            <div className="detail-header">
              <h3>Launch fallback</h3>
              <button className="icon-button" onClick={() => setLaunchChoice(null)}>×</button>
            </div>
            <p className="wizard-copy">RunContainer could not host {launchChoice.container?.name} inside its window surface.</p>
            <p className="wizard-copy">{launchChoice.reason}</p>
            <div className="wizard-steps">
              <div className="wizard-step">• The app was still launched from its sandboxed runtime path.</div>
              <div className="wizard-step">• Windows blocked the in-window attach attempt, so RunContainer offered a desktop fallback.</div>
              <div className="wizard-step">• If the app is refusing to open, check the sandbox logs for the exact startup reason.</div>
            </div>
            <div className="detail-actions">
              <button className="settings-button" onClick={() => handleLaunchChoice('desktop')}>Open on desktop</button>
              <button className="settings-button ghost" onClick={() => handleLaunchChoice('cancel')}>Cancel</button>
            </div>
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
              <h2>Container OS</h2>
              <span className="muted">{activeSession.embedded ? `${activeSession.name} is live-embedded into the RunContainer host surface` : (activeSession.status === 'Running' ? `${activeSession.name} is running from its sandboxed runtime` : (activeSession.embedReason ? `${activeSession.name} launched in the sandbox but could not be embedded` : `${activeSession.name} is launching inside the sandbox desktop`))}</span>
            </div>
            <div className="pill">Live sandbox session</div>
          </div>
          <div className="session-surface">
            <div className="session-surface-header">
              <div>
                <strong>{activeSession.name}</strong>
                <div className="muted">Runtime: isolated • AppData: redirected • Temp: sandboxed • Embed: {activeSession.embedded ? 'live' : 'pending'}{activeSession.embedReason ? ` • ${activeSession.embedReason}` : ''}</div>
              </div>
              <div className="detail-actions">
                <button className="settings-button" onClick={() => setActiveSession(null)}>Return to launcher</button>
                <button className="settings-button ghost" onClick={() => handleKill(activeSession)}>Close session</button>
                <button className="settings-button ghost" onClick={() => handleDelete(activeSession)}>Delete container</button>
              </div>
            </div>
            <div className="container-os-shell">
              <div className="container-os-topbar">
                <div className="container-os-badge">RunContainer OS</div>
                <div className="container-os-status-row">
                  <span className="status-chip">Isolated sandbox</span>
                  <span className="status-chip">Network policy: restricted</span>
                  <span className="status-chip">Logs: enabled</span>
                  <span className="status-chip">Status: {activeSession.status || 'Launching'}</span>
                </div>
              </div>
              <div className="container-os-desktop">
                <div className="desktop-tile active">
                  <div className="desktop-tile-icon">▣</div>
                  <div>
                    <strong>Hosted launch</strong>
                    <p>{activeSession.embedded ? 'This app is being hosted inside the RunContainer surface.' : 'The app launched from the sandbox runtime and will appear in its own window if Windows allows it.'}</p>
                  </div>
                </div>
                <div className="desktop-tile active">
                  <div className="desktop-tile-icon">▶</div>
                  <div>
                    <strong>{activeSession.name}</strong>
                    <p>Running inside the hosted container environment</p>
                  </div>
                </div>
                <div className="desktop-tile">
                  <div className="desktop-tile-icon">📁</div>
                  <div>
                    <strong>Sandbox folders</strong>
                    <p>Desktop • Downloads • AppData • Temp</p>
                  </div>
                </div>
                <div className="desktop-tile">
                  <div className="desktop-tile-icon">🧾</div>
                  <div>
                    <strong>Session logs</strong>
                    <p>Captured and retained per container</p>
                  </div>
                </div>
                <div className="container-os-window">
                  <div className="window-titlebar">
                    <span>Sandbox Console</span>
                    <span className="window-dot" />
                  </div>
                  <div className="window-body">
                    <p>Container runtime active.</p>
                    <p>Executable launched from sandbox root.</p>
                    <p>Host system remains protected.</p>
                  </div>
                </div>
              </div>
              <div className="container-os-taskbar">
                <div className="taskbar-start">▣</div>
                <div className="taskbar-app">{activeSession.name}</div>
                <div className="taskbar-spacer" />
                <div className="taskbar-status">Sandboxed • Live</div>
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

      {activeTab === "Profiles" && (
        <div className="placeholder-panel">
          <h3>Profiles</h3>
          <p>Profiles let you apply curated permission and isolation settings to each sandboxed app.</p>
          <div className="profile-list">
            {['default', 'relaxed', 'locked'].map((option) => (
              <button key={option} className={`profile-card ${profile === option ? 'active' : ''}`} onClick={() => applyProfile(option)}>
                <strong>{option}</strong>
                <span>{option === 'default' ? 'Balanced sandbox' : option === 'relaxed' ? 'More access' : 'Max isolation'}</span>
              </button>
            ))}
          </div>
          <div className="detail-actions">
            <button className="settings-button" onClick={() => setInstallMessage(`Profile set to ${profile}`)}>Apply profile</button>
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
          <p>Use tuning and compatibility tweaks for sandboxed apps without touching the host system.</p>
          <div className="profile-list">
            <button className="profile-card active"><strong>Compatibility mode</strong><span>Uses isolated temp and appdata paths.</span></button>
            <button className="profile-card"><strong>Network-safe mode</strong><span>Blocks external network traffic while the app runs.</span></button>
          </div>
        </div>
      )}

      {activeTab === "Settings" && (
        <div className="placeholder-panel">
          <h3>Settings</h3>
          <p>Control sandbox defaults, logs, permissions, and app isolation preferences.</p>
          <div className="profile-list">
            <button className={`profile-card ${settings.autoIsolateAppData ? "active" : ""}`} onClick={() => setSettings((prev) => ({ ...prev, autoIsolateAppData: !prev.autoIsolateAppData }))}>
              <strong>Auto-isolate APPDATA</strong>
              <span>{settings.autoIsolateAppData ? "Enabled for every installed app." : "Disabled for this session."}</span>
            </button>
            <button className={`profile-card ${settings.persistentLogs ? "active" : ""}`} onClick={() => setSettings((prev) => ({ ...prev, persistentLogs: !prev.persistentLogs }))}>
              <strong>Persistent logs</strong>
              <span>{settings.persistentLogs ? "Launch logs are stored per sandbox." : "Logs are kept temporarily only."}</span>
            </button>
          </div>
          <div className="detail-actions">
            <button className="settings-button" onClick={() => setInstallMessage("Settings updated")}>Save settings</button>
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
              <span>Run launches the app inside the container, Close hides the active sandbox session, and Delete removes the app from RunContainer.</span>
            </div>
            <div className="profile-card">
              <strong>Beta notice</strong>
              <span>RunContainer is still in beta, so bugs may appear. If you hit one, join the Discord server: https://discord.gg/rvMjMZJykE</span>
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
                <h4>Permissions</h4>
                <div className="permission-list">
                  <label><input type="checkbox" checked={permissions.network} onChange={() => setPermissions((prev) => ({ ...prev, network: !prev.network }))} /> Network</label>
                  <label><input type="checkbox" checked={permissions.filesystem} onChange={() => setPermissions((prev) => ({ ...prev, filesystem: !prev.filesystem }))} /> Filesystem</label>
                  <label><input type="checkbox" checked={permissions.registry} onChange={() => setPermissions((prev) => ({ ...prev, registry: !prev.registry }))} /> Registry</label>
                </div>
                <button className="settings-button" onClick={handlePermissionsSave}>Save permissions</button>
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