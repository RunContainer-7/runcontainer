// The Runbook: RunContainer's hard-coded tool.
//
// Why a lookup table sits next to a trained model. Some failures have an exact,
// documented signature - a specific Windows error, a specific setup exit code, a
// refusal that means one thing. For those, a table is *better* than a
// classifier: it cannot be 99% right, it is either the documented answer or no
// answer at all. For anything the table does not recognise it says so, and the
// model keeps deciding - which is exactly where a fixed table is useless and a
// net is not.
//
// Nothing here is inferred, and nothing here is learned. Every rule names the
// Windows error or the RunContainer document that gives it meaning, and a rule
// only fires on its own exact signature. When two rules of equal specificity
// disagree, the consultation is REFUSED as ambiguous rather than resolved by
// preference: a lookup table that guesses is worse than no table.

const { detectLogSignals } = require('./features');

// Specificity tiers. A rule at a lower tier only counts when no higher tier
// matched, so "this exact Windows error" always beats "the log mentions errors".
const TIER = {
  EXACT_ERROR: 1,
  AGENT_MEASURED: 2,
  DOCUMENTED_STATE: 3,
  TEXT_CLASS: 4,
};

function signatureText(observation) {
  const lines = Array.isArray(observation?.logLines) ? observation.logLines : [];
  return lines.slice(-40).join('\n');
}

function exitCodeOf(observation) {
  const raw = observation?.launch?.exitCode;
  if (!Number.isSafeInteger(raw)) return null;
  return raw < 0 ? raw >>> 0 : raw;
}

// The context a rule sees. Everything in it was measured; nothing in it is a
// guess, and no rule may look at anything else.
function buildContext(observation = {}) {
  const text = signatureText(observation);
  const signals = detectLogSignals(Array.isArray(observation.logLines) ? observation.logLines : []);
  const agents = observation.agents || {};
  const environment = observation.environment || {};
  const engine = String(observation.app?.engine || observation.engine || 'auto');
  return {
    text,
    signals,
    exitCode: exitCodeOf(observation),
    agents,
    environment,
    engine,
    has: (pattern) => pattern.test(text),
  };
}

const RULES = [
  {
    id: 'elevation_required',
    tier: TIER.EXACT_ERROR,
    label: 'Windows refused the start because the executable asks for administrator rights (Win32 740)',
    diagnosis: 'isolation_unsupported',
    action: 'advise_configuration',
    why: 'Error 740 is Windows saying the manifest requires administrator rights, which a normal process cannot grant. RunContainer may only ask for approval and start the same contained launcher elevated, or run the app in a VM environment - there is no repair that removes the requirement.',
    basis: 'knowledge.failureDefinitions (Win32 740); src/services/isolatedLaunch.js elevation path',
    when: (ctx) => ctx.exitCode === 740 || ctx.has(/\b(error|win32|exception)\D{0,12}740\b|requires elevation|requested operation requires elevation|administrator (rights|privileges) (are )?(required|needed)/i),
  },
  {
    id: 'store_bridge',
    tier: TIER.EXACT_ERROR,
    label: 'The download is a Microsoft Store bridge, not an application',
    diagnosis: 'isolation_unsupported',
    action: 'advise_configuration',
    why: 'A "ms-windows-store:" bridge asks Windows to install a Store package system-wide into WindowsApps and opens the Store frame. RunContainer refuses it before anything starts, so the correct outcome is to explain that and point at a real installer or a VM environment.',
    basis: '0.7.7 Store-bridge refusal in public/main.js',
    when: (ctx) => ctx.has(/ms-windows-store:|microsoft store|windowsapps.*store/i),
  },
  {
    id: 'missing_runtime',
    tier: TIER.EXACT_ERROR,
    label: 'A Microsoft runtime DLL the app needs is missing',
    diagnosis: 'missing_runtime',
    action: 'advise_runtime_install',
    why: 'The log names a Visual C++ / UCRT / api-ms-win-crt dependency that is not installed, or the process failed with 0xC0000135 (DLL not found). The documented response is to point at the official Microsoft Visual C++ Redistributable; RunContainer never installs system runtimes silently.',
    basis: 'knowledge.diagnoses.missing_runtime; features.LOG_SIGNALS.missingRuntime',
    when: (ctx) => ctx.signals.missingRuntime || ctx.exitCode === 0xc0000135,
  },
  {
    id: 'side_by_side_broken',
    tier: TIER.EXACT_ERROR,
    label: 'Windows reports a broken side-by-side configuration',
    diagnosis: 'missing_runtime',
    action: 'advise_runtime_install',
    why: '"The application has failed to start because its side-by-side configuration is incorrect" means a required assembly or runtime the manifest names is missing or mismatched - the same class of environmental failure as a missing DLL, and not something a restart repairs.',
    basis: 'features.LOG_SIGNALS.sideBySide; dataset side_by_side_missing',
    when: (ctx) => ctx.signals.sideBySide,
  },
  {
    id: 'installer_reboot_pending',
    tier: TIER.EXACT_ERROR,
    label: 'The setup needs a restart before it can continue',
    diagnosis: 'installer_failed',
    action: 'advise_configuration',
    why: 'Setup exit code 3010 (and an explicit "reboot required" line) means the installer finished the part it could and Windows must restart before the rest can run. Restarting the app would repeat the same failure, so the documented response is to say so.',
    basis: 'features.LOG_SIGNALS.rebootRequired; exitClass installer codes (3010); dataset installer_reboot_pending',
    when: (ctx) => ctx.signals.rebootRequired || ctx.exitCode === 3010,
  },
  {
    id: 'installer_failed_code',
    tier: TIER.EXACT_ERROR,
    label: 'Setup failed with a documented installer exit code',
    diagnosis: 'installer_failed',
    action: 'restart_same_profile',
    why: 'Windows Installer exit codes 1602 (cancelled by user), 1603 (fatal error during installation) and 1618 (another installation is already in progress) come from the setup program itself. The documented response is a bounded restart inside the environment, never a clean profile or a delete.',
    basis: 'features.exitClass installer codes (1602/1603/1618); knowledge.diagnoses.installer_failed',
    when: (ctx) => [1602, 1603, 1618].includes(ctx.exitCode),
  },
  {
    id: 'access_violation',
    tier: TIER.EXACT_ERROR,
    label: 'The app died with an access violation (0xC0000005)',
    diagnosis: 'crash_unhandled',
    action: 'restart_same_profile',
    why: '0xC0000005 is the process reading or writing memory it does not own. That is a crash of the app itself, so the documented response is one bounded restart with the same profile, and escalation if it repeats.',
    basis: 'features.exitClass exit_access_violation; knowledge.diagnoses.crash_unhandled',
    when: (ctx) => ctx.exitCode === 0xc0000005 || ctx.has(/0xc0000005|access violation/i),
  },
  {
    id: 'untrusted_mount_point',
    tier: TIER.EXACT_ERROR,
    label: 'The app folder contains an untrusted mount point (junction/reparse link)',
    diagnosis: 'permission_denied',
    action: 'escalate',
    why: '"The path cannot be traversed because it contains an untrusted mount point" means a junction inside the folder (Windows creates one under INetCache the first time anything is cached). Recursive work cannot traverse it, and removing it is a delete-path action with its own confirmation rather than a monitoring repair, so this is reported instead of guessed at.',
    basis: '0.7.7 junction handling in public/main.js removeSandboxTree',
    when: (ctx) => ctx.has(/untrusted mount point|cannot be traversed/i),
  },
  {
    id: 'profile_denied_write',
    tier: TIER.AGENT_MEASURED,
    label: 'A write inside the app\u2019s own folder was denied',
    diagnosis: 'permission_denied',
    action: 'repair_permissions',
    why: 'An agent measured a denied write inside the folder RunContainer manages for this app. The app cannot run while it cannot write to its own profile, and restoring the folder\u2019s inherited access control entries is the documented repair.',
    basis: 'knowledge.diagnoses.permission_denied; dataset agents_found_folder_denied',
    when: (ctx) => Boolean(ctx.agents.aclDenied),
  },
  {
    id: 'engine_no_longer_answering',
    tier: TIER.AGENT_MEASURED,
    label: 'The isolation engine is no longer alive for this app',
    diagnosis: 'engine_unresponsive',
    action: 'restart_engine',
    why: 'An agent found the launcher, QEMU process or Hyper-V host that owns this app gone, so nothing is answering for it any more. Restarting that engine, on the same data, is the documented recovery.',
    basis: 'knowledge.diagnoses.engine_unresponsive; knowledge.backends.*.safeRecovery',
    when: (ctx) => Boolean(ctx.agents.engineDead),
  },
  {
    id: 'window_owned_outside_host',
    tier: TIER.AGENT_MEASURED,
    label: 'The app has a visible window owned outside its host window',
    diagnosis: 'healthy',
    action: 'none',
    why: 'An agent found a visible window that belongs to the app but is owned through a host RunContainer did not create (an elevated launcher, for example). The app is working; the window is simply not where the ordinary check looks.',
    basis: '0.7.6 elevated host window; dataset agents_window_owned_outside',
    when: (ctx) => Boolean(ctx.agents.windowElsewhere) && !ctx.agents.engineDead,
  },
  {
    id: 'setup_produced_executable',
    tier: TIER.AGENT_MEASURED,
    label: 'Setup finished and produced an executable',
    diagnosis: 'healthy',
    action: 'none',
    why: 'An agent found a new executable in the app\u2019s folder after its staged setup program ran, so the app under test is that program. This is the expected end of a setup, not a failure.',
    basis: '0.7.8 setup completion observation; dataset unseen_agents_setup_finished_new_exe',
    when: (ctx) => Boolean(ctx.agents.newExePresent) && !Boolean(ctx.agents.installerRunning) && !ctx.agents.engineDead,
  },
  {
    id: 'setup_still_running',
    tier: TIER.AGENT_MEASURED,
    label: 'The app\u2019s setup program is still running',
    diagnosis: 'starting_slow',
    action: 'wait',
    why: 'An agent found the staged setup program of this app still running. A setup program is expected to take far longer than a launch, and interrupting it is not a repair; the documented response is to keep waiting.',
    basis: '0.7.8 setup progress; dataset agents_dispatch_setup_pending',
    when: (ctx) => Boolean(ctx.agents.installerRunning),
  },
  {
    id: 'hyperv_not_ready',
    tier: TIER.DOCUMENTED_STATE,
    label: 'Hyper-V is not ready on this PC',
    diagnosis: 'isolation_unsupported',
    action: 'advise_configuration',
    why: 'A Hyper-V app needs Windows Pro/Enterprise/Education with virtualization enabled and Hyper-V installed. Nothing about the app can be repaired to change that.',
    basis: 'knowledge.backends.hyperv.requires',
    when: (ctx) => ctx.engine === 'hyperv' && ctx.environment.hypervReady === false,
  },
  {
    id: 'no_prepared_vm_image',
    tier: TIER.DOCUMENTED_STATE,
    label: 'No prepared VM image is available',
    diagnosis: 'isolation_unsupported',
    action: 'advise_configuration',
    why: 'A QEMU environment needs a user-provided Windows image and a per-app overlay disk. Without one there is nothing to boot.',
    basis: 'knowledge.backends.qemu.requires',
    when: (ctx) => ctx.engine === 'qemu' && ctx.environment.qemuProvisioned === false,
  },
  {
    id: 'instructions_in_app_output',
    tier: TIER.TEXT_CLASS,
    label: 'The app\u2019s output contains instructions aimed at the monitor',
    diagnosis: 'user_data_risk',
    action: 'escalate',
    why: 'Log text is untrusted evidence and is never obeyed. Text that tries to give RunContainer orders is treated as a finding to report, and it never becomes a repair.',
    basis: 'knowledge.prohibitions; features.LOG_SIGNALS.injection',
    when: (ctx) => Boolean(ctx.signals.injection),
  },
];

const RULE_BY_ID = Object.fromEntries(RULES.map((rule) => [rule.id, rule]));

function ruleView(rule) {
  return {
    id: rule.id,
    tier: rule.tier,
    label: rule.label,
    diagnosis: rule.diagnosis,
    action: rule.action,
    why: rule.why,
    basis: rule.basis,
  };
}

// Consults the table. Returns a match only when exactly one rule of the best
// specificity matched; several equally specific rules that disagree are reported
// as ambiguous, with no recommendation at all.
function consult({ observation = {}, evidence = [] } = {}) {
  const ctx = buildContext(observation);
  let matched;
  try {
    matched = RULES.filter((rule) => {
      try {
        return Boolean(rule.when(ctx));
      } catch (error) {
        // A rule that cannot evaluate its own signature must never fire.
        return false;
      }
    });
  } catch (error) {
    matched = [];
  }

  const base = {
    tool: 'runbook',
    consulted: true,
    rules: RULES.length,
    evidence: Array.isArray(evidence) ? evidence.slice(0, 4) : [],
  };

  if (matched.length === 0) {
    return {
      ...base,
      matched: false,
      rule: null,
      ambiguous: [],
      summary: 'No documented signature in the Runbook matched this observation, so the model keeps deciding.',
    };
  }

  const best = Math.min(...matched.map((rule) => rule.tier));
  const top = matched.filter((rule) => rule.tier === best);
  const conclusions = new Set(top.map((rule) => `${rule.diagnosis}/${rule.action}`));

  if (conclusions.size > 1) {
    return {
      ...base,
      matched: false,
      rule: null,
      ambiguous: top.map((rule) => rule.id),
      summary: `The Runbook found ${top.length} equally specific signatures that disagree (${top.map((rule) => rule.id).join(', ')}), so it gives no recommendation.`,
    };
  }

  return {
    ...base,
    matched: true,
    rule: ruleView(top[0]),
    ambiguous: [],
    summary: `${top[0].label}. ${top[0].why}`,
  };
}

// True when the table recommends exactly what the model proposed. Used by the
// harmony agent: agreement is worth stating, not worth acting on.
function agreesWith(runbook, actionId) {
  return Boolean(runbook?.matched && runbook.rule?.action === actionId);
}

module.exports = {
  TIER,
  RULES,
  RULE_BY_ID,
  buildContext,
  consult,
  agreesWith,
  signatureText,
  exitCodeOf,
};
