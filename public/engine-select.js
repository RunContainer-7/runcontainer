// Fail-closed engine selection. Pure function so it can be unit tested.
// Engines: 'appcontainer' (lightweight, compatible apps only), 'hyperv' (full VM
// for arbitrary installers). There is deliberately no 'profile' or 'sandboxie'
// launch path: unisolated execution is never selected, even on request.
function selectIsolationEngine({ platform = process.platform, appRecord = {}, hypervReady = false } = {}) {
  if (platform !== 'win32') {
    return { engine: 'unavailable', reason: 'Isolation requires Windows 10/11.' };
  }
  // Explicit legacy opt-out must not silently downgrade: refuse instead.
  if (appRecord.isolationEngine === 'profile') {
    return {
      engine: 'refused',
      reason: 'This app is marked "unguarded profile mode", which is not a security boundary. RunContainer refuses to launch it unisolated. Clear that setting to use AppContainer, or use a Hyper-V VM for software that cannot run in a container.',
    };
  }
  if (appRecord.isolationEngine === 'sandboxie' || appRecord.launchMode === 'sandboxie') {
    return {
      engine: 'refused',
      reason: 'Sandboxie is not an allowed isolation backend for RunContainer. Choose AppContainer (compatible apps) or a Hyper-V VM (arbitrary software) instead.',
    };
  }
  // Apps flagged as needing a full VM (admin installers, drivers/services).
  if (appRecord.requiresVm) {
    if (!hypervReady) {
      return {
        engine: 'hyperv-unavailable',
        reason: 'This app needs a full virtual machine (administrator installer, driver, or service), but Hyper-V is not ready. Enable Hyper-V on Windows 10/11 Pro/Enterprise/Education with virtualization enabled in firmware. RunContainer did not launch anything.',
      };
    }
    return { engine: 'hyperv', reason: 'Full VM isolation via Hyper-V.' };
  }
  // Default: AppContainer for compatible apps; Hyper-V when explicitly preferred.
  if (appRecord.preferVm) {
    if (!hypervReady) {
      return {
        engine: 'hyperv-unavailable',
        reason: 'Hyper-V VM was requested but Hyper-V is not ready. Enable Hyper-V (Pro/Enterprise/Education + virtualization in firmware) or clear the VM preference to try AppContainer for compatible apps.',
      };
    }
    return { engine: 'hyperv', reason: 'Full VM isolation via Hyper-V (explicitly preferred).' };
  }
  return { engine: 'appcontainer', reason: 'Windows AppContainer with verified container token.' };
}

module.exports = { selectIsolationEngine };
