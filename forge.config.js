const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const nightly = /-nightly\./.test(require('./package.json').version);

module.exports = {
  packagerConfig: {
    asar: true,
    // Explicit .ico: Windows picks this for the packaged RunContainer.exe and
    // the window/taskbar icon, and it carries every size 16-256.
    icon: nightly ? 'public/runcontainer-nightly-icon.ico' : 'public/runcontainer-icon.ico',
    executableName: nightly ? 'RunContainerNightly' : 'RunContainer',
    name: nightly ? 'RunContainer Nightly' : 'RunContainer',
    overwrite: true,
    // The main process only needs Electron itself plus Node builtins, so drop
    // devDependencies from the shipped app. This also keeps paths short: dev
    // trees (typescript-eslint, testing-library) contain ~190-char paths that
    // break Inno Setup (MAX_PATH) once prefixed with the checkout directory.
    prune: true,
    // Never ship build caches (babel-loader/terser): thousands of files with
    // hash names up to ~230 chars that also break the installer build.
    // (Forward-slash style like electron-packager's own defaults: Forge
    // normalizes paths before matching, so backslash classes never match.)
    ignore: [
      /\/\.cache(\/|$)/,
      /^\/dist(\/|$)/,
      /^\/out(\/|$)/,
      /^\/build\/build(\/|$)/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'RunContainer',
        authors: 'RunContainer',
        description: 'Sandboxed app launcher',
        setupIcon: 'public/runcontainer-icon.ico',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
