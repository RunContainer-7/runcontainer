import React, { useEffect, useMemo, useState } from "react";
import { installContainer, importFromUrl, runContainer, killContainer, resetContainer, duplicateContainer, exportContainer, getAppLogs, onContainerStatus, cancelDeleteContainer, setIsolationEngine, setWindowHosting, getAppVersion, getHyperVStatus, provisionGuestCredential, setAppConfig, setAppProfile, resetEnvironment, openGuestDisplay, checkAppUpdates, openUpdateLink, snoozeUpdate, downloadUpdate, cancelUpdateDownload, getUpdateState, installDownloadedUpdate, onUpdateDownloadProgress, getQemuStatus, detectQemu, browseQemuBase, setQemuBase, createQemuProvisionDisk, bootQemuProvision, setGuestExePath, openExternalUrl } from "../services/containerService";
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
const APP_VERSION_FALLBACK = "0.6.2";
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
  const [qemuIso, setQemuIso] = useState('');
  const [guestExePath, setGuestExePath] = useState('');
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
  }, []);

  useEffect(() => {
    setGuestExePath(selectedApp?.installedExeGuestPath || '');
  }, [selectedApp?.id]);

  function isolationLabel(app) {
    if (app.status !== 'Running') return null;
    if (app.isolated && (app.activeEngine === 'hyperv' || app.isolationLevel === 'vm')) {
      if (app.activeEngine === 'qemu') {
        return `Isolated in genuine VM (guest PID ${app.guestPid ?? '—'})`;
      }
      return `Isolated in VM${app.hypervVm ? ` ${app.hypervVm}` : ''}${app.guestPid ? ` (guest PID ${app.guestPid})` : ''}`;
    }
    if (app.isolated && (app.activeEngine === 'rcvm' || app.isolationLevel === 'container')) {
      return `Contained (RCVM${app.pid ? ` PID ${app.pid}` : ''})`;
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
        setInstallMessage(`Tweaks saved for ${container.name}. Caps apply at the next Run (RCVM containment) or after Reset (Hyper-V VM).`);
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
    setInstallMessage('Detecting QEMU and acceleration…');
    Promise.resolve(detectQemu())
      .then((status) => {
        if (status) setQemuStatus(status);
        setInstallMessage(status?.qemuSystem
          ? `QEMU ${status.version || ''} at ${status.qemuSystem} (${status.accel || 'unknown accel'}).${status.baseImage ? '' : ' Now provision a base image below.'}`
          : `QEMU not found: ${(status?.missing || []).join(' ')}`);
      })
      .catch((error) => setInstallMessage(error?.message || 'QEMU detection failed.'));
  }

  function handleBrowseBase() {
    Promise.resolve(browseQemuBase())
      .then((picked) => {
        if (!picked?.path) return;
        return setQemuBase(picked.path).then((result) => {
          if (result?.saved) {
            setQemuStatus(result);
            setInstallMessage(`Base image set: ${picked.path}`);
          } else {
            setInstallMessage(result?.error || 'Base image was not set.');
          }
        });
      })
      .catch((error) => setInstallMessage(error?.message || 'Base image was not set.'));
  }

  function handleProvisionCreate() {
    setInstallMessage('Creating staging disk…');
    Promise.resolve(createQemuProvisionDisk({ sizeGB: 60 }))
      .then((result) => setInstallMessage(result?.created
        ? `Staging disk created at ${result.diskPath}. Boot it with your Windows ISO next.`
        : (result?.error || 'Staging disk was not created.')))
      .catch((error) => setInstallMessage(error?.message || 'Staging disk was not created.'));
  }

  function handleProvisionBoot() {
    if (!qemuIso) {
      setInstallMessage('Enter your Windows ISO path first (media and licence you own).');
      return;
    }
    setInstallMessage('Booting provisioning VM…');
    Promise.resolve(bootQemuProvision({ isoPath: qemuIso }))
      .then((result) => setInstallMessage(result?.booted
        ? result.note
        : (result?.error || 'Provisioning VM did not boot.')))
      .catch((error) => setInstallMessage(error?.message || 'Provisioning VM did not boot.'));
  }

  function handleSetGuestExe(container) {
    if (!container) return;
    Promise.resolve(setGuestExePath({ id: container.id, installedExeGuestPath: guestExePath }))
      .then((result) => {
        if (result?.status === 'Failed') {
          setInstallMessage(`Could not set guest path: ${result.error}`);
          return;
        }
        setSelectedApp((current) => current?.id === container.id ? { ...current, installedExeGuestPath: result.installedExeGuestPath } : current);
        setInstallMessage(`Guest exe path saved for ${container.name}.`);
        refreshContainers();
      })
      .catch((error) => setInstallMessage(error?.message || 'Guest path was not saved.'));
  }

  function handleOpenSetupGuide() {
    setActiveTab("Settings");
    refreshHypervStatus();
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

  function handleSetIsolationEngine(container, engine, requiresVm) {
    setIsolationEngine({ id: container.id, isolationEngine: engine, requiresVm }).then((result) => {
      if (result?.status === 'Failed') {
        setInstallMessage(`Could not change the engine for ${container.name}: ${result.error}`);
        return;
      }
      setSelectedApp((current) => current?.id === container.id ? { ...current, isolationEngine: result.isolationEngine, preferVm: result.preferVm } : current);
      updateContainerStatus(container.id, container.status);
      refreshContainers();
      setInstallMessage(engine === 'qemu'
        ? `${container.name} will run inside its genuine QEMU VM (needs detected QEMU + provisioned base image; see Settings).`
        : engine === 'hyperv'
        ? `${container.name} will run inside its Hyper-V VM (full guest OS; needs Pro/Enterprise/Education + virtualization + base image + guest credential).`
        : engine === 'appcontainer'
          ? `${container.name} opted into AppContainer mode: lightweight token boundary, NOT a VM, compatible apps only.`
          : `${container.name} will run under RCVM containment (Job Object caps, verified post-launch) until a QEMU base image is provisioned — then it uses the genuine VM. Containment is process-level, NOT a VM.`);
    }).catch((error) => {
      setInstallMessage(`Could not change the engine for ${container.name}: ${error?.message || 'Unknown error.'}`);
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
            <p className="wizard-copy">RunContainer prepares a managed environment folder. The app always runs contained inside it — RCVM containment on all editions, Hyper-V VM for arbitrary software, AppContainer for compatible apps — never directly on the host without a boundary. If containment cannot be established, Run refuses to launch.</p>
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
          {installMessage && /Hyper-V|hypervisor|virtualization|Administrator|base image|guest credential|not launched|was not launched/i.test(installMessage) && (
            <div className="detail-actions">
              <button className="settings-button" onClick={handleOpenSetupGuide}>Open setup guide</button>
            </div>
          )}

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
                        {container.isolationEngine === 'appcontainer' ? ' • AppContainer (optional, not a VM)' : container.isolationEngine === 'hyperv' ? ' • Hyper-V VM (full)' : container.isolationEngine === 'rcvm' ? ' • RCVM containment (not a VM)' : ' • Genuine VM when provisioned, RCVM containment otherwise'}
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
          <p>Per-app launch arguments and resource caps. Everything here is enforced by the backend; invalid values are rejected, never stored.</p>
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
            <label className="muted" htmlFor="tweak-memory">Memory cap (MB, 256–32768)</label>
            <input id="tweak-memory" type="number" min="512" max="32768" value={tweakMemory} onChange={(event) => setTweakMemory(event.target.value)} />
            <label className="muted" htmlFor="tweak-cpu">CPU share (1–16)</label>
            <input id="tweak-cpu" type="number" min="1" max="16" value={tweakCpu} onChange={(event) => setTweakCpu(event.target.value)} />
            <label className="muted"><input type="checkbox" checked={tweakNetwork} onChange={(event) => setTweakNetwork(event.target.checked)} /> Guest networking (off = offline VM)</label>
            <div className="detail-actions">
              <button className="settings-button" onClick={() => handleSaveTweaks(appContainers.find((entry) => entry.id === tweakAppId))} disabled={!tweakAppId}>Save tweaks</button>
            </div>
            <p className="muted">Memory and CPU caps apply at the next Run (RCVM) or after Reset (Hyper-V VM). Network changes apply to Hyper-V VMs after Reset; RCVM cannot cut network access.</p>
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
              <strong>QEMU genuine VM (default backend)</strong>
              <span>{qemuStatus ? (qemuStatus.available ? `Ready: QEMU ${qemuStatus.version || ''} (${qemuStatus.accel || 'unknown accel'}), base image set.` : `Not ready: ${(qemuStatus.missing || []).join(' ')}`) : 'Detecting QEMU…'}</span>
              <div className="detail-actions">
                <button className="settings-button" onClick={handleDetectQemu}>Detect QEMU</button>
                <button className="settings-button ghost" onClick={handleBrowseBase}>Select base image</button>
                <button className="settings-button ghost" onClick={handleProvisionCreate}>Create staging disk</button>
              </div>
              <div className="source-form">
                <label className="muted" htmlFor="qemu-iso">Windows ISO you own (first-time provisioning only)</label>
                <input id="qemu-iso" type="text" placeholder="C:\\ISOs\\windows.iso" value={qemuIso} onChange={(event) => setQemuIso(event.target.value)} />
                <div className="detail-actions">
                  <button className="settings-button ghost" onClick={handleProvisionBoot}>Boot provisioning VM</button>
                </div>
              </div>
              <span className="muted">QEMU is detected, never bundled (GPLv2). Windows media and licence are yours; nothing is downloaded. WHPX acceleration when available, TCG fallback otherwise. Install Windows + virtio drivers + qemu-guest-agent in the provisioning VM, shut it down, then select its disk as the base image.</span>
            </div>
            <div className="profile-card">
              <strong>RCVM containment (default until a VM is provisioned, not a VM)</strong>
              <span>Job Object caps (lifetime, memory, CPU, process count) with per-app profile folders, verified on this machine after every launch. No admin rights, works on Home and Pro — this is what Run uses until you provision a QEMU base image. Process containment, explicitly not a virtual machine, and it does not cut network access.</span>
            </div>
            <div className="profile-card">
              <strong>VM isolation as a full Hyper-V VM (optional, no Sandboxie)</strong>
              <span>For arbitrary software, switch an app to its own Hyper-V guest VM: installer executes in the guest, app launches in the guest, guest PID verified in-guest with zero host processes. Needs Windows 10/11 Pro/Enterprise/Education, firmware virtualization, Hyper-V enabled, a provisioned base VHDX (RUNCONTAINER_HYPERV_BASE_IMAGE), and a provisioned guest credential. Failures refuse the launch — never AppContainer, never host.</span>
            </div>
            <div className="profile-card active">
              <strong>Setup guide: make this PC VM-ready</strong>
              <span>1. Use Windows 10/11 Pro, Enterprise, or Education (Home has no Hyper-V). 2. Enable virtualization in firmware (Intel VT-x / AMD-V). 3. Run as Administrator: DISM /Online /Enable-Feature /All /FeatureName:Microsoft-Hyper-V — then reboot. 4. Start the Hyper-V Virtual Machine Management service (vmms). 5. Build a sysprepped Generation-2 Windows base VHDX and set RUNCONTAINER_HYPERV_BASE_IMAGE to its path. 6. Press “Provision guest credential” above (one time, DPAPI-encrypted). 7. Press “Check Hyper-V readiness” — Run is refused until every check passes, so nothing ever runs unisolated.</span>
            </div>
            <div className="profile-card">
              <strong>Why RCVM instead of a bundled hypervisor</strong>
              <span>Shipping a separate hypervisor would not remove the requirements — any real VM engine still needs hardware virtualization, an admin-installed driver, and a licensed Windows guest image, and emulation without virtualization is orders of magnitude too slow for real apps. So RCVM contains apps with built-in Windows primitives that work everywhere, and the full Hyper-V VM stays for software that needs a guest OS.</span>
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
          <p>RunContainer is a container-style manager for Windows apps: each app gets its own managed environment and always runs contained inside it. RCVM containment works on every edition; full Hyper-V VMs cover arbitrary software on Pro and up.</p>
          <div className="profile-list">
            <div className="profile-card active">
              <strong>How it works</strong>
<span>Each app is copied into its own environment folder and always runs contained inside it: RCVM (Job Object caps + per-app profile) by default, Hyper-V guest VM for arbitrary software, AppContainer (verified token) for compatible apps. Window hosting only re-parents the app window for display (experimental, unverified) and is never the isolation.</span>
            </div>
            <div className="profile-card">
              <strong>What isolation you actually get</strong>
<span>RCVM: lifetime/resource caps with a per-app profile (all editions; not a hardware VM, no network cut-off). AppContainer: restricted container token (verified before reporting). Hyper-V: separate guest OS per environment. Failed containment refuses the launch; nothing ever runs silently unguarded.</span>
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
                <h4>Isolation (fail-closed)</h4>
                <p className="muted">
                  {selectedApp.isolationEngine === 'appcontainer'
                    ? 'OPTIONAL AppContainer mode: verified token boundary only — NOT a virtual machine. Compatible apps only; admin installers, drivers, and services cannot run here.'
                    : selectedApp.isolationEngine === 'hyperv'
                      ? 'Hyper-V VM (full guest OS): installer and app run inside this environment\'s own guest VM. Needs Pro/Enterprise/Education + firmware virtualization + provisioned base image + guest credential.'
                      : selectedApp.isolationEngine === 'rcvm'
                        ? 'RCVM containment: Job Object caps with a per-app profile, verified post-launch on this machine. Process containment — explicitly NOT a virtual machine, no network cut-off.'
                        : 'QEMU genuine VM (default): per-environment virtual machine with overlay disk and guest agent. Needs detected QEMU + provisioned base image (see Settings).'}
                </p>
                <div className="detail-actions">
                  <button className="settings-button ghost" onClick={() => handleSetIsolationEngine(selectedApp, 'qemu')}>QEMU VM (genuine)</button>
                  <button className="settings-button ghost" onClick={() => handleSetIsolationEngine(selectedApp, 'rcvm')}>RCVM containment (not a VM)</button>
                  <button className="settings-button ghost" onClick={() => handleSetIsolationEngine(selectedApp, 'hyperv')}>Hyper-V VM (full)</button>
                  <button className="settings-button ghost" onClick={() => handleSetIsolationEngine(selectedApp, 'appcontainer')}>AppContainer (optional, not a VM)</button>
                </div>
                <div className="source-form">
                  <label className="muted" htmlFor="guest-exe">Guest exe path (QEMU VMs: where the app installed inside the guest)</label>
                  <input id="guest-exe" type="text" placeholder="C:\\Program Files\\App\\app.exe" value={guestExePath} onChange={(event) => setGuestExePath(event.target.value)} />
                  <div className="detail-actions">
                    <button className="settings-button ghost" onClick={() => handleSetGuestExe(selectedApp)}>Save guest path</button>
                  </div>
                </div>
                <p className="muted">Profile: {selectedApp.profile || 'default'}. Change it in the Profiles tab.</p>
              </div>
              <div>
                <h4>Display</h4>
                {(selectedApp.hypervVm || selectedApp.activeEngine === 'hyperv') ? (
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
                  <button className="settings-button ghost" onClick={() => handleReset(selectedApp)}>Reset (fresh state, keep data)</button>
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