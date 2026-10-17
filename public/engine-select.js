// VM-first engine selection. Pure function so it can be unit tested.
//
// Required path: 'hyperv' — a real guest VM. AppContainer remains ONLY as an
// explicitly chosen optional mode ('appcontainer') and is labeled as NOT a VM.
// There is no 'profile' or 'sandboxie' path: unisolated execution is never
// selected, even on request. A VM request with Hyper-V not ready yields
// 'hyperv-unavailable' (fail closed), never a silent AppContainer fallback.
function selectIsolationEngine({ platform = process.platform, appRecord = {}, hypervReady = false } = {}) {
  if (platform !== 'win32') {
    return { engine: 'unavailable', reason: 'Isolation requires Windows 10/11.' };
  }
  if (appRecord.isolationEngine === 'profile') {
    return {
      engine: 'refused',
      reason: 'This app is marked "unguarded profile mode", which is not a security boundary. RunContainer refuses to launch it unisolated. Choose Hyper-V VM isolation, or explicitly choose the AppContainer mode for compatible apps. Nothing was launched.',
    };
  }
  if (appRecord.isolationEngine === 'sandboxie' || appRecord.launchMode === 'sandboxie') {
    return {
      engine: 'refused',
      reason: 'Sandboxie is not an allowed isolation backend for RunContainer. Choose Hyper-V VM isolation, or explicitly choose the AppContainer mode for compatible apps. Nothing was launched.',
    };
  }
  // Explicit opt-in to the lightweight, non-VM mode. Labeled accurately below.
  if (appRecord.isolationEngine === 'appcontainer' && !appRecord.requiresVm && !appRecord.preferVm) {
    return { engine: 'appcontainer', reason: 'Optional lightweight mode: Windows AppContainer with verified container token. This is NOT a virtual machine and cannot run administrator installers, drivers, or services.' };
  }
  // Default and every VM-needing/preferring record: the VM path. Fail closed
  // when Hyper-V is not ready — never fall back to AppContainer silently.
  if (!hypervReady) {
    const why = appRecord.requiresVm || appRecord.preferVm || appRecord.isolationEngine === 'hyperv'
      ? 'Hyper-V VM isolation was requested'
      : 'VM isolation is the required execution path';
    return {
      engine: 'hyperv-unavailable',
      reason: `${why}, but Hyper-V is not ready. Enable Hyper-V on Windows 10/11 Pro/Enterprise/Education with virtualization enabled in firmware, provision a base image and guest credential. RunContainer did not launch anything, and did not fall back to any other mode.`,
    };
  }
  return { engine: 'hyperv', reason: 'Full VM isolation via Hyper-V (guest OS boundary).' };
}

module.exports = { selectIsolationEngine };
