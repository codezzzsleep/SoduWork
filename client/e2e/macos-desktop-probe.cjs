'use strict';

// Target-environment discovery only. No native reopen or model acceptance is
// claimed by this probe; it never emits application events or changes TCC.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const output = path.resolve(process.argv[2] || 'macos-desktop-probe.json');
const report = {
  scope: 'macOS desktop environment and automation prerequisites only',
  acceptanceComplete: false,
  realModelExecuted: false,
  recordedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  source: process.env.GITHUB_SHA || '',
  checks: {},
};

function command(name, executable, args, timeout = 20000) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const entry = {
    ok: result.status === 0,
    exitCode: result.status,
    signal: result.signal,
    stdout: String(result.stdout || '').trim().slice(-3000),
    stderr: String(result.stderr || '').trim().slice(-3000),
    ...(result.error ? { error: result.error.message } : {}),
  };
  report.checks[name] = entry;
  return entry;
}

if (process.platform === 'darwin') {
  command('macOS', 'sw_vers', ['-productVersion']);
  command('hardware', 'sysctl', ['-n', 'hw.model']);
  command('finderAppleEvents', 'osascript', ['-e',
    'tell application "Finder" to get version']);
  command('accessibilityEnabled', 'osascript', ['-e',
    'tell application "System Events" to get UI elements enabled']);
  command('dockAccessibility', 'osascript', ['-e',
    'tell application "System Events" to tell process "Dock" to get count of UI elements']);
  command('display', 'swift', ['-e',
    'import CoreGraphics; import Foundation; let id = CGMainDisplayID(); ' +
    'let value: [String: Any] = ["id": id, "width": CGDisplayPixelsWide(id), ' +
    '"height": CGDisplayPixelsHigh(id), "active": CGDisplayIsActive(id) != 0]; ' +
    'let data = try JSONSerialization.data(withJSONObject: value); ' +
    'print(String(data: data, encoding: .utf8)!)'], 60000);
  report.nativeMacObserved = report.checks.macOS.ok;
} else {
  report.nativeMacObserved = false;
  report.untriggered = 'This probe requires actual macOS.';
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log('MACOS_DESKTOP_PROBE_JSON=' + JSON.stringify(report));
process.exitCode = report.nativeMacObserved ? 0 : 2;
