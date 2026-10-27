import React, { useCallback, useEffect, useState } from "react";
import VmConsole from "./VmConsole";
import {
  browseVmIso,
  createVm,
  deleteVm,
  detectQemu,
  getQemuStatus,
  listVms,
  onVmsChanged,
  startVm,
  stopVm,
} from "../services/containerService";

// Virtualise: RunContainer as a virtual machine host.
//
// This is the developer-mode feature. It runs a whole operating system from media the
// user owns on the same custom QEMU backend the VM isolation engine uses, and draws the
// guest inside this window instead of a window of QEMU's own. It is experimental and the
// interface says so where a machine is created, because it genuinely is: raw console
// frames over loopback, no guest additions and no integration beyond the keyboard and
// mouse.
//
// Nothing is downloaded and no licence is provided. QEMU is a dependency the user
// installs, and the disk images here are theirs.
const DEFAULT_FORM = {
  name: "",
  memoryMB: 4096,
  cpuCount: 2,
  diskGB: 40,
  isoPath: "",
  bootFromMedia: true,
};

export default function VirtualiseTab() {
  const [qemu, setQemu] = useState(null);
  const [vms, setVms] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [consoleVmId, setConsoleVmId] = useState(null);

  const refresh = useCallback(() => {
    Promise.resolve(getQemuStatus()).then((status) => { if (status) setQemu(status); }).catch(() => {});
    Promise.resolve(listVms())
      .then((result) => {
        const next = Array.isArray(result?.vms) ? result.vms : [];
        setVms(next);
        // A console only stays open for a VM that is still running.
        setConsoleVmId((current) => (next.some((vm) => vm.id === current && vm.status === "Running") ? current : null));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return onVmsChanged((next) => { if (Array.isArray(next)) setVms(next); });
  }, [refresh]);

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  const handleDetect = async () => {
    setBusy(true);
    setMessage("Looking for QEMU on this PC…");
    try {
      const status = await detectQemu();
      if (status) setQemu(status);
      setMessage(status?.qemuSystem ? `Found QEMU ${status.version || ""}.`.trim() : "QEMU was not found.");
    } catch (error) {
      setMessage(error?.message || "QEMU could not be detected.");
    } finally {
      setBusy(false);
    }
  };

  const handleBrowse = async () => {
    try {
      const result = await browseVmIso();
      if (result?.path) update({ isoPath: result.path });
    } catch (error) {
      setMessage(error?.message || "Media could not be chosen.");
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    setMessage("Creating the virtual disk…");
    try {
      const result = await createVm({
        name: form.name,
        memoryMB: Number(form.memoryMB),
        cpuCount: Number(form.cpuCount),
        diskGB: Number(form.diskGB),
        isoPath: form.isoPath || null,
        bootFromMedia: form.bootFromMedia,
      });
      if (!result?.created) {
        setMessage(result?.error || "The virtual machine could not be created.");
        return;
      }
      setForm(DEFAULT_FORM);
      setMessage(`${result.vm?.name || "The virtual machine"} was created. Press Start to boot it.`);
      refresh();
    } catch (error) {
      setMessage(error?.message || "The virtual machine could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async (vm) => {
    setBusy(true);
    setMessage(`Starting ${vm.name}…`);
    try {
      const result = await startVm(vm);
      if (!result?.started) {
        setMessage(result?.error || "The virtual machine could not start.");
        return;
      }
      setMessage(result.note || "The virtual machine is running.");
      setConsoleVmId(vm.id);
      refresh();
    } catch (error) {
      setMessage(error?.message || "The virtual machine could not start.");
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async (vm) => {
    if (!window.confirm(`Stop ${vm.name} now? This is an immediate power-off, like pulling the plug. Shut the guest down from inside for a clean exit.`)) return;
    setBusy(true);
    try {
      const result = await stopVm(vm);
      if (!result?.stopped) setMessage(result?.error || "The virtual machine did not stop.");
      else setMessage(`${vm.name} stopped.`);
      refresh();
    } catch (error) {
      setMessage(error?.message || "The virtual machine did not stop.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (vm) => {
    if (!window.confirm(`Delete ${vm.name} and its virtual disk? The operating system installed inside it is removed permanently.`)) return;
    setBusy(true);
    try {
      const result = await deleteVm(vm);
      if (!result?.deleted) setMessage(result?.error || "The virtual machine could not be deleted.");
      else setMessage(result?.note || `${vm.name} was deleted.`);
      refresh();
    } catch (error) {
      setMessage(error?.message || "The virtual machine could not be deleted.");
    } finally {
      setBusy(false);
    }
  };

  const consoleVm = vms.find((vm) => vm.id === consoleVmId && vm.status === "Running") || null;
  const memoryChoices = [1024, 2048, 4096, 8192, 16384, 32768];

  return (
    <div className="panel-body">
      <div className="ai-panel">
        <div className="panel-title-row">
          <div>
            <h3>Virtualise</h3>
            <span className="muted">Run a whole operating system inside RunContainer</span>
          </div>
          <div className="pill">Experimental</div>
        </div>
        <p>
          This runs a real virtual machine on RunContainer&rsquo;s own QEMU backend, the same one the VM isolation
          engine uses, and draws the guest inside this window. Expect bugs: the console sends raw frames over
          loopback and there are no guest additions, so integration stops at the keyboard and mouse.
        </p>
        <p className="muted">
          You supply the operating system. RunContainer ships no guest OS and no licence, downloads none, and
          asks for media or a disk image you already own. QEMU is a separate program you install yourself.
        </p>

        <div className="profile-card">
          <strong>QEMU backend</strong>
          {qemu?.qemuSystem ? (
            <span>
              Detected{QEMU_LABEL(qemu.version)} · acceleration: {qemu.accel || "unknown"}.
              {qemu.accel === "tcg" ? " Without hardware acceleration a graphical guest will feel slow." : ""}
            </span>
          ) : (
            <span>QEMU is not detected yet, so no virtual machine can run.</span>
          )}
          {Array.isArray(qemu?.missing) && qemu.missing.length > 0 && (
            <span className="muted">{qemu.missing.join(" ")}</span>
          )}
          <div className="detail-actions">
            <button type="button" className="settings-button ghost" disabled={busy} onClick={handleDetect}>Detect QEMU</button>
            <button type="button" className="settings-button ghost" onClick={refresh}>Refresh</button>
          </div>
        </div>
      </div>

      <div className="ai-panel">
        <h3>New virtual machine</h3>
        <div className="vm-form">
          <label>
            Name
            <input
              type="text"
              value={form.name}
              placeholder="Windows 11 test"
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <label>
            Memory
            <select value={form.memoryMB} onChange={(event) => update({ memoryMB: Number(event.target.value) })}>
              {memoryChoices.map((size) => (
                <option key={size} value={size}>{size >= 1024 ? `${size / 1024} GB` : `${size} MB`}</option>
              ))}
            </select>
          </label>
          <label>
            CPUs
            <select value={form.cpuCount} onChange={(event) => update({ cpuCount: Number(event.target.value) })}>
              {[1, 2, 4, 6, 8, 12, 16].map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
          <label>
            Disk
            <select value={form.diskGB} onChange={(event) => update({ diskGB: Number(event.target.value) })}>
              {[8, 20, 40, 60, 80, 120, 256, 512].map((size) => <option key={size} value={size}>{size} GB</option>)}
            </select>
          </label>
          <label className="vm-form-wide">
            Installation media (an ISO or disk image you own)
            <div className="vm-form-row">
              <input type="text" value={form.isoPath} placeholder="Nothing attached" onChange={(event) => update({ isoPath: event.target.value })} />
              <button type="button" className="settings-button ghost" onClick={handleBrowse}>Browse…</button>
            </div>
          </label>
          <label className="vm-form-check">
            <input
              type="checkbox"
              checked={form.bootFromMedia}
              onChange={(event) => update({ bootFromMedia: event.target.checked })}
            />
            Boot the attached media first (for a fresh install). Uncheck once the system is installed.
          </label>
          <div className="detail-actions">
            <button type="button" className="settings-button" disabled={busy || !form.name.trim()} onClick={handleCreate}>
              Create virtual machine
            </button>
          </div>
        </div>
        {message && <p className="status-line" role="status">{message}</p>}
      </div>

      <div className="ai-panel">
        <h3>Virtual machines</h3>
        {vms.length === 0 ? (
          <p className="muted">No virtual machines yet. Create one above and press Start to boot it.</p>
        ) : (
          <div className="profile-list">
            {vms.map((vm) => (
              <div className={`profile-card ${vm.status === "Running" ? "active" : ""}`} key={vm.id}>
                <strong>{vm.name} · {vm.status}</strong>
                <span>
                  {vm.memoryMB >= 1024 ? `${vm.memoryMB / 1024} GB` : `${vm.memoryMB} MB`} memory · {vm.cpuCount} CPU
                  {vm.cpuCount === 1 ? "" : "s"} · {vm.diskGB} GB disk
                  {vm.isoName ? ` · media: ${vm.isoName}` : " · no media attached"}
                </span>
                <span className="muted">
                  {vm.diskName ? `Disk: ${vm.diskName}` : "No disk image"}
                  {vm.accel ? ` · acceleration: ${vm.accel}` : ""}
                  {vm.consolePort ? ` · console on 127.0.0.1:${vm.consolePort}` : ""}
                </span>
                <div className="detail-actions">
                  {vm.status === "Running" ? (
                    <>
                      <button type="button" className="settings-button" disabled={busy} onClick={() => setConsoleVmId(vm.id)}>Show console</button>
                      <button type="button" className="settings-button ghost" disabled={busy} onClick={() => handleStop(vm)}>Stop</button>
                    </>
                  ) : (
                    <button type="button" className="settings-button" disabled={busy} onClick={() => handleStart(vm)}>Start</button>
                  )}
                  <button type="button" className="settings-button ghost" disabled={busy} onClick={() => handleDelete(vm)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {consoleVm && (
        <div className="ai-panel">
          <div className="panel-title-row">
            <div>
              <h3>{consoleVm.name}</h3>
              <span className="muted">Guest console, drawn inside RunContainer</span>
            </div>
            <div className="detail-actions">
              <button type="button" className="settings-button ghost" onClick={() => setConsoleVmId(null)}>Hide console</button>
            </div>
          </div>
          <VmConsole vm={consoleVm} />
        </div>
      )}
    </div>
  );
}

function QEMU_LABEL(version) {
  return version ? ` (QEMU ${version})` : "";
}
