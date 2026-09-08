import electronBuilder from 'electron-builder';
import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.thihy.todolist',
  productName: 'thihy-todolist',
  copyright: 'Copyright © 2026 thihy',
  directories: {
    output: 'dist',
    buildResources: 'build',
  },
  files: ['out/**/*', 'package.json'],
  asarUnpack: ['**/*.{node,dll}'],
  publish: {
    provider: 'github',
    owner: 'thihy',
    repo: 'thihy-todolist',
    releaseType: 'release',
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
  mac: {
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
    category: 'public.app-category.productivity',
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    category: 'Office',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
};

electronBuilder.build({ config }).catch((err) => {
  console.error(err);
  process.exit(1);
});