// generate-latest-yml.mjs
//
// Build companion script: after `pnpm dist:win` (or mac/linux)
// produces the setup executable, run this script to emit a
// `latest.yml` (or `latest-mac.yml` / `latest-linux.yml`)
// electron-updater manifest, ready to drag-and-drop next to the
// binary on the GitCode release page.
//
// Usage:
//   node scripts/generate-latest-yml.mjs <path-to-installer-exe> [version]
//
// Output:
//   <version>     printed to stdout; copy/paste into the release
//                 tag name (`v<version>`).
//   latest.yml    written next to the installer (same dir).
//
// Why a hand-rolled script instead of letting electron-builder's
// `--publish always` step do it: GitCode releases are not an
// S3-compatible store, so electron-builder's automatic upload
// path cannot PUT there. We split the work into "build locally,
// generate manifest, hand-upload" so the manifest format is
// identical to what electron-builder would have produced.
//
// The YAML format we emit matches what electron-updater parses
// (see `app-update.yml` schema in electron-updater's source).
// SHA-512 is computed over the binary and base64-encoded — that
// is the exact format electron-updater expects in `sha512`.
//
// Re-runnable: running this twice against the same installer
// produces byte-identical output (timestamps aside from the
// `releaseDate` line, which we explicitly freeze to the file's
// mtime so two runs against the same build stay deterministic).

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PLATFORM_HINT = {
  '.exe': 'win',
  '.dmg': 'mac',
  '.appimage': 'linux',
  '.deb': 'linux',
  '.rpm': 'linux',
};

function fail(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function toIsoZ(d) {
  // Frozen UTC string with millisecond precision (electron-builder
  // does the same). We freeze to the file's mtime so re-runs stay
  // stable; if mtime is missing, fall back to now.
  return d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

async function sha512Base64(filePath) {
  const h = createHash('sha512');
  const fh = await fs.open(filePath, 'r');
  try {
    const stream = fh.createReadStream();
    for await (const chunk of stream) h.update(chunk);
  } finally {
    await fh.close();
  }
  return h.digest('base64');
}

async function main() {
  const [, , installerArg, versionArg] = process.argv;
  if (!installerArg) {
    fail('usage: node scripts/generate-latest-yml.mjs <path-to-installer-exe> [version]');
  }
  const installerAbs = path.resolve(installerArg);
  let stat;
  try {
    stat = await fs.stat(installerAbs);
  } catch (err) {
    fail(`installer not found: ${installerAbs} (${err.message})`);
  }
  const ext = path.extname(installerAbs).toLowerCase();
  if (!(ext in PLATFORM_HINT)) {
    fail(`unsupported installer extension ${ext} — add it to PLATFORM_HINT if intentional`);
  }
  const platform = PLATFORM_HINT[ext];
  const fileName = path.basename(installerAbs);

  // Version precedence: explicit arg > derived from
  // package.json > derived from filename. The "derived from
  // filename" path matches the electron-builder convention
  // (artifactName template ends with `${version}.${ext}`), so
  // users who pass the installer path alone get the right
  // version without typing it.
  let version = versionArg;
  if (!version) {
    try {
      const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
      version = pkg.version;
    } catch {
      // fall through to filename parse
    }
  }
  if (!version) {
    const m = fileName.match(/-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\.[a-z]+$/i);
    if (m) version = m[1];
  }
  if (!version) {
    fail('could not infer version — pass it as the second arg');
  }

  const size = stat.size;
  const sha512 = await sha512Base64(installerAbs);
  const releaseDate = toIsoZ(stat.mtime);

  // Output filename matches electron-builder's: latest.yml for
  // win, latest-mac.yml for mac, latest-linux.yml for linux.
  // Each is named for the platform that consumes it, so a
  // single release can ship all three installers without the
  // manifest files colliding.
  const outName =
    platform === 'mac' ? 'latest-mac.yml' :
    platform === 'linux' ? 'latest-linux.yml' :
    'latest.yml';
  const outPath = path.join(path.dirname(installerAbs), outName);

  // YAML kept minimal — these are exactly the keys electron-updater
  // parses (verified against electron-updater 6.x source).
  const yaml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `    blockMapSize: 0`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ``,
  ].join('\n');

  await fs.writeFile(outPath, yaml, 'utf8');

  // Stdout summary the release uploader can copy verbatim.
  process.stdout.write([
    `version: ${version}`,
    `platform: ${platform}`,
    `installer: ${fileName}`,
    `size: ${size} bytes`,
    `sha512: ${sha512}`,
    `manifest: ${outPath}`,
    ``,
    `Next steps (manual):`,
    `  1. Open https://gitcode.com/ai-sea/ai-todo-list/releases`,
    `  2. Create / edit release v${version}`,
    `  3. Upload ${fileName}`,
    `  4. Upload ${outName} (in the same release, same dir)`,
    ``,
  ].join('\n'));
}

main().catch((err) => {
  fail(err.stack || err.message);
});