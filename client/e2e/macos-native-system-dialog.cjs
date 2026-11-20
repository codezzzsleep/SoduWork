'use strict';

// Shared by native UI execution and the Mac-only syntax preflight. Match the
// observed system prompt before allowing the disposable fixture's connection.
function networkPermissionScript(press) {
  return 'tell application "System Events"\nrepeat with targetProcess in processes\n' +
    'set targetName to name of targetProcess\nif visible of targetProcess or targetName is "UserNotificationCenter" or targetName is "CoreServicesUIAgent" or targetName is "SystemUIServer" then\n' +
    'try\nrepeat with targetWindow in windows of targetProcess\nset uiElements to entire contents of targetWindow\nset wording to ""\n' +
    'repeat with elementItem in uiElements\ntry\nif role of elementItem is "AXStaticText" then set wording to wording & " " & (value of elementItem as text)\nend try\nend repeat\n' +
    'if wording contains "local networks" and (wording contains "Python" or wording contains "SoduWork") then\n' +
    'repeat with elementItem in uiElements\ntry\nif role of elementItem is "AXButton" and name of elementItem is "Allow" then\n' +
    (press ? 'perform action "AXPress" of elementItem\nreturn "allowed isolated test local network access"\n' : 'return "expected local network prompt"\n') +
    'end if\nend try\nend repeat\nend if\nend repeat\nend try\nend if\nend repeat\nreturn ""\nend tell';
}

function deliveryScript({ marker, ready, app, kind, files }) {
  const literal = value => JSON.stringify(String(value));
  const values = files.map(file => `(POSIX file ${literal(file)} as alias)`).join(',');
  // Resolve the complete batch before confirming quit. Alias coercion for
  // twenty-five files must not consume the real production shutdown window.
  const aliases = files.length ? `set targetApplication to (POSIX file ${literal(app)} as alias)\nset nativeFiles to {${values}}\n` : '';
  const finder = files.length ? 'tell application "Finder" to open nativeFiles using targetApplication\n' : '';
  const dock = kind === 'dock' || kind === 'mixed' ? 'tell application "System Events" to perform action "AXPress" of targetItem\n' : '';
  const setup = dock ? 'tell application "System Events" to tell process "Dock" to set targetItem to first UI element of list 1 whose name is "SoduWork"\n' : '';
  return 'use framework "Foundation"\nuse scripting additions\n' + setup + aliases +
    'set fm to current application\'s NSFileManager\'s defaultManager()\n' +
    `do shell script "/usr/bin/touch " & quoted form of ${literal(ready)}\n` +
    `repeat 2000\nif (fm's fileExistsAtPath:${literal(marker)}) as boolean then\n${finder}${dock}return "native requests sent"\nend if\ndelay 0.005\nend repeat\nerror "Confirmed quit marker was not observed"`;
}

module.exports = { networkPermissionScript, deliveryScript };
