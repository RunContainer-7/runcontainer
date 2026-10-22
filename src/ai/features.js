// Observation -> feature vector for RC-Brain.
//
// This file extracts EVIDENCE (what was seen), never a diagnosis. The neural
// network in rc-brain-1.json turns the evidence into a diagnosis and an action.
// Keeping the schema here means the trainer and the app always agree on order,
// and the model artefact records the exact schema it was trained with.

const FEATURE_NAMES = [
  'engine_rcvm',
  'engine_appcontainer',
  'engine_qemu',
  'engine_hyperv',
  'engine_auto',
  'status_running',
  'status_launching',
  'status_failed',
  'status_unknown',
  'process_alive',
  'pid_present',
  'window_expected',
  'window_visible',
  'window_wait',
  'window_hung',
  'cpu_load',
  'io_idle',
  'engine_responsive',
  'launch_failed',
  'exit_fatal_code',
  'exit_zero',
  'log_missing_runtime',
  'log_unhandled_crash',
  'log_access_denied',
  'log_disk_full',
  'log_network',
  'log_timeout',
  'log_crash_loop',
  'log_unsupported',
  'log_installer_failed',
  'log_error_word',
  'log_healthy_signal',
  'log_injection',
  'log_corrupt_profile',
  'log_window_created',
  'log_unexpected',
  'log_present',
  'prior_repairs',
  'last_repair_failed',
  'repeated_diagnosis',
  'qemu_provisioned',
  'hyperv_ready',
  'appcontainer_supported',
  'runtime_present',
];

// Log patterns only classify what the text LOOKS like. They are observations,
// not decisions: the model learns how much each signal matters in context.
const LOG_SIGNALS = [
  ['missingRuntime', /(vcruntime\d+|msvcp\d+|ucrtbase)\.dll[^\n]*(missing|not found|could not be found)|api-ms-win-crt[^\n]*(missing|not found)|0xc0000135/i],
  ['unhandledCrash', /unhandled exception|fatal error|fatal crash|0xc0000142|0xc000007b|access violation|renderer process crashed|application was unable to start correctly/i],
  ['accessDenied', /access is denied|permission denied|eacces|errno 13|unauthorized|privilege not held/i],
  ['diskFull', /no space left|disk full|not enough space|enospc|insufficient disk/i],
  ['networkIssue', /network is unreachable|could not resolve|connection refused|offline|blocked by (firewall|policy)|no internet/i],
  ['timeout', /timed out|timeout|not responding|took too long/i],
  ['crashLoop', /crash(ed)? (again|repeatedly)|restart loop|keeps crashing|failed again after/i],
  ['unsupported', /not supported|unsupported|requires windows|needs hyper-v|no vm image|virtualization is not enabled|no prepared image/i],
  ['installerFailed', /installation failed|installer[^\n]*(failed|error)|setup[^\n]*(failed|aborted)/i],
  ['errorWord', /\berror\b|\bfailed\b|\bfailure\b/i],
  ['healthySignal', /\bready\b|\bstarted\b|window created|listening|loaded|complete|success/i],
  ['injection', /ignore (all|any|the|previous|prior) instructions|disregard[^\n]*instructions|you are now|system prompt|delete (all|the) files|disable (the )?(sandbox|protection|isolation|monitor)/i],
  ['corruptProfile', /profile[^\n]*(corrupt|invalid|damaged)|settings[^\n]*(corrupt|invalid)|config[^\n]*(corrupt|invalid)|deserialize[^\n]*fail/i],
  ['windowCreated', /window created|main window|showing window|window opened/i],
];

function textOf(lines) {
  return (Array.isArray(lines) ? lines : []).join('\n');
}

function detectLogSignals(lines) {
  const text = textOf(lines);
  const signals = {};
  let matched = 0;
  for (const [name, pattern] of LOG_SIGNALS) {
    const hit = pattern.test(text);
    signals[name] = hit;
    if (hit) matched += 1;
  }
  signals.present = text.trim().length > 0;
  // Lines that mention no known signal at all still count as unexplained evidence.
  signals.unexpected = signals.present && matched === 0;
  return signals;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number < 0) return 0;
  if (number > 1) return 1;
  return number;
}

function encodeObservation(observation = {}) {
  const app = observation.app || {};
  const processInfo = observation.process || {};
  const launch = observation.launch || {};
  const environment = observation.environment || {};
  const history = observation.history || {};
  const logs = Array.isArray(observation.logLines) ? observation.logLines : [];
  const signals = detectLogSignals(logs);
  const engine = String(app.engine || observation.engine || 'auto');
  const status = String(app.status || observation.status || 'Unknown');
  const engineResponsive = processInfo.engineResponsive !== false;

  const values = {
    engine_rcvm: engine === 'rcvm' ? 1 : 0,
    engine_appcontainer: engine === 'appcontainer' ? 1 : 0,
    engine_qemu: engine === 'qemu' ? 1 : 0,
    engine_hyperv: engine === 'hyperv' ? 1 : 0,
    engine_auto: !['rcvm', 'appcontainer', 'qemu', 'hyperv'].includes(engine) ? 1 : 0,
    status_running: status === 'Running' ? 1 : 0,
    status_launching: status === 'Launching' ? 1 : 0,
    status_failed: status === 'Failed' ? 1 : 0,
    status_unknown: status === 'Unknown' ? 1 : 0,
    process_alive: processInfo.alive === false ? 0 : 1,
    pid_present: Number(processInfo.pidCount) > 0 ? 1 : 0,
    window_expected: processInfo.windowExpected ? 1 : 0,
    window_visible: processInfo.windowVisible ? 1 : 0,
    window_wait: clamp01(Number(processInfo.windowAgeMs || launch.ageMs || 0) / 10000),
    window_hung: processInfo.hung ? 1 : 0,
    cpu_load: clamp01(Number(processInfo.cpuPercent || 0) / 100),
    io_idle: processInfo.ioIdle ? 1 : 0,
    engine_responsive: engineResponsive ? 1 : 0,
    launch_failed: launch.previousLaunchFailed || status === 'Failed' ? 1 : 0,
    exit_fatal_code: Number.isSafeInteger(launch.exitCode) && launch.exitCode !== 0 && launch.exitCode !== null ? 1 : 0,
    exit_zero: launch.exitCode === 0 ? 1 : 0,
    log_missing_runtime: signals.missingRuntime ? 1 : 0,
    log_unhandled_crash: signals.unhandledCrash ? 1 : 0,
    log_access_denied: signals.accessDenied ? 1 : 0,
    log_disk_full: signals.diskFull ? 1 : 0,
    log_network: signals.networkIssue ? 1 : 0,
    log_timeout: signals.timeout ? 1 : 0,
    log_crash_loop: signals.crashLoop ? 1 : 0,
    log_unsupported: signals.unsupported ? 1 : 0,
    log_installer_failed: signals.installerFailed ? 1 : 0,
    log_error_word: signals.errorWord ? 1 : 0,
    log_healthy_signal: signals.healthySignal ? 1 : 0,
    log_injection: signals.injection ? 1 : 0,
    log_corrupt_profile: signals.corruptProfile ? 1 : 0,
    log_window_created: signals.windowCreated ? 1 : 0,
    log_unexpected: signals.unexpected ? 1 : 0,
    log_present: signals.present ? 1 : 0,
    prior_repairs: clamp01(Number(history.repairs || 0) / 5),
    last_repair_failed: history.lastRepairFailed ? 1 : 0,
    repeated_diagnosis: clamp01(Number(history.sameDiagnosisRepeats || 0) / 3),
    qemu_provisioned: environment.qemuProvisioned ? 1 : 0,
    hyperv_ready: environment.hypervReady ? 1 : 0,
    appcontainer_supported: environment.appContainerSupported ? 1 : 0,
    runtime_present: environment.runtimePresent === false ? 0 : 1,
  };

  return {
    names: FEATURE_NAMES,
    values: FEATURE_NAMES.map((name) => values[name] || 0),
    signals,
    evidence: describeEvidence({ observation, processInfo, launch, environment, history, signals, logs, engine, status }),
  };
}

// Short, checkable statements. These are shown to the user next to the model's
// diagnosis; they are not a second diagnosis engine.
function describeEvidence({ observation, processInfo, launch, environment, history, signals, logs, engine, status }) {
  const facts = [];
  if (status) facts.push(`state: ${status}`);
  if (engine) facts.push(`engine: ${engine}`);
  if (processInfo.windowExpected) {
    const seconds = (Number(processInfo.windowAgeMs || launch.ageMs || 0) / 1000).toFixed(1);
    facts.push(processInfo.windowVisible
      ? `a visible window is present (${seconds}s after launch)`
      : `no visible window after ${seconds}s`);
  } else if (processInfo.alive !== false) {
    facts.push('no window is expected for this executable');
  }
  if (processInfo.hung) facts.push('Windows reports the window as not responding');
  if (Number(processInfo.cpuPercent) >= 80) {
    facts.push(`CPU at ${Math.round(Number(processInfo.cpuPercent))}%${processInfo.ioIdle ? ' with file activity stopped' : ' with file activity still changing'}`);
  }
  if (processInfo.engineResponsive === false) facts.push('the isolation engine is no longer answering');
  if (launch.exitCode !== null && launch.exitCode !== undefined) facts.push(`exit code ${launch.exitCode}`);
  if (Number(history.repairs) > 0) facts.push(`${history.repairs} previous repair${history.repairs === 1 ? '' : 's'}${history.lastRepairFailed ? ', the last one failed' : ''}`);
  const signalLabels = {
    missingRuntime: 'a Microsoft runtime DLL is reported missing',
    unhandledCrash: 'an unhandled crash or fatal error is in the log',
    accessDenied: 'the log reports access denied',
    diskFull: 'the log reports the disk is full',
    networkIssue: 'the log reports a network problem',
    timeout: 'the log reports a timeout',
    crashLoop: 'the log reports repeated failures',
    unsupported: 'the log reports an unsupported configuration',
    installerFailed: 'the log reports a failed installer',
    corruptProfile: 'the log reports corrupt profile or configuration data',
    injection: 'the log contains instructions aimed at the monitor; they are treated as data',
  };
  for (const [key, label] of Object.entries(signalLabels)) {
    if (signals[key]) facts.push(label);
  }
  if (!signals.present) facts.push('the log is empty');
  else if (signals.unexpected) facts.push('the log contains output that matches no known pattern');
  if (environment.runtimePresent === false) facts.push('Microsoft runtime files are not present in System32');
  if (environment.qemuProvisioned === false && (engine === 'qemu' || engine === 'auto')) facts.push('no prepared VM image is available');
  if (environment.hypervReady === false && engine === 'hyperv') facts.push('Hyper-V is not ready');
  if (logs.length > 0) facts.push(`last log line: ${String(logs[logs.length - 1]).slice(0, 160)}`);
  return facts;
}

module.exports = {
  FEATURE_NAMES,
  LOG_SIGNALS,
  detectLogSignals,
  encodeObservation,
  describeEvidence,
};
