const { spawn } = require('child_process');
const path = require('path');

const cwd = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const reactScript = isWindows ? 'npm.cmd' : 'npm';

const react = spawn(reactScript, ['run', 'start:react'], {
  cwd,
  stdio: 'inherit',
  shell: true,
});

react.on('exit', (code) => {
  if (code !== 0) process.exit(code);
});

setTimeout(() => {
  const electronScript = isWindows ? 'npx.cmd' : 'npx';
  const electron = spawn(electronScript, ['electron', '.'], {
    cwd,
    stdio: 'inherit',
    shell: true,
  });

  electron.on('exit', (code) => {
    process.exit(code);
  });
}, 8000);
