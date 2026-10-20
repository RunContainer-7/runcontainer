// Engine selection: best available backend, honestly labeled. Pure function so
// it can be unit tested.
//
// Default path: 'qemu' — a GENUINE virtual machine per environment, when QEMU
// is detected AND a base image is provisioned. Otherwise the default is 'rcvm'
// — RunContainer's own process containment (Job Object lifetime/resource caps
// with per-app profile folders, verified post-launch). RCVM works on every
// Windows 10/11 edition with no setup, so Run works out of the box; it is
// labeled as NOT a VM everywhere it appears.
//
// Fail-closed rules (never a silent fallback relabeled as something stronger):
// - Explicit 'qemu' choice without provisioning -> 'qemu-unavailable' with
//   setup guidance. The app is NOT run contained and reported as a VM.
// - Explicit 'hyperv' without Hyper-V ready -> 'hyperv-unavailable'.
// - 'profile'/'sandboxie' -> 'refused'. 'appcontainer' stays an explicit
//   opt-in, labeled NOT a VM.
function selectIsolationEngine({ platform = process.platform, appRecord = {}, hypervReady = false, qemuReady = false, qemuMissing = [] } = {}) {
  if (platform !== 'win32') {
    return { engine: 'unavailable', reason: 'Isolation requires Windows 10/11.' };
  }
  if (appRecord.isolationEngine === 'profile') {
    return {
      engine: 'refused',
      reason: 'This app is marked "unguarded profile mode", which is not a security boundary. RunContainer refuses to launch it unisolated. Choose the QEMU VM, RCVM containment, Hyper-V VM, or explicitly choose the AppContainer mode for compatible apps. Nothing was launched.',
    };
  }
  if (appRecord.isolationEngine === 'sandboxie' || appRecord.launchMode === 'sandboxie') {
    return {
      engine: 'refused',
      reason: 'Sandboxie is not an allowed isolation backend for RunContainer. Choose the QEMU VM, RCVM containment, Hyper-V VM, or explicitly choose the AppContainer mode for compatible apps. Nothing was launched.',
    };
  }
  // Explicit opt-in to the legacy process mode. Labeled accurately below.
  if (appRecord.isolationEngine === 'rcvm' && !appRecord.requiresVm && !appRecord.preferVm && !appRecord.requiresQemu) {
    return { engine: 'rcvm', reason: 'Process containment: Job Object lifetime/resource caps with per-app profile folders, verified post-launch. This is NOT a virtual machine and does not cut network access.' };
  }
  // Explicit opt-in to the lightweight, non-VM token mode. Labeled accurately below.
  if (appRecord.isolationEngine === 'appcontainer' && !appRecord.requiresVm && !appRecord.preferVm && !appRecord.requiresQemu) {
    return { engine: 'appcontainer', reason: 'Optional lightweight mode: Windows AppContainer with verified container token. This is NOT a virtual machine and cannot run administrator installers, drivers, or services.' };
  }
  // Explicit full Hyper-V choice. Fails closed when Hyper-V is not ready.
  // A missing VM is never papered over by a weaker mode.
  if (appRecord.isolationEngine === 'hyperv' || appRecord.requiresVm || appRecord.preferVm) {
    if (!hypervReady) {
      return {
        engine: 'hyperv-unavailable',
        reason: 'Hyper-V VM isolation was requested, but Hyper-V is not ready. Turn on Hyper-V and virtualization in firmware, then provision a base image and guest credential. RunContainer did not launch anything, and did not fall back to any other mode.',
      };
    }
    return { engine: 'hyperv', reason: 'Full VM isolation via Hyper-V (guest OS boundary).' };
  }
  // Explicit genuine-VM choice. Fails closed when QEMU is not provisioned —
  // never runs the app contained while reporting a VM.
  if (appRecord.isolationEngine === 'qemu' || appRecord.requiresQemu) {
    if (!qemuReady) {
      const detail = (qemuMissing || []).filter(Boolean).join(' ');
      return {
        engine: 'qemu-unavailable',
        reason: `The genuine RCVM virtual machine was requested but is not provisioned yet. ${detail || 'Install QEMU and provision a base image from Windows media you own.'} Open Settings → QEMU VM setup. RunContainer did not launch anything, and did not fall back to any other mode.`,
      };
    }
    return { engine: 'qemu', reason: 'Genuine VM isolation: per-environment QEMU virtual machine (overlay disk, guest agent, no virtual network).' };
  }
  // Default and 'auto': genuine VM when provisioned, honest process containment
  // otherwise. Both paths verify before reporting; nothing runs uncontained.
  if (!qemuReady) {
    return { engine: 'rcvm', reason: 'No provisioned VM yet, so this app runs under RCVM process containment (Job Object caps, verified post-launch) until a QEMU base image is provisioned in Settings. This is NOT a virtual machine.' };
  }
  return { engine: 'qemu', reason: 'Genuine VM isolation: per-environment QEMU virtual machine (overlay disk, guest agent, no virtual network).' };
}

module.exports = { selectIsolationEngine };
