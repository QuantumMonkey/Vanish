'use strict';

// Records the README demo: the real app, the real engine, this real machine.
//
//   npx electron test/sandbox/demo-record.js [outGif] [--quick]
//
// Not a test. It asserts nothing and is not in run-all.ps1. It is the tool that
// produces docs/media/vanish-demo.gif, kept in the repository so the recording
// can be remade when the UI changes instead of being a one-off nobody can
// reproduce.
//
// ---------------------------------------------------------------------------
// WHAT IS REAL HERE, AND WHAT IS NOT
// ---------------------------------------------------------------------------
//
// REAL: every pixel. The engine runs against the actual disk and the actual
// registry, the program list is what is actually installed, and the findings
// are this machine's findings. Nothing is injected or mocked. This follows
// screenshot-probe.js, whose reasoning applies verbatim -- a mockup presented
// as evidence of working software is the exact thing this repository refuses to
// do to its users.
//
// NOT REAL, and both are stated in the README beside the image:
//
//   1. THE TWO SCANS ARE A TIME-LAPSE. Over those stretches a frame is sampled
//      periodically -- less and less often the longer the scan runs -- and each
//      sample is held for a fixed 80ms, so minutes of scanning become a few
//      seconds of movie. Every frame shown is a frame that was captured; none
//      is interpolated or invented, they are simply taken further apart. The
//      caption carries a TIME-LAPSE marker for the whole stretch and the real
//      factor is printed in the transcript at the end of the run.
//   2. THE CAPTIONS ARE AN OVERLAY. They are injected into the page by this
//      script and are not part of the application. They are deliberately styled
//      as an annotation -- a floating pill, monospace, marked "demo" -- so they
//      cannot be mistaken for app chrome.
//
// ---------------------------------------------------------------------------
// WHAT IT WILL NOT DO
// ---------------------------------------------------------------------------
//
// NOTHING DESTRUCTIVE RUNS. docs/PRE-RELEASE.md describes the demo as "scan,
// pick a program, walk the wizard, review the leftovers, purge". The last two
// beats of that would uninstall a real program from the operator's real machine
// and move real files into the vault, and a recording is not a reason to do
// that unattended. The wizard is opened and shown on its configure screen --
// which is only UI setup, see openUninstallWizard in renderer/wizard.js -- and
// then closed. Every scan below is read-only:
//
//   * Machine Hygiene says so on the panel itself: "Everything here reads only
//     -- no finding on this screen can be removed by Vanish."
//   * System Clean's scan is btn-scan-all-cleaners. The destructive control
//     beside it is btn-clean-all-cleaners, marked data-destructive, and it is
//     never touched.
//
// ---------------------------------------------------------------------------
// TEST HATCHES ARE ON, AND THAT CHANGES NO DATA
// ---------------------------------------------------------------------------
//
// VANISH_ALLOW_TEST_HATCHES has to be set because main.js gates BOTH
// VANISH_HEADLESS_HARNESS and VANISH_DISABLE_AUTO_ELEVATE behind it, and
// without them main.js opens its own window and tries to relaunch elevated.
// The only other thing the flag unlocks is sizeHatch(), which reads
// VANISH_SIZE_BUDGET_MS and VANISH_SIZE_MAX_FILES. Neither is set here, so both
// fall back to their shipping defaults and every number on screen is measured.
//
// ---------------------------------------------------------------------------
// WHY PNG FRAMES ON DISK
// ---------------------------------------------------------------------------
//
// A raw 960x600 BGRA frame is 2.3MB and a run captures hundreds, which is a
// gigabyte-plus of scratch for a movie. PNG is lossless, costs about a
// twentieth of that, and Electron will decode it straight back to the bitmap
// the encoder wants via nativeImage.createFromPath().toBitmap(). The encode
// therefore runs in this process rather than a separate node one.

process.env.VANISH_ALLOW_TEST_HATCHES = '1';
process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();

const root = path.join(__dirname, '..', '..');
const { encodeGif } = require(path.join(root, 'tools', 'gif-encode.js'));
const main = require(path.join(root, 'main.js'));

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const QUICK = process.argv.includes('--quick');
const OUT_GIF = args[0] || path.join(root, 'docs', 'media', 'vanish-demo.gif');

// A realistic laptop window. Small enough that the GIF is legible at README
// width, large enough that the layout is the one a person actually gets --
// the summary row measured differently at 800x600 and that is not the app most
// people will see.
const WIN_W = 1280;
const WIN_H = 800;
const OUT_W = 960;
const OUT_H = 600;

const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-demo-'));

function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

app.whenReady().then(async () => {
    // BEFORE the window exists, and this is not a formality.
    //
    // main.js resolves the tier by shelling out to check-admin, and exports
    // this promise so "a harness that require()s this file can wait for
    // bootstrap - tier resolution in particular - instead of guessing with a
    // sleep". Loading the page first LOSES THE RACE: the renderer reads the
    // tier once at startup, caches it in isAdmin, and gets 'audit' because the
    // PowerShell call has not come back yet. The first recording made that
    // mistake and the symptom was not a missing badge -- it was an elevated
    // machine filming itself in Audit Mode, and a modal offering to restart as
    // administrator that then dimmed the app for the rest of the take.
    await main.bootstrapped;

    const win = new BrowserWindow({
        width: WIN_W,
        height: WIN_H,
        show: false,
        frame: false,
        backgroundColor: '#0b0f19',
        webPreferences: {
            preload: path.join(root, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Load-bearing. capturePage() on a hidden window returns a STALE
            // frame without it, because compositing is paused -- the recording
            // would be of a page that already moved on.
            offscreen: true
        }
    });

    const run = (js) => win.webContents.executeJavaScript(js);

    // -----------------------------------------------------------------------
    // Recorder
    // -----------------------------------------------------------------------

    const delays = [];
    let frameCount = 0;
    let recording = false;
    let intervalMs = 100;
    let speed = 1;
    let pending = null;
    let loopDone = null;
    let dropped = 0;
    let redactionLeaks = 0;

    let fixedDelay = null;

    async function grab() {
        const img = await win.webContents.capturePage();
        const small = img.resize({ width: OUT_W, height: OUT_H, quality: 'best' });
        const size = small.getSize();
        if (size.width !== OUT_W || size.height !== OUT_H) {
            // Refuse rather than encode a jagged movie: a frame of a different
            // size would be read as OUT_W x OUT_H and shear.
            throw new Error(`frame is ${size.width}x${size.height}, expected ${OUT_W}x${OUT_H}`);
        }
        const file = path.join(frameDir, `${String(frameCount).padStart(5, '0')}.png`);
        fs.writeFileSync(file, small.toPNG());

        const now = Date.now();
        if (pending) {
            delays.push(pending.fixed !== null
                ? pending.fixed
                : Math.max(20, Math.round((now - pending.at) / pending.speed)));
        }
        pending = { at: now, speed, fixed: fixedDelay };
        frameCount++;
    }

    function startRecording() {
        recording = true;
        loopDone = (async () => {
            while (recording) {
                const t0 = Date.now();
                try {
                    await grab();
                } catch (e) {
                    dropped++;
                    if (dropped < 4) console.log(`  (dropped a frame: ${e.message})`);
                }
                const spent = Date.now() - t0;
                if (spent < intervalMs) await wait(intervalMs - spent);
            }
        })();
    }

    async function stopRecording(finalHoldMs) {
        recording = false;
        await loopDone;
        // Every frame needs a delay, including the last one, which nothing
        // follows to measure against.
        if (frameCount > 0) delays.push(finalHoldMs);
    }

    // Two ways to record, and the difference matters to the viewer.
    //
    // realtime() plays back at the speed it happened: the delay written for a
    // frame is the time that actually elapsed before the next one.
    //
    // timelapse() samples slowly and plays every sample for the same short
    // moment. A scan that takes three minutes becomes a few seconds, and --
    // this is the point -- the length of the result does not depend on how slow
    // the machine was. Deriving the delay from wall clock instead (elapsed
    // divided by a speed factor) makes the movie longer on a slower disk, which
    // is exactly backwards: the slower the scan, the more it needs compressing.
    //
    // Every frame is still a captured frame. Nothing is interpolated or
    // invented; frames are simply taken further apart, and the caption says
    // TIME-LAPSE for the whole stretch.
    function realtime(everyMs) {
        intervalMs = everyMs;
        speed = 1;
        fixedDelay = null;
    }

    function timelapse(sampleEveryMs, holdEachMs) {
        intervalMs = sampleEveryMs;
        speed = 1;
        fixedDelay = holdEachMs;
    }

    // Wraps a time-lapsed stretch so the compression factor is MEASURED and
    // reported, rather than being a number written into a caption by hand. The
    // README quotes what this prints.
    // The sampling interval BACKS OFF as the segment runs long, which is the
    // only way to be right about a duration nobody can predict. The first
    // version sampled every 2.5s on the assumption that a sweep takes minutes;
    // on this machine both scans finished in about twenty seconds, so the
    // "time-lapse" was eight frames and 0.6 seconds -- a blink where a beat
    // should have been. Sampling fast enough for a 20-second scan would instead
    // have produced a 25-second segment on a slow disk.
    //
    // Backing off doubles the interval every 40 samples, so a fast scan is
    // shown smoothly and a slow one stays bounded: 20s gives about 3s of movie,
    // 3 minutes gives about 10s, and neither needs to be guessed in advance.
    const lapses = [];
    async function lapse(label, sampleMs, holdMs, body) {
        const startFrames = frameCount;
        const startedAt = Date.now();
        timelapse(sampleMs, holdMs);
        const backoff = setInterval(() => {
            const taken = frameCount - startFrames;
            intervalMs = sampleMs * Math.pow(2, Math.floor(taken / 40));
        }, 500);
        try {
            await body();
        } finally {
            clearInterval(backoff);
            realtime(100);
        }
        const wall = Date.now() - startedAt;
        const play = (frameCount - startFrames) * holdMs;
        lapses.push({ label, wall, play, factor: play > 0 ? wall / play : 0 });
    }

    // -----------------------------------------------------------------------
    // Redaction
    // -----------------------------------------------------------------------

    // The findings are real, and real findings on a real machine are full of
    // C:\Users\<name>. This recording goes in the README of a PUBLIC repository,
    // and a Windows account name and local paths do not belong in a binary asset
    // that is awkward to retract once it is cloned. Promptgate Rule 18 already
    // forbids local filesystem paths in doc files; a GIF is a doc file that
    // happens not to be greppable.
    //
    // An earlier version of this comment called the repository pseudonymous and
    // made that the reason. It was an inference nobody had stated; the operator's
    // records describe the account as a handle. The redaction never needed it.
    //
    // What this does and does not do: it replaces an IDENTIFIER with a
    // placeholder. It does not touch a finding, a count, a size or a verdict.
    // Nothing on screen becomes untrue -- a path becomes less specific, and the
    // README says so beside the image.
    //
    // A MutationObserver rather than a sweep before each capture. The callback
    // runs as a microtask after the mutation and before the next paint, so the
    // compositor never sees the unredacted string; a 10fps sweep would let it
    // through on any frame that landed between a render and the next tick.
    async function installRedaction(pairs) {
        return run(`(() => {
            const rules = ${JSON.stringify(pairs)}.map(p => [new RegExp(p[0], 'gi'), p[1]]);
            const ATTRS = ['title', 'placeholder', 'aria-label', 'value'];

            function scrub(node) {
                if (!node) return;
                if (node.nodeType === 3) {
                    const before = node.nodeValue;
                    let after = before;
                    for (const [rx, to] of rules) after = after.replace(rx, to);
                    // Only write on a real change: writing the same value back
                    // would re-enter the observer forever.
                    if (after !== before) node.nodeValue = after;
                    return;
                }
                if (node.nodeType !== 1) return;
                if (node.id === 'demo-caption') return;
                for (const a of ATTRS) {
                    if (!node.hasAttribute(a)) continue;
                    const before = node.getAttribute(a);
                    let after = before;
                    for (const [rx, to] of rules) after = after.replace(rx, to);
                    if (after !== before) node.setAttribute(a, after);
                }
                for (let c = node.firstChild; c; c = c.nextSibling) scrub(c);
            }

            scrub(document.body);
            new MutationObserver((muts) => {
                for (const m of muts) {
                    if (m.type === 'characterData') scrub(m.target);
                    else m.addedNodes.forEach(scrub);
                }
            }).observe(document.body, { childList: true, subtree: true, characterData: true });

            // Reported back so the run can prove the redaction was installed
            // rather than assume it.
            window.__demoRedactionRules = rules.length;
            return rules.length;
        })()`);
    }

    // Counts anything the redaction should have caught and did not. Cheap, and
    // it turns "I looked at a few frames and they seemed fine" into a number.
    async function auditRedaction(pairs) {
        return run(`(() => {
            const rules = ${JSON.stringify(pairs)}.map(p => new RegExp(p[0], 'gi'));
            const text = document.body.innerText || '';
            let hits = 0;
            for (const rx of rules) { const m = text.match(rx); if (m) hits += m.length; }
            return hits;
        })()`).catch(() => -1);
    }

    // -----------------------------------------------------------------------
    // Captions
    // -----------------------------------------------------------------------

    async function installCaption() {
        await run(`(() => {
            const style = document.createElement('style');
            style.textContent = \`
              #demo-caption {
                position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
                z-index: 99999; display: flex; align-items: center; gap: 10px;
                max-width: 86%; padding: 9px 16px;
                background: rgba(6,9,16,0.93); border: 1px solid rgba(120,150,200,0.45);
                border-radius: 999px;
                font-family: Consolas, "Cascadia Mono", monospace; font-size: 13px;
                color: #e8eefc; letter-spacing: 0.1px;
                box-shadow: 0 6px 24px rgba(0,0,0,0.55);
                opacity: 0; transition: opacity 180ms ease;
              }
              #demo-caption.on { opacity: 1; }
              #demo-caption .tag {
                font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
                color: #0b0f19; background: #7aa2f7; border-radius: 3px;
                padding: 2px 6px; font-weight: 700; flex: none;
              }
              #demo-caption .fast {
                font-size: 11px; color: #f7c97a; border: 1px solid rgba(247,201,122,0.5);
                border-radius: 3px; padding: 1px 6px; flex: none;
              }
            \`;
            document.head.appendChild(style);
            const el = document.createElement('div');
            el.id = 'demo-caption';
            el.innerHTML = '<span class="tag">demo</span><span id="demo-caption-text"></span>';
            document.body.appendChild(el);
            return true;
        })()`);
    }

    // fastLabel is shown whenever the clock is being compressed, so a viewer is
    // never watching a sped-up scan without being told.
    async function caption(text, fastLabel) {
        await run(`(() => {
            const el = document.getElementById('demo-caption');
            if (!el) return false;
            const t = document.getElementById('demo-caption-text');
            t.textContent = ${JSON.stringify(text || '')};
            let f = el.querySelector('.fast');
            if (${JSON.stringify(fastLabel || '')}) {
                if (!f) { f = document.createElement('span'); f.className = 'fast'; el.appendChild(f); }
                f.textContent = ${JSON.stringify(fastLabel || '')};
            } else if (f) {
                f.remove();
            }
            el.classList.toggle('on', !!${JSON.stringify(text || '')});
            return true;
        })()`);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    async function until(expr, timeoutMs, label) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            let done = false;
            try { done = await run(expr); } catch (e) { /* page busy, try again */ }
            if (done) return true;
            await wait(400);
        }
        console.log(`  (timed out waiting for ${label} after ${Math.round(timeoutMs / 1000)}s -- carrying on)`);
        return false;
    }

    // Whatever is actually scrollable and on screen right now.
    //
    // Deliberately NOT a per-panel selector. switchTab in renderer/core.js
    // identifies the All Programs area by EXCLUDING every panel that has an id,
    // because that one area has none -- so there is no #all-apps-panel to name,
    // and a hard-coded list here would be a second copy of a list that already
    // warns in a comment about being kept complete.
    // Found by asking which visible element actually scrolls, rather than by
    // naming one. The first version guessed at '.panel-scroll' and matched
    // nothing on the Health Advisor, so the pan set scrollTop on no element at
    // all and reported success -- the beat filmed a motionless page under a
    // caption promising to show what was below it. Nothing threw. A scroll that
    // silently scrolls nothing is worth guarding against by construction.
    //
    // Resolved once per pan and stashed on window, because getComputedStyle
    // over the whole document is too slow to run every 60ms frame.
    async function resolveScroller() {
        return run(`(() => {
            let best = null, bestOver = 8;
            for (const e of document.querySelectorAll('div, main, section')) {
                if (!e.offsetParent) continue;
                const over = e.scrollHeight - e.clientHeight;
                if (over <= bestOver) continue;
                const oy = getComputedStyle(e).overflowY;
                if (oy !== 'auto' && oy !== 'scroll') continue;
                bestOver = over; best = e;
            }
            window.__demoScroller = best;
            return best ? { over: best.scrollHeight - best.clientHeight, at: best.scrollTop } : null;
        })()`).catch(() => null);
    }

    // Scroll in a few discrete steps with a dwell at each, NOT smoothly.
    //
    // This is the single biggest lever on the size of the finished file, and it
    // is worth being explicit about why. The encoder pays for CHANGED pixels: a
    // frame identical to the one before it costs nothing at all, and a frame
    // where the whole panel moved costs tens of kilobytes. A smooth pan changes
    // every pixel of the content area on every captured frame, so two seconds
    // of smooth scrolling is twenty full-panel redraws. The same two seconds as
    // five steps with a dwell is five redraws and fifteen free frames.
    //
    // Measured on this scenario: smooth pans put the GIF at 10.1MB, the same
    // scenario with stepped pans at less than half that. A README asset that
    // nobody waits for is worth more than a buttery scroll nobody notices.
    async function pan(toY, overMs, steps = 5) {
        const found = await resolveScroller();
        if (!found) {
            console.log(`         (nothing on this panel scrolls; skipping the pan to ${toY})`);
            return 0;
        }
        const target = Math.min(toY, found.over);
        const start = found.at;
        const dwell = Math.max(120, Math.round(overMs / steps));
        for (let i = 1; i <= steps; i++) {
            const y = Math.round(start + (target - start) * (i / steps));
            await run(`(() => { const el = window.__demoScroller; if (el) el.scrollTop = ${y}; return true; })()`).catch(() => {});
            await wait(dwell);
        }
        const landed = await run('(() => window.__demoScroller ? window.__demoScroller.scrollTop : 0)()').catch(() => 0);
        if (target > 0 && landed < 1) console.log(`         (pan to ${target} did not move; scroller reported ${found.over}px of overflow)`);
        return landed;
    }

    // A modal left open by a refused beat does not just lose that beat -- it
    // dims the whole app behind an overlay for every beat after it, and the
    // recording is unusable rather than merely short. So every beat ends by
    // clearing anything still on top, whether it succeeded or not.
    async function clearOverlays() {
        return run(`(() => {
            const closed = [];
            // Test the OVERLAY's .active class, not the button's offsetParent.
            // These overlays are hidden with opacity/visibility rather than
            // display:none, so offsetParent is truthy on a modal nobody can
            // see -- the first version of this clicked "Continue in Audit Mode"
            // once per beat on a closed dialog and reported it as a rescue.
            const elev = document.getElementById('elevation-modal-overlay');
            if (elev && elev.classList.contains('active')) {
                const stay = document.getElementById('btn-stay-audit');
                if (stay) stay.click(); else elev.classList.remove('active');
                closed.push('elevation-offer');
            }
            const wiz = document.getElementById('wizard-modal-overlay');
            if (wiz && wiz.classList.contains('active')) {
                if (typeof closeUninstallWizard === 'function') closeUninstallWizard();
                else wiz.classList.remove('active');
                closed.push('wizard');
            }
            document.querySelectorAll('.modal-overlay.active, .small-modal-overlay.active')
                .forEach(m => { m.classList.remove('active'); closed.push(m.id || 'modal'); });
            return closed;
        })()`).catch(() => []);
    }

    const beats = [];
    async function beat(name, fn) {
        const t0 = Date.now();
        try {
            await fn();
            beats.push({ name, ms: Date.now() - t0, ok: true });
            console.log(`  [ok]   ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        } catch (e) {
            beats.push({ name, ms: Date.now() - t0, ok: false, why: e.message });
            console.log(`  [skip] ${name} -- ${e.message}`);
        }
        const cleared = await clearOverlays();
        if (cleared.length) console.log(`         (cleared ${cleared.join(', ')})`);
        if (REDACT) {
            const leaked = await auditRedaction(redactions);
            if (leaked > 0) {
                redactionLeaks += leaked;
                console.log(`         LEAK: ${leaked} unredacted occurrence(s) still on screen after this beat`);
            }
        }
    }

    // -----------------------------------------------------------------------

    console.log('');
    console.log('Vanish demo recording');
    console.log('=====================');
    console.log(`  frames -> ${frameDir}`);
    console.log(`  gif    -> ${OUT_GIF}`);
    console.log(`  mode   -> ${QUICK ? 'quick (pipeline check)' : 'full'}`);
    console.log('');

    await win.loadFile(path.join(root, 'index.html'));
    await wait(300);
    await installCaption();

    const REDACT = !process.argv.includes('--no-redact');
    const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const redactions = [
        [`\\b${rx(os.userInfo().username)}\\b`, 'you'],
        [`\\b${rx(os.hostname())}\\b`, 'this-pc']
    ];
    if (REDACT) {
        const n = await installRedaction(redactions);
        console.log(`  redact -> ${n} rules (account name, host name)`);
    } else {
        console.log('  redact -> OFF (--no-redact): this recording will show the account name');
    }

    // Say which tier this is being filmed in, out loud. A recording made in the
    // wrong tier still produces a plausible-looking GIF -- it just quietly
    // leaves out every destructive control and shows an Audit Mode banner
    // nobody asked for. That is exactly the class of failure this repository
    // keeps finding: a well-shaped result standing in for a wrong one.
    const tier = await run(`(() => ({
        isAdmin: typeof isAdmin === 'undefined' ? null : isAdmin,
        tier: typeof tierState === 'undefined' ? null : tierState.tier
    }))()`);
    console.log(`  tier   -> ${tier.tier} (isAdmin ${tier.isAdmin})`);
    if (tier.tier !== 'full') {
        console.log('  NOTE: not Full Mode. The wizard beat will be refused by guardFullMode.');
    }
    console.log('');

    realtime(100);
    startRecording();

    // 1 -----------------------------------------------------------------
    await beat('Health Advisor, from cold', async () => {
        await caption('Vanish opens on the Health Advisor');
        await wait(1800);
        await caption('Each section says what it is doing before it has an answer');
        await wait(2400);
        await until('document.querySelectorAll("#audit-panel .audit-badge").length > 0', 20000, 'the advisor to answer');
        await caption('What this machine is, where the disk went, what starts with Windows');
        await wait(2000);
    });

    // 2 -----------------------------------------------------------------
    await beat('Advisor, scrolled', async () => {
        await pan(900, QUICK ? 900 : 2600);
        await caption('What holds a network connection, what listens, what is installed twice');
        await wait(1800);
        await pan(0, 600);
    });

    // 3 -----------------------------------------------------------------
    await beat('All Programs', async () => {
        await caption('Every installed program -- desktop and Microsoft Store');
        await run('(() => { document.querySelector(\'.nav-item[data-tab="all-apps"]\').click(); return true; })()');
        await wait(2000);
        await pan(400, 1500);
        await wait(500);
    });

    // 4 -----------------------------------------------------------------
    // Opened and closed. Nothing is uninstalled -- see the header.
    await beat('The uninstall wizard, opened on its plan', async () => {
        await caption('Pick one, and the wizard opens on a plan -- not an action');
        const opened = await run(`(() => {
            const rows = Array.from(document.querySelectorAll('.app-row'));
            // Skip the entries most likely to be refused as protected, so the
            // recording shows the wizard rather than a guard modal.
            const risky = /microsoft|windows|driver|redistributable|runtime|update|security|defender/i;
            const row = rows.find(r => !risky.test(r.textContent)) || rows[0];
            if (!row) return 'no rows';
            row.click();
            return 'selected';
        })()`);
        if (opened !== 'selected') throw new Error(String(opened));
        await wait(1200);
        const shown = await run(`(() => {
            const b = document.getElementById('btn-start-uninstall');
            if (!b) return false;
            b.click();
            return document.getElementById('wizard-modal-overlay').classList.contains('active');
        })()`);
        if (!shown) throw new Error('a guard refused the wizard for this entry');
        await wait(1600);
        await caption('It names the restore point, the scan depth, and what it will do');
        await wait(2400);
        await run('(() => { closeUninstallWizard(); return true; })()');
        await wait(700);
    });

    // 5 -----------------------------------------------------------------
    await beat('System Clean', async () => {
        await caption('System Clean sweeps for what uninstallers leave behind');
        await run('(() => { document.querySelector(\'.nav-item[data-tab="system-clean"]\').click(); return true; })()');
        await wait(1600);
        await run('(() => { document.getElementById("btn-scan-all-cleaners").click(); return true; })()');
        await wait(1800);

        await lapse('System Clean sweep', QUICK ? 400 : 500, 80, async () => {
            await caption('Every section, against the real disk', 'TIME-LAPSE');
            await until(
                'Array.from(document.querySelectorAll(".toast")).some(t => /has been scanned/i.test(t.textContent))',
                QUICK ? 25000 : 150000,
                'the sweep to finish'
            );
        });

        // NOT "a section that could not be read says so". That distinction is
        // the headline fix of 1.0 and it would be the best caption available --
        // but every section on this machine was readable, so the frame under it
        // is a column of zeros and the words would be describing something the
        // viewer cannot see. Producing a denied key to film would be staging
        // the evidence. The caption says what is actually on screen; the README
        // explains the distinction in text, where it can be explained.
        await caption('Read-only: it counts what each section found and removes nothing');
        await wait(2200);
        await pan(420, 1600);
        await wait(1200);
    });

    // 6 -----------------------------------------------------------------
    await beat('Machine Hygiene: what a delete would cost', async () => {
        await caption('Machine Hygiene answers what a disk-usage tool cannot');
        await run('(() => { document.querySelector(\'.nav-item[data-tab="hygiene"]\').click(); return true; })()');
        await wait(1800);
        await caption('Not how big a folder is -- what deleting it would cost you');
        await wait(1800);
        await run(`(() => {
            document.getElementById('hygiene-module-select').value = 'rescue';
            document.getElementById('btn-hygiene-scan').click();
            return true;
        })()`);
        await wait(1800);

        await lapse('Rescue checks', QUICK ? 400 : 500, 80, async () => {
            await caption('Walking the profile: unpushed branches, stashes, keystores', 'TIME-LAPSE');
            await until(
                'typeof hygieneScanning !== "undefined" && hygieneScanning === false && hygieneDecision !== null',
                QUICK ? 30000 : 300000,
                'the rescue checks to finish'
            );
        });

        await caption('Findings ranked by what they would cost to rebuild');
        await wait(2000);
        await pan(560, 2000);
        await caption('Each one carries its evidence, and none of it can be deleted here');
        await wait(2200);
    });

    // 7 -----------------------------------------------------------------
    await beat('Quarantine', async () => {
        await caption('Everything Vanish removes goes to a vault');
        await run('(() => { document.querySelector(\'.nav-item[data-tab="quarantine"]\').click(); return true; })()');
        await wait(2000);
        await caption('Each entry records what moved, from where -- and that it went back');
        await wait(2200);
        await caption('');
        await wait(700);
    });

    await stopRecording(1600);

    console.log('');
    console.log(`  captured ${frameCount} frames, ${dropped} dropped`);
    console.log(`  redaction leaks: ${REDACT ? redactionLeaks : 'n/a (--no-redact)'}`);
    const realMs = beats.reduce((a, b) => a + b.ms, 0);
    const playMs = delays.reduce((a, d) => a + d, 0);
    console.log(`  wall clock ${(realMs / 1000).toFixed(1)}s -> playback ${(playMs / 1000).toFixed(1)}s`);
    for (const l of lapses) {
        console.log(`  time-lapse: ${l.label} -- ${(l.wall / 1000).toFixed(0)}s of scanning shown in ` +
            `${(l.play / 1000).toFixed(1)}s (x${l.factor.toFixed(0)})`);
    }

    win.destroy();

    if (frameCount === 0) {
        console.log('  nothing captured; not writing a GIF');
        app.exit(1);
        return;
    }

    // -----------------------------------------------------------------------
    // Encode
    // -----------------------------------------------------------------------

    console.log('');
    console.log('  encoding...');

    const files = fs.readdirSync(frameDir).filter((f) => f.endsWith('.png')).sort();
    const readFrame = (i) => {
        const bmp = nativeImage.createFromPath(path.join(frameDir, files[i])).toBitmap();
        if (bmp.length !== OUT_W * OUT_H * 4) {
            throw new Error(`frame ${files[i]} decoded to ${bmp.length} bytes, expected ${OUT_W * OUT_H * 4}`);
        }
        return bmp;
    };

    let lastNote = '';
    const result = encodeGif({
        width: OUT_W,
        height: OUT_H,
        frameCount: files.length,
        readFrame,
        delaysMs: delays,
        pixelOrder: 'bgra',
        maxColors: 255,
        onProgress: (msg) => {
            if (msg !== lastNote) { console.log(`    ${msg}`); lastNote = msg; }
        }
    });

    // Read it back before writing it anywhere.
    //
    // The suite in test/gif-encode-verify.js proves the encoder on fixtures of
    // eight and one frames. THIS is five hundred frames, hundreds of dirty
    // rectangles deep, with the LZW dictionary filling and resetting throughout
    // -- and a diff-and-composite chain fails LATE by construction: one wrong
    // frame corrupts every frame after it, and the first two hundred still look
    // perfect. So the last frame is the one worth checking. If it reconstructs,
    // every transparency and every dirty rectangle before it composited
    // correctly, because that is the only way to arrive at it.
    let selfCheck = 'not run';
    try {
        const { decodeGif } = require(path.join(root, 'tools', 'gif-decode.js'));
        const last = result.frames - 1;
        const back = decodeGif(result.buffer, { keep: (i) => i === last });

        if (back.width !== OUT_W || back.height !== OUT_H) {
            throw new Error(`decoded ${back.width}x${back.height}`);
        }
        if (back.frames.length !== result.frames) {
            throw new Error(`decoded ${back.frames.length} frames, wrote ${result.frames}`);
        }

        const want = readFrame(files.length - 1);
        const got = back.frames[last].rgb;
        let total = 0;
        for (let i = 0; i < OUT_W * OUT_H; i++) {
            total += Math.abs(want[i * 4 + 2] - got[i * 3])
                + Math.abs(want[i * 4 + 1] - got[i * 3 + 1])
                + Math.abs(want[i * 4] - got[i * 3 + 2]);
        }
        const mean = total / (OUT_W * OUT_H);
        // Quantisation to 255 colours costs a little. Anything past a few units
        // per pixel is not rounding, it is a desynchronised stream.
        if (mean > 12) throw new Error(`final frame differs by ${mean.toFixed(1)} (of 765) per pixel`);
        selfCheck = `ok -- ${back.frames.length} frames, final frame within ${mean.toFixed(2)}/765 per pixel`;
    } catch (e) {
        selfCheck = `FAILED -- ${e.message}`;
    }

    if (selfCheck.startsWith('FAILED')) {
        console.log('');
        console.log(`  self-check ${selfCheck}`);
        console.log('  NOT writing the GIF. The frames are kept below; fix the encoder and re-encode.');
        console.log(`  frames at ${frameDir}`);
        app.exit(1);
        return;
    }

    fs.mkdirSync(path.dirname(OUT_GIF), { recursive: true });
    fs.writeFileSync(OUT_GIF, result.buffer);

    const mb = (result.buffer.length / (1024 * 1024)).toFixed(2);
    console.log(`  self-check ${selfCheck}`);
    console.log('');
    console.log(`  ${OUT_GIF}`);
    console.log(`  ${mb} MB, ${result.frames} image blocks from ${files.length} captures, ${result.colors} colours`);
    console.log('');
    console.log('  beats:');
    for (const b of beats) console.log(`    ${b.ok ? 'ok  ' : 'SKIP'} ${b.name}${b.ok ? '' : ` -- ${b.why}`}`);
    console.log('');
    console.log(`  frames kept at ${frameDir}`);
    console.log('');

    app.exit(0);
}).catch((err) => {
    console.log(`  the recorder threw -- ${err && err.stack ? err.stack : err}`);
    app.exit(1);
});
