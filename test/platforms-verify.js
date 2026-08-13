// 8ns Verify: platform-wrapped program detection (lib/platforms.js).
//
//   node test/platforms-verify.js

const platforms = require('../lib/platforms');

let pass = 0;
let fail = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    fail += 1;
  }
}

console.log('');
console.log('Platform-wrapped uninstalls (8ns)');
console.log('=================================');

// --- the case the operator actually hit -----------------------------------
{
  // Verbatim shape of a Steam game's UninstallString.
  const s = '"C:\\Program Files (x86)\\Steam\\steam.exe" steam://uninstall/1966720';
  const p = platforms.detectPlatform(s);
  assert(p !== null && p.id === 'steam', 'a Steam game is recognised from its UninstallString');
  assert(platforms.canRetry(s) === false, 'and Retry is withheld - it would re-run the identical doomed command');

  const msg = platforms.platformMessage(p);
  assert(/Steam manages/.test(msg), 'the message names the platform rather than blaming the uninstaller');
  assert(
    /no silent uninstaller for Vanish to run/.test(msg),
    'and says why Vanish stopped, instead of implying it failed at something it could have done'
  );
  assert(/Library/.test(msg) && /Uninstall/.test(msg), 'and gives the route that actually works');
}

// --- the other launchers --------------------------------------------------
{
  const cases = [
    ['epic', '"C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe" com.epicgames.launcher://uninstall/foo'],
    ['gog', '"C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe" /command=uninstall'],
    ['ubisoft', '"C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\Upc.exe" uninstall 123'],
    ['ea', '"C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe" -uninstall'],
    ['battlenet', '"C:\\Program Files (x86)\\Battle.net\\Battle.net.exe" --uninstall']
  ];
  for (const [id, str] of cases) {
    const p = platforms.detectPlatform(str);
    assert(p !== null && p.id === id, `${id} is recognised`);
    assert(
      p && /Uninstall/i.test(p.instructions),
      `${id}'s instructions tell the user where the working route is`
    );
  }
}

// --- what must NOT be detected --------------------------------------------
{
  // Suppressing Retry on a program that could have retried successfully is its
  // own kind of wrong answer, so detection must be conservative.
  const ordinary = [
    '"C:\\Program Files\\7-Zip\\Uninstall.exe"',
    'MsiExec.exe /X{23170F69-40C1-2702-2602-000001000000}',
    '"C:\\Program Files\\Steamy Software\\uninst.exe"',
    'C:\\Windows\\system32\\OpenWith.exe'
  ];
  for (const s of ordinary) {
    assert(platforms.detectPlatform(s) === null, `not a platform launcher: ${s.slice(0, 46)}`);
    assert(platforms.canRetry(s) === true, 'and Retry stays available for it');
  }

  assert(
    platforms.detectPlatform('"C:\\Games\\SteamlessTool\\unins000.exe"') === null,
    'a program whose NAME merely contains "steam" is not treated as a Steam game - the exe is matched as a path component'
  );
}

// --- degenerate input -----------------------------------------------------
{
  assert(platforms.detectPlatform(null) === null, 'a missing uninstall string detects nothing');
  assert(platforms.detectPlatform('') === null, 'an empty one detects nothing');
  assert(platforms.detectPlatform('   ') === null, 'and neither does whitespace');
  assert(platforms.canRetry(null) === true, 'an unknown uninstall string keeps the normal Retry path');
  assert(platforms.platformMessage(null) === null, 'and produces no message to show');
}

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
