// 8ns: platform-wrapped programs (Steam games, Epic games, and friends).
//
// Operator report, live bulk-queue run 2026-08-11: a Steam game came back
// "NEEDS ATTENTION - the uninstaller did not finish on its own", with a Retry
// button next to it. Both were wrong, and wrong in the worst way an app like
// this can be: they told the user to do something that cannot ever work.
//
// A Steam game's registry UninstallString is Steam's own launcher
// ("...\steam.exe" steam://uninstall/570), not a per-app uninstaller. There is
// no vendor silent switch to guess at, so the Rule 15 heuristic (/qn, /S,
// --silent, -quiet) has nothing to find, and retrying the identical command
// produces the identical non-result. Steam requires its own client UI to
// confirm a removal, by design.
//
// So the honest response is not a better guess - it is to stop guessing, name
// the platform, and say the one thing that actually works. Deliberately NOT
// implemented here: launching steam://uninstall/ ourselves. That still needs
// Steam running and still shows Steam's confirmation UI, so it automates
// nothing the user is not already doing, while adding a URI-handler code path
// and the implication that Vanish drove the removal. Per the issue's own
// recommendation, the explanatory version ships first.

'use strict';

// Ordered most-specific first. Each matcher runs against the lowercased
// uninstall string; `exe` is matched as a path component so a program merely
// MENTIONING steam in its name cannot be mistaken for a Steam game.
const PLATFORMS = [
  {
    id: 'steam',
    name: 'Steam',
    patterns: [/[\\/]steam\.exe/i, /steam:\/\/uninstall/i],
    instructions: 'Open Steam, go to your Library, right-click the game and choose Manage, then Uninstall.'
  },
  {
    id: 'epic',
    name: 'Epic Games',
    patterns: [/epicgameslauncher\.exe/i, /com\.epicgames\.launcher:\/\/uninstall/i],
    instructions: 'Open the Epic Games Launcher, go to your Library, click the three dots on the game and choose Uninstall.'
  },
  {
    id: 'gog',
    name: 'GOG Galaxy',
    patterns: [/[\\/]galaxyclient\.exe/i, /goggalaxy:\/\//i],
    instructions: 'Open GOG Galaxy, find the game in your Library, and use Manage installation, then Uninstall.'
  },
  {
    id: 'battlenet',
    name: 'Battle.net',
    patterns: [/battle\.net(\s|\\|\/|\.exe)/i, /[\\/]battle\.net\.exe/i],
    instructions: 'Open the Battle.net app, select the game, then use the gear icon next to Play and choose Uninstall.'
  },
  {
    id: 'ubisoft',
    name: 'Ubisoft Connect',
    patterns: [/upc\.exe/i, /ubisoftconnect:\/\//i, /uplay:\/\//i],
    instructions: 'Open Ubisoft Connect, go to Games, right-click the game and choose Uninstall.'
  },
  {
    id: 'ea',
    name: 'the EA app',
    patterns: [/eadesktop\.exe/i, /origin2?:\/\//i, /[\\/]origin\.exe/i],
    instructions: 'Open the EA app, go to My Collection, click the three dots on the game and choose Uninstall.'
  }
];

// Returns the platform that manages this program's uninstall, or null when the
// program uninstalls itself. Null is the overwhelmingly common case and means
// "carry on with the normal path" - this must never guess a platform, because
// suppressing Retry on a program that could have retried successfully is its
// own kind of wrong answer.
function detectPlatform(uninstallString) {
  if (!uninstallString) return null;
  const s = String(uninstallString);
  if (!s.trim()) return null;
  for (const p of PLATFORMS) {
    if (p.patterns.some((re) => re.test(s))) {
      return { id: p.id, name: p.name, instructions: p.instructions };
    }
  }
  return null;
}

// The line shown in place of "the uninstaller did not finish on its own".
// Names the platform, says why Vanish stopped, and gives the one route that
// works - in that order, because the user's first question is "what went
// wrong" and their second is "so what do I do".
function platformMessage(platform) {
  if (!platform) return null;
  return `${platform.name} manages this program's uninstall - there is no silent uninstaller for Vanish to run. ${platform.instructions}`;
}

// Retry runs the identical command that just failed to complete. Against a
// platform launcher that is not a retry, it is the same doomed request with a
// second button press, so the button is withheld rather than left to disappoint.
function canRetry(uninstallString) {
  return detectPlatform(uninstallString) === null;
}

// Dual-mode on purpose. This is pure string matching over data the renderer
// already holds, so routing it through IPC would add a round trip and a main-
// process code path to answer a question the renderer can answer itself - and
// keeping a second copy of the patterns in renderer.js is exactly the
// duplication that lets two code paths drift into disagreeing about what a
// Steam game is. One file, one set of patterns, one test suite, loaded by both
// as a CommonJS module in the main process and as a classic script in the page.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detectPlatform, platformMessage, canRetry, PLATFORMS };
} else if (typeof window !== 'undefined') {
  window.VanishPlatforms = { detectPlatform, platformMessage, canRetry, PLATFORMS };
}
