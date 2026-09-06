'use strict';

// tools/gif-encode.js, attacked rather than eyeballed.
//
//   npx electron test/gif-encode-verify.js
//
// Runs in either tier. Encoding a GIF is not privileged.
//
// WHY A SUITE FOR A DEVELOPMENT TOOL. Because "the GIF looked fine to me" is
// not evidence, and because a GIF that renders in one decoder and not another
// is the normal failure mode for a hand-written encoder -- the file goes in a
// README, so the decoder that matters is somebody else's browser, not mine.
//
// The assertions come in three kinds, and the third is the one that would
// actually have caught a real bug:
//
//   1. ROUND TRIP THROUGH AN INDEPENDENT DECODER. tools/gif-decode.js is
//      written from the format, not from the encoder, and reconstructs frames by
//      compositing exactly as a viewer does: disposal method 1, transparency
//      meaning "keep what was already there". When the source has fewer
//      distinct colours than the palette, the comparison is EXACT -- there is
//      no lossy step left to hide behind, so the test demands pixel equality
//      rather than a similarity score.
//
//   2. THE SIZE CLAIMS ARE MEASURED. The diffing and the dirty rectangle are
//      the reason the encoder exists in this shape. Claims like "an unchanged
//      frame costs nothing" are asserted against the emitted structure, not
//      described in a comment.
//
//   3. THE LZW DICTIONARY IS DRIVEN PAST 4096 CODES. The variable code width
//      and the mid-stream dictionary reset are the only genuinely subtle part
//      of the format, and both are invisible on a small image: a 64x48 test
//      frame never reaches the 12-bit ceiling, so a wrong reset would pass
//      every other assertion here and then corrupt the bottom half of the real
//      recording. The noise frame exists to reach that path on purpose.
//
// Finally the file is handed to Chromium, which is a decoder nobody in this
// repository wrote.

process.env.VANISH_DISABLE_AUTO_ELEVATE = '1';
process.env.VANISH_HEADLESS_HARNESS = '1';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeGif } = require(path.join(__dirname, '..', 'tools', 'gif-encode.js'));

app.disableHardwareAcceleration();

let pass = 0;
let fail = 0;

function assert(cond, label, detail) {
    if (cond) {
        pass++;
        console.log(`  PASS  ${label}`);
    } else {
        fail++;
        console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
    }
}

// ---------------------------------------------------------------------------
// An independent GIF89a reader
// ---------------------------------------------------------------------------

// tools/gif-decode.js, which was written from the format specification and not
// from the encoder it checks. That independence is the point: an encoder
// checked only against itself proves nothing, because any misreading the two
// halves share cancels out and the file still fails in somebody else's
// browser. See the header of that file before changing either side.
//
// It also composites frames the way a viewer does, so a decoded frame is the
// whole picture at that moment rather than the sub-rectangle the file stored --
// which is what lets the assertions below compare against the source frames
// directly.
const { decodeGif } = require(path.join(__dirname, '..', 'tools', 'gif-decode.js'));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// BGRA, because that is what Electron's nativeImage.toBitmap() hands back on
// Windows and therefore what the encoder is fed in real use.
function blankFrame(w, h, colour) {
    const buf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        buf[i * 4] = colour.b;
        buf[i * 4 + 1] = colour.g;
        buf[i * 4 + 2] = colour.r;
        buf[i * 4 + 3] = 255;
    }
    return buf;
}

function fillRect(buf, w, x0, y0, rw, rh, colour) {
    for (let y = y0; y < y0 + rh; y++) {
        for (let x = x0; x < x0 + rw; x++) {
            const o = (y * w + x) * 4;
            buf[o] = colour.b;
            buf[o + 1] = colour.g;
            buf[o + 2] = colour.r;
            buf[o + 3] = 255;
        }
    }
}

function rgbAt(frame, width, x, y) {
    const o = (y * width + x) * 3;
    return { r: frame.rgb[o], g: frame.rgb[o + 1], b: frame.rgb[o + 2] };
}

function sameColour(a, b) {
    return a.r === b.r && a.g === b.g && a.b === b.b;
}

app.whenReady().then(async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanish-gif-'));

    console.log('');
    console.log('GIF encoder (tools/gif-encode.js)');
    console.log('=================================');
    console.log('');

    // -----------------------------------------------------------------------
    console.log('Round trip, few enough colours that it must be EXACT');
    // -----------------------------------------------------------------------

    const W = 64;
    const H = 48;
    const BG = { r: 11, g: 15, b: 25 };            // the app's own background
    const FG = { r: 240, g: 246, b: 252 };
    const ACCENT = { r: 56, g: 139, b: 253 };

    const exact = [];
    for (let i = 0; i < 8; i++) {
        const f = blankFrame(W, H, BG);
        fillRect(f, W, 2, 2, 20, 6, FG);           // static strip
        fillRect(f, W, 4 + i * 5, 20, 8, 8, ACCENT); // something that moves
        exact.push(f);
    }

    const exactDelays = exact.map(() => 100);
    const enc = encodeGif({
        width: W, height: H, frameCount: exact.length,
        readFrame: (i) => exact[i],
        delaysMs: exactDelays,
        pixelOrder: 'bgra'
    });

    const dec = decodeGif(enc.buffer);

    assert(dec.width === W && dec.height === H,
        'the logical screen is the size it was asked for',
        `${dec.width}x${dec.height}`);
    assert(dec.frames.length === exact.length,
        'every distinct frame survives the round trip',
        `${dec.frames.length} of ${exact.length}`);
    assert(dec.loopCount === 0,
        'the NETSCAPE2.0 block asks for an endless loop');
    assert(dec.frames.every((f) => f.disposal === 1),
        'every frame keeps the canvas, which is what makes a transparent pixel mean "unchanged"');

    // Only three colours went in, so quantisation has nothing to lose. Anything
    // short of pixel equality here is a defect, not a rounding artefact.
    let mismatches = 0;
    let firstMismatch = null;
    for (let i = 0; i < exact.length; i++) {
        const got = dec.frames[i];
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const o = (y * W + x) * 4;
                const want = { r: exact[i][o + 2], g: exact[i][o + 1], b: exact[i][o] };
                if (!sameColour(want, rgbAt(got, W, x, y))) {
                    mismatches++;
                    if (!firstMismatch) firstMismatch = `frame ${i} at ${x},${y}`;
                }
            }
        }
    }
    assert(mismatches === 0,
        'every pixel of every frame decodes back to exactly what went in',
        `${mismatches} wrong, first at ${firstMismatch}`);

    assert(dec.palette.length >= 4,
        'the colour table has room for the three colours and the transparent index',
        `${dec.palette.length}`);

    // -----------------------------------------------------------------------
    console.log('');
    console.log('The size claims, measured against the emitted structure');
    // -----------------------------------------------------------------------

    // Frame 0 must be whole; after that only the moving square may be redrawn.
    assert(dec.frames[0].w === W && dec.frames[0].h === H,
        'the first frame is written in full, because there is nothing underneath it');

    const later = dec.frames.slice(1);
    assert(later.every((f) => f.w < W && f.h < H),
        'later frames are cropped to what moved rather than redrawn whole',
        JSON.stringify(later.map((f) => `${f.w}x${f.h}`)));

    // The square is 8x8 and steps 5px, so the dirty box is 13 wide, 8 tall.
    assert(later.every((f) => f.w === 13 && f.h === 8),
        'the dirty rectangle is exactly the union of the old and new square',
        JSON.stringify(later.map((f) => `${f.w}x${f.h}`)));

    // A repeated frame is time, not pixels.
    const withStill = [exact[0], exact[1], exact[1], exact[1], exact[2]];
    const stillEnc = encodeGif({
        width: W, height: H, frameCount: withStill.length,
        readFrame: (i) => withStill[i],
        delaysMs: [100, 100, 100, 100, 100],
        pixelOrder: 'bgra'
    });
    const stillDec = decodeGif(stillEnc.buffer);

    assert(stillDec.frames.length === 3,
        'two identical repeats of a frame emit no image blocks at all',
        `${stillDec.frames.length} blocks from 5 captures`);
    assert(stillDec.frames.reduce((a, f) => a + f.delay, 0) === 50,
        'and their time is handed to the frame they repeat, so the movie still runs 500ms',
        `${stillDec.frames.reduce((a, f) => a + f.delay, 0)} centiseconds`);
    assert(stillDec.frames[1].delay === 30,
        'specifically, the repeated frame holds for the whole 300ms it was on screen',
        `${stillDec.frames[1].delay} centiseconds`);

    // -----------------------------------------------------------------------
    console.log('');
    console.log('Many colours: median cut, and the 12-bit LZW ceiling');
    // -----------------------------------------------------------------------

    // A deterministic pseudo-random image. Two things at once: far more than
    // 255 distinct colours, so the palette has to be chosen rather than copied;
    // and incompressible enough at 256x256 that the dictionary fills and the
    // encoder has to emit a mid-stream clear code.
    const NW = 256;
    const NH = 256;
    let seed = 20260906;
    const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
        return (seed >> 16) & 0xFF;
    };
    const noise = Buffer.alloc(NW * NH * 4);
    for (let i = 0; i < NW * NH; i++) {
        noise[i * 4] = rnd();
        noise[i * 4 + 1] = rnd();
        noise[i * 4 + 2] = rnd();
        noise[i * 4 + 3] = 255;
    }

    const noiseEnc = encodeGif({
        width: NW, height: NH, frameCount: 1,
        readFrame: () => noise,
        delaysMs: [100],
        pixelOrder: 'bgra'
    });
    const noiseDec = decodeGif(noiseEnc.buffer);

    assert(noiseDec.frames.length === 1 &&
           noiseDec.frames[0].w === NW && noiseDec.frames[0].h === NH,
        'a full-size noise frame decodes at full size after the dictionary resets',
        `${noiseDec.frames[0].w}x${noiseDec.frames[0].h}`);

    // 65536 pixels of noise cannot round trip exactly through 255 colours, and
    // asserting that it does would be asserting a false thing. What must hold
    // is that the error is quantisation-shaped -- small and unbiased -- rather
    // than the smeared garbage a mis-sized code produces.
    let worst = 0;
    let total = 0;
    for (let i = 0; i < NW * NH; i++) {
        const want = { r: noise[i * 4 + 2], g: noise[i * 4 + 1], b: noise[i * 4] };
        const o = i * 3;
        const d = Math.abs(want.r - noiseDec.frames[0].rgb[o])
            + Math.abs(want.g - noiseDec.frames[0].rgb[o + 1])
            + Math.abs(want.b - noiseDec.frames[0].rgb[o + 2]);
        total += d;
        if (d > worst) worst = d;
    }
    const mean = total / (NW * NH);
    assert(mean < 40,
        'uniform noise survives a 255-colour palette with quantisation-sized error',
        `mean channel-sum error ${mean.toFixed(1)} of 765`);
    assert(worst < 200,
        'and no pixel is wildly wrong, which is what a desynchronised code width looks like',
        `worst ${worst} of 765`);

    // The point of the noise frame: prove the reset path was actually taken,
    // rather than trusting that 65536 random pixels probably filled the
    // dictionary. If this fails the assertions above stop covering the reset.
    let clears = 0;
    {
        // Re-derive the code stream and count clear codes at their emitted widths.
        const b = noiseEnc.buffer;
        let q = 13 + noiseDec.palette.length * 3;
        while (b[q] === 0x21) {                       // skip extensions
            q += 2;
            if (b[q - 1] === 0xF9) { q += b[q] + 2; }
            else { q += b[q] + 1; while (b[q] !== 0) q += b[q] + 1; q += 1; }
        }
        q += 1 + 8 + 1;                               // image descriptor
        const minCodeSize = b[q]; q += 1;
        const chunks = [];
        for (;;) {
            const len = b[q]; q += 1;
            if (len === 0) break;
            chunks.push(b.subarray(q, q + len));
            q += len;
        }
        const data = Buffer.concat(chunks);
        const clearCode = 1 << minCodeSize;
        let codeSize = minCodeSize + 1;
        let nxt = clearCode + 2;
        let bit = 0;
        const bits = data.length * 8;
        while (bit + codeSize <= bits) {
            let code = 0;
            for (let i = 0; i < codeSize; i++) {
                code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
                bit++;
            }
            if (code === clearCode) {
                clears++;
                codeSize = minCodeSize + 1;
                nxt = clearCode + 2;
                continue;
            }
            if (code === clearCode + 1) break;
            nxt++;
            if (nxt > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
        }
    }
    assert(clears >= 2,
        'the dictionary really did fill and reset mid-stream, so the reset path is under test',
        `${clears} clear codes (1 is just the mandatory opening one)`);

    // -----------------------------------------------------------------------
    console.log('');
    console.log('A decoder nobody here wrote');
    // -----------------------------------------------------------------------

    // Chromium is the decoder that matters, because the file goes in a README.
    // A long first delay so the animation cannot advance before it is sampled.
    //
    // The image is handed over as a data: URI and NOT as a file:// URL. The
    // first version of this used file://, Chromium fired onerror, and it read
    // exactly like a malformed GIF -- it was not. A document with an opaque
    // origin cannot load a file:// subresource, so the file was refused before
    // the decoder ever saw it. A data: URI has no origin to fail, and it does
    // not taint the canvas, so getImageData still works.
    const chromeEnc = encodeGif({
        width: W, height: H, frameCount: 3,
        readFrame: (i) => exact[i],
        delaysMs: [5000, 5000, 5000],
        pixelOrder: 'bgra'
    });
    const gifPath = path.join(outDir, 'probe.gif');
    fs.writeFileSync(gifPath, chromeEnc.buffer);

    const win = new BrowserWindow({
        width: 320, height: 240, show: false,
        webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
    });
    await win.loadURL('data:text/html,<body style="margin:0">');

    const shot = await win.webContents.executeJavaScript(`(() => new Promise((resolve) => {
        const img = new Image();
        img.onerror = () => resolve({ ok: false, why: 'Chromium refused the file' });
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext('2d');
            g.drawImage(img, 0, 0);
            const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data).slice(0, 3);
            resolve({
                ok: true,
                w: img.naturalWidth,
                h: img.naturalHeight,
                background: px(60, 44),
                strip: px(10, 4),
                square: px(8, 24)
            });
        };
        img.src = ${JSON.stringify('data:image/gif;base64,' + chromeEnc.buffer.toString('base64'))};
    }))()`);

    assert(shot.ok, 'Chromium decodes the file at all', shot.why);
    if (shot.ok) {
        assert(shot.w === W && shot.h === H,
            'Chromium agrees about the dimensions', `${shot.w}x${shot.h}`);
        assert(sameColour({ r: shot.background[0], g: shot.background[1], b: shot.background[2] }, BG),
            'and about the background colour', JSON.stringify(shot.background));
        assert(sameColour({ r: shot.strip[0], g: shot.strip[1], b: shot.strip[2] }, FG),
            'and about the static strip', JSON.stringify(shot.strip));
        assert(sameColour({ r: shot.square[0], g: shot.square[1], b: shot.square[2] }, ACCENT),
            'and about the moving square in frame 0', JSON.stringify(shot.square));
    }

    // -----------------------------------------------------------------------
    console.log('');
    console.log('Refusals');
    // -----------------------------------------------------------------------

    let refused = false;
    try {
        encodeGif({ width: 1, height: 1, frameCount: 0, readFrame: () => Buffer.alloc(4), delaysMs: [] });
    } catch (e) { refused = true; }
    assert(refused, 'encoding nothing is an error rather than a zero-frame file');

    refused = false;
    try {
        encodeGif({
            width: W, height: H, frameCount: 1, readFrame: () => exact[0],
            delaysMs: [100], maxColors: 256
        });
    } catch (e) { refused = true; }
    assert(refused,
        'a 256-colour palette is refused by name, because index 255 is the transparent one');

    fs.rmSync(outDir, { recursive: true, force: true });
    win.destroy();

    console.log('');
    console.log(`Result: ${pass} passed, ${fail} failed`);
    app.exit(fail === 0 ? 0 : 1);
}).catch((err) => {
    console.log(`  FAIL  the suite threw -- ${err && err.stack ? err.stack : err}`);
    console.log('');
    console.log('Result: 0 passed, 1 failed');
    app.exit(1);
});
