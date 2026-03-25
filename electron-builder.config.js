module.exports = {
  appId:       'com.internal.ui-comparison-desktop',
  productName: 'UI Comparison',
  directories: {
    buildResources: 'build',
    output:         'dist-installer',
  },
  files: [
    'dist/**/*',
    'package.json',
  ],
  asar: true,
  asarUnpack: [
    '**/node_modules/better-sqlite3/**',
    '**/node_modules/playwright/**',
    '**/*.node',
  ],
  extraResources: [
    {
      from: '${env.PLAYWRIGHT_BROWSERS_PATH}',
      to:   'browsers',
      filter: ['**/*'],
    },
  ],
  win: {
    target:      [{ target: 'nsis', arch: ['x64'] }],
    icon:        'build/icon.ico',
  },
  nsis: {
    oneClick:            false,
    allowToChangeInstallationDirectory: true,
    installerIcon:       'build/icon.ico',
    uninstallerIcon:     'build/icon.ico',
    shortcutName:        'UI Comparison',
    createStartMenuShortcut: true,
    createDesktopShortcut:   true,
  },
  mac: {
    target:       [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    icon:         'build/icon.icns',
    category:     'public.app-category.developer-tools',
    hardenedRuntime:     true,
    gatekeeperAssess:    false,
    entitlements:        'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
  dmg: {
    sign: false,
  },
  publish: [
    {
      provider: 'generic',
      url: 'https://internal-updates.your-org.example.com/ui-comparison',
    },
  ],
};