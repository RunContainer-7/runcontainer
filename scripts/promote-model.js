// Model activation and rollback CLI.
//
//   node scripts/promote-model.js --status
//   node scripts/promote-model.js --verify
//   node scripts/promote-model.js --activate rc-brain-2-candidate.json
//   node scripts/promote-model.js --rollback
//
// The gate logic lives in src/ai/registry.js so the app, the release workflow
// and the tests all enforce the same rules. A candidate only becomes current
// when it matches this build's feature schema and passes the evaluation gates.
// The previous artefact stays on disk and its name is kept in the registry, so
// rollback never deletes weights.

const { inspect, activate, rollback, readRegistry } = require('../src/ai/registry');

function main(argv) {
  if (argv.includes('--activate')) {
    const file = argv[argv.indexOf('--activate') + 1];
    const result = activate(file);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.activated ? 0 : 1);
  }
  if (argv.includes('--rollback')) {
    const result = rollback();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.rolledBack ? 0 : 1);
  }
  const registry = readRegistry();
  const current = inspect(registry.current);
  const previous = registry.previous ? inspect(registry.previous) : null;
  console.log(JSON.stringify({ registry, current, previous }, null, 2));
  if (argv.includes('--verify') && !current.ok) process.exit(1);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { inspect, activate, rollback, readRegistry };
