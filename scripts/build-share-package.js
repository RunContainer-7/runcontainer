const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const source = 'C:\\RunContainer\\runcontainer\\out\\RunContainer-win32-x64';
const packageRoot = 'C:\\RunContainer\\runcontainer\\out\\RunContainer-Share';
const zipPath = 'C:\\RunContainer\\runcontainer\\out\\RunContainer-OneClick-Share.zip';

fs.rmSync(packageRoot, { recursive: true, force: true });
fs.mkdirSync(packageRoot, { recursive: true });

const appDest = path.join(packageRoot, 'RunContainer-win32-x64');
fs.cpSync(source, appDest, { recursive: true });
fs.copyFileSync('C:\\RunContainer\\runcontainer\\out\\RunContainer-Share\\RunContainer.vbs', path.join(packageRoot, 'RunContainer.vbs'));

if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath, { force: true });
}

try {
  execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', packageRoot, '.'], { stdio: 'inherit' });
} catch (error) {
  console.error('tar failed, falling back to PowerShell Compress-Archive');
  const psScript = `Compress-Archive -Path '${packageRoot}\\*' -DestinationPath '${zipPath}' -Force`;
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { stdio: 'inherit' });
}

const stats = fs.statSync(zipPath);
console.log(JSON.stringify({ zipPath, size: stats.size }, null, 2));
