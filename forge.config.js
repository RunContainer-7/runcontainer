const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    icon: 'public/runcontainer-icon',
    executableName: 'RunContainer',
    name: 'RunContainer',
    overwrite: true,
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
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
