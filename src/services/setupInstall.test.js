const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  detectInstallerFamily,
  looksLikeSetupByName,
  planSetupRun,
  findInstalledCandidates,
} = require('./setupInstall');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-setup-'));
}

function writeExe(dir, name, marker) {
  const file = path.join(dir, name);
  const padding = Buffer.alloc(512, 0);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('MZ'), padding, Buffer.from(marker, 'latin1')]));
  return file;
}

describe('setup program detection and planning', () => {
  it('recognises the installer families by their own format strings', () => {
    const dir = tempDir();
    expect(detectInstallerFamily(writeExe(dir, 'a.exe', 'Inno Setup Setup Data'))).toMatchObject({ id: 'inno' });
    expect(detectInstallerFamily(writeExe(dir, 'b.exe', 'Nullsoft Install System v3'))).toMatchObject({ id: 'nsis' });
    expect(detectInstallerFamily(writeExe(dir, 'c.exe', 'InstallShield Software'))).toMatchObject({ id: 'installshield' });
    expect(detectInstallerFamily(writeExe(dir, 'd.exe', 'wixburn bundle'))).toMatchObject({ id: 'burn' });
    expect(detectInstallerFamily(writeExe(dir, 'e.exe', 'plain application'))).toBeNull();
    expect(detectInstallerFamily(path.join(dir, 'missing.exe'))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names the unattended switches for each family it knows', () => {
    const dir = tempDir();
    const inno = detectInstallerFamily(writeExe(dir, 'inno.exe', 'Inno Setup'));
    expect(inno.args).toContain('/VERYSILENT');
    const nsis = detectInstallerFamily(writeExe(dir, 'nsis.exe', 'Nullsoft'));
    expect(nsis.args).toEqual(['/S']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats an ordinary application as the app, not as setup', () => {
    const dir = tempDir();
    const app = writeExe(dir, 'editor.exe', 'Qt application');
    const plan = planSetupRun({ source: app, name: 'Editor' });
    expect(plan.isSetup).toBe(false);
    expect(plan.mode).toBe('none');
    expect(plan.summary).toContain('not a setup program');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows the wizard by default and plans unattended setup only on request', () => {
    const dir = tempDir();
    const installer = writeExe(dir, 'AppSetup.exe', 'Inno Setup');
    expect(planSetupRun({ source: installer, name: 'AppSetup' }).mode).toBe('wizard');
    const plan = planSetupRun({ source: installer, name: 'AppSetup', setupMode: 'silent' });
    expect(plan.isSetup).toBe(true);
    expect(plan.mode).toBe('silent');
    expect(plan.args).toContain('/VERYSILENT');
    expect(plan.summary).toContain('Inno Setup');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the wizard when the installer type is unknown or the user asks for it', () => {
    const dir = tempDir();
    const unknown = writeExe(dir, 'mystery-installer.exe', 'custom packer');
    const byName = planSetupRun({ source: unknown, name: 'mystery-installer' });
    expect(byName.isSetup).toBe(true);
    expect(byName.mode).toBe('wizard');
    expect(byName.summary).toContain('not recognised');

    const inno = writeExe(dir, 'Setup.exe', 'Inno Setup');
    const forced = planSetupRun({ source: inno, name: 'Setup', setupMode: 'wizard' });
    expect(forced.mode).toBe('wizard');
    expect(forced.summary).toContain('Complete it');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports setup that has already produced an app', () => {
    const dir = tempDir();
    const installer = writeExe(dir, 'Setup.exe', 'Inno Setup');
    const installed = writeExe(dir, 'app.exe', 'the real application');
    const plan = planSetupRun({ source: installer, name: 'Setup', installedExePath: installed });
    expect(plan.mode).toBe('installed');
    expect(plan.installedExePath).toBe(installed);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('only uses version metadata as a weak name signal', () => {
    expect(looksLikeSetupByName({ name: 'Visual Studio Installer' })).toBe(true);
    expect(looksLikeSetupByName({ name: 'Code', metadata: { originalName: 'setup.exe' } })).toBe(true);
    expect(looksLikeSetupByName({ name: 'Minecraft Education Installer' })).toBe(true);
    expect(looksLikeSetupByName({ name: 'Notepad' })).toBe(false);
    expect(looksLikeSetupByName({ name: 'update-manager' })).toBe(true);
  });

  it('finds what setup installed, newest and largest first, without following links', () => {
    const dir = tempDir();
    const nested = path.join(dir, 'program files', 'Vendor', 'App');
    fs.mkdirSync(nested, { recursive: true });
    const small = path.join(nested, 'helper.exe');
    const big = path.join(nested, 'Application.exe');
    fs.writeFileSync(small, Buffer.alloc(10));
    fs.writeFileSync(big, Buffer.alloc(4096));
    const candidates = findInstalledCandidates(dir, { exclude: [small] });
    expect(candidates.map((entry) => path.basename(entry.path))).toEqual(['Application.exe']);
    // A `since` in the future finds nothing rather than guessing.
    expect(findInstalledCandidates(dir, { since: Date.now() + 60000 })).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
