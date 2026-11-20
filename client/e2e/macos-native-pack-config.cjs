'use strict';

// A diagnostic DMG with a native observation entry and pnpm's physical layout.
// The public beforePack helper deliberately requires npm's locked path layout;
// its behavior is preserved. This config is never used by public release jobs.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = function create({ repository, output, productionModules }) {
  const client = path.join(repository, 'client');
  const base = require(path.join(client, 'scripts/public-build-config.cjs'));
  const notices = path.join(output, 'runtime-notices');
  return {
    ...base,
    npmRebuild: false,
    files: [...base.files, 'e2e/macos-native-client-worker.cjs', 'e2e/fixtures/full-client-isolation.cjs'],
    extraMetadata: { ...base.extraMetadata, main: 'e2e/macos-native-client-worker.cjs' },
    directories: { ...base.directories, output: path.join(output, 'packages') },
    extraResources: base.extraResources.filter(row => !String(row.from).startsWith('.runtime/pi') && row.from !== '.runtime/compliance')
      .concat([{ from: productionModules, to: 'pi/node_modules', filter: ['**/*'] },
        { from: notices, to: 'third-party/inventory' }]),
    async beforePack(context) {
      const compliance = require(path.join(client, 'scripts/prepare-third-party.cjs'));
      const scope = compliance.distributionReview(repository, true);
      const checked = require(path.join(repository, 'tools/check-third-party.cjs')).check();
      assert.equal(checked.ok, true, checked.errors.join('\n'));
      require(path.join(client, 'scripts/client-build-version.cjs')).prepareVersionFile(context);
      await require(path.join(client, 'scripts/prepare-client-runtime.cjs'))(context);
      const lock = JSON.parse(fs.readFileSync(path.join(client, 'package-lock.json'), 'utf8'));
      const versions = new Set(Object.entries(lock.packages).filter(([name, pkg]) => name && !pkg.dev)
        .map(([name, pkg]) => (pkg.name || name.slice(name.lastIndexOf('node_modules/') + 13)) + '@' + pkg.version));
      const directories = compliance.packages(productionModules);
      const installed = directories.map(directory => {
        const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        assert.ok(versions.has(pkg.name + '@' + pkg.version), 'Unpinned diagnostic runtime dependency: ' + pkg.name + '@' + pkg.version);
        return { name: pkg.name, version: pkg.version };
      });
      assert.ok(installed.some(row => row.name === '@earendil-works/pi-coding-agent' && row.version === '1.4.0'));
      const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'third-party/manifest.json'), 'utf8'));
      compliance.collect(directories, repository, notices, manifest);
      fs.writeFileSync(path.join(notices, 'distribution-review.json'), JSON.stringify(scope, null, 2));
      fs.writeFileSync(path.join(output, 'diagnostic-runtime-versions.json'), JSON.stringify({
        lockfileSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(client, 'package-lock.json'))).digest('hex'),
        layout: 'pnpm hoisted production dependency installation', officialNpmLayoutVerified: false,
        installed,
      }, null, 2));
    },
  };
};
