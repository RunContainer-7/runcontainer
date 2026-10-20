// QEMU-first engine selection. Pure function so it can be unit tested.
//
// Default path: 'qemu' — a GENUINE virtual machine per environment, managed by
// RunContainer with QEMU as its engine (per-env overlay disk, QMP management,
// guest-agent channel, no virtual network). Gated on qemuReady (detected QEMU
// binary + provisioned base image); otherwise 'qemu-unavailable' with an
// actionable error — never a silent fallback relabeled as a VM.
// Legacy 'rcvm' stays as an explicitly chosen process-containment mode and is
// labeled as NOT a VM. 'hyperv' is the full Hyper-V VM opt-in, 'appcontainer'
// the token-mode opt-in. There is no 'profile' or 'sandboxie' path:
// unisolated execution is never selected, even on request.
function selectIsolationEngine({ platform = process.platform, appRecord = {}, hypervReady = false, qemuReady = false, qemuMissing = [] } = {}) {
  if (platform !== 'win32') {
    return { engine: 'unavailable', reason: 'Isolation requires Windows 10/11.' };
  }
  if (appRecord.isolationEngine === 'profile') {
    return {
      engine: 'refused',
      reason: 'This app is marked "unguarded profile mode", which is not a security boundary. RunContainer refuses to launch it unisolated. Choose the QEMU VM, Hyper-V VM, RCVM containment, or explicitly choose the AppContainer mode for compatible apps. Nothing was launched.',
    };
  }
  if (appRecord.isolationEngine === 'sandboxie' || appRecord.launchMode === 'sandboxie') {
    return {
      engine: 'refused',
      reason: 'Sandboxie is not an allowed isolation backend for RunContainer. Choose the QEMU VM, Hyper-V VM, RCVM containment, or explicitly choose the AppContainer mode for compatible apps. Nothing was launched.',
    };
  }
  // Explicit opt-in to the legacy lightweight, non-VM process mode.
  if (appRecord.isolationEngine === 'rcvm' && !appRecord.requiresVm && !appRecord.preferVm && !appRecord.requiresQemu) {
    return { engine: 'rcvm', reason: 'Legacy process containment: Job Object lifetime/resource caps with per-app profile folders. This is NOT a virtual machine and does not cut network access.' };
  }
  // Explicit opt-in to the lightweight, non-VM token mode. Labeled accurately below.
  if (appRecord.isolationEngine === 'appcontainer' && !appRecord.requiresVm && !appRecord.preferVm && !appRecord.requiresQemu) {
    return { engine: 'appcontainer', reason: 'Optional lightweight mode: Windows AppContainer with verified container token. This is NOT a virtual machine and cannot run administrator installers, drivers, or services.' };
  }
  // Explicit full Hyper-V choice. Fails closed when Hyper-V is not ready.
  if (appRecord.isolationEngine === 'hyperv' || appRecord.requiresVm || appRecord.preferVm) {
    if (!hypervReady) {
      return {
        engine: 'hyperv-unavailable',
        reason: 'Hyper-V VM isolation was requested, but Hyper-V is not ready. Enable Hyper-V on Windows 10/11 Pro/Enterprise/Education with virtualization enabled in firmware, provision a base image and guest credential. RunContainer did not launch anything, and did not fall back to any other mode.',
      };
    }
    return { engine: 'hyperv', reason: 'Full VM isolation via Hyper-V (guest OS boundary).' };
  }
  // Default and 'auto'/'qemu': the genuine RCVM virtual machine. Fails closed
  // when QEMU is not provisioned — never falls back to another mode silently.
  if (!qemuReady) {
    const detail = (qemuMissing || []).filter(Boolean).join(' ');
    return {
      engine: 'qemu-unavailable',
      reason: `The genuine RCVM virtual machine is not provisioned yet. ${detail || 'Install QEMU and provision a base image from Windows media you own.'} Open Settings → QEMU VM setup. RunContainer did not launch anything, and did not fall back to any other mode.`,
    };
  }
  return { engine: 'qemu', reason: 'Genuine VM isolation: per-environment QEMU virtual machine (overlay disk, guest agent, no virtual network).' };
}

module.exports = { selectIsolationEngine };
