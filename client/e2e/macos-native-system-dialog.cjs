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

module.exports = { networkPermissionScript };
