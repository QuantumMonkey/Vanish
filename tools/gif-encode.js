'use strict';

// An animated GIF89a encoder with no dependencies.
//
// WHY THIS EXISTS. The demo recording needs a GIF, and this machine has no
// ffmpeg, no ImageMagick and no gifski. The obvious alternative -- `npm i -D`
// something -- costs more than it looks like: docs/RELEASING.md builds releases
// with `npm ci` precisely so that every package is pinned and integrity-checked,
// on the argument that Vanish "runs elevated and deletes files, edits the
// registry and executes third-party binaries", so a substituted dependency
// inherits all of that. Adding a transitive tree to the lockfile for a
// development-only movie is a bad trade. GIF89a is a published format and LZW's
// patent expired in 2004, so this is a few hundred lines instead.
//
// It lives in tools/ and NOT in lib/, because package.json's `files` whitelist
// ships lib/ into the built application. Nothing here belongs in the binary.
//
// WHAT MAKES THE OUTPUT SMALL. A screen recording of this app is mostly a still
// image: a dark panel where one region animates and the other 90% is byte-for-
// byte identical frame to frame. Two things exploit that, and together they are
// the difference between a README asset and an unusable one:
//
//   1. ONE GLOBAL PALETTE, NO DITHERING. Every frame indexes the same 255
//      colours, so an unchanged pixel gets an identical index in consecutive
//      frames. Dithering would win a little colour fidelity and destroy this
//      completely -- error diffusion makes noise, and noise means every pixel
//      differs from the last frame. For flat UI colour it is also the wrong
//      trade on its own terms.
//   2. TRANSPARENT DIFFING plus a DIRTY RECTANGLE. Disposal method 1 leaves the
//      previous frame on the canvas, so unchanged pixels are written as the
//      transparent index and the frame is cropped to the box that actually
//      moved.
//
// A frame that changed nothing at all is not written; its delay is added to the
// frame before it. That matters because a real capture loop produces duplicate
// frames whenever the UI is idle, and writing them would cost bytes to say
// nothing.

const MAX_CODES = 4096;         // 12-bit ceiling, from the format
const HIST_BITS = 5;            // 5 bits per channel -> 32768 histogram buckets
const HIST_SIZE = 1 << (HIST_BITS * 3);

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

// Median cut over a 15-bit histogram rather than over raw pixels.
//
// The reduction to 5 bits per channel decides only which colours get BUCKETED
// together when choosing the palette. Each bucket carries the running sum of
// the real 8-bit pixels that landed in it, so a palette entry is the true
// average of actual pixel values -- not a 5-bit lattice point. Mapping is then
// done against those full-precision entries. This is what keeps a dark UI
// gradient from banding, and it is why the sums are Float64: a full recording
// puts hundreds of millions of pixels through here and a Uint32 sum of the red
// channel alone would wrap.
function newHistogram() {
    return {
        counts: new Uint32Array(HIST_SIZE),
        sumR: new Float64Array(HIST_SIZE),
        sumG: new Float64Array(HIST_SIZE),
        sumB: new Float64Array(HIST_SIZE)
    };
}

function addToHistogram(hist, pixels, pixelOrder) {
    const bOff = pixelOrder === 'bgra' ? 0 : 2;
    const rOff = pixelOrder === 'bgra' ? 2 : 0;
    for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i + rOff];
        const g = pixels[i + 1];
        const b = pixels[i + bOff];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        hist.counts[key]++;
        hist.sumR[key] += r;
        hist.sumG[key] += g;
        hist.sumB[key] += b;
    }
}

function makeBox(entries, lo, hi) {
    let n = 0;
    let rLo = 255, rHi = 0, gLo = 255, gHi = 0, bLo = 255, bHi = 0;
    for (let i = lo; i < hi; i++) {
        const e = entries[i];
        n += e.n;
        if (e.r < rLo) rLo = e.r;
        if (e.r > rHi) rHi = e.r;
        if (e.g < gLo) gLo = e.g;
        if (e.g > gHi) gHi = e.g;
        if (e.b < bLo) bLo = e.b;
        if (e.b > bHi) bHi = e.b;
    }
    return { lo, hi, n, rangeR: rHi - rLo, rangeG: gHi - gLo, rangeB: bHi - bLo };
}

function buildPalette(hist, maxColors) {
    const entries = [];
    for (let i = 0; i < HIST_SIZE; i++) {
        const n = hist.counts[i];
        if (n === 0) continue;
        entries.push({ r: hist.sumR[i] / n, g: hist.sumG[i] / n, b: hist.sumB[i] / n, n });
    }

    if (entries.length === 0) return [{ r: 0, g: 0, b: 0 }];
    if (entries.length <= maxColors) {
        return entries.map((e) => ({
            r: Math.round(e.r), g: Math.round(e.g), b: Math.round(e.b)
        }));
    }

    let boxes = [makeBox(entries, 0, entries.length)];

    while (boxes.length < maxColors) {
        // Split the box that is both populous and wide. Population alone spends
        // the palette on a large flat background; range alone spends it on a
        // handful of stray antialiasing pixels.
        let pick = -1;
        let bestScore = 0;
        for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            if (b.hi - b.lo < 2) continue;
            const span = Math.max(b.rangeR, b.rangeG, b.rangeB);
            if (span === 0) continue;
            const score = b.n * span;
            if (score > bestScore) { bestScore = score; pick = i; }
        }
        if (pick < 0) break;    // nothing left worth splitting

        const box = boxes[pick];
        const key = (box.rangeR >= box.rangeG && box.rangeR >= box.rangeB)
            ? 'r'
            : (box.rangeG >= box.rangeB ? 'g' : 'b');

        const slice = entries.slice(box.lo, box.hi).sort((x, y) => x[key] - y[key]);
        for (let i = 0; i < slice.length; i++) entries[box.lo + i] = slice[i];

        // Split at the population median, not the range midpoint: the midpoint
        // happily puts 99% of the pixels on one side and calls it a split.
        const half = box.n / 2;
        let acc = 0;
        let split = box.lo + 1;
        for (let i = box.lo; i < box.hi - 1; i++) {
            acc += entries[i].n;
            split = i + 1;
            if (acc >= half) break;
        }

        boxes.splice(pick, 1, makeBox(entries, box.lo, split), makeBox(entries, split, box.hi));
    }

    return boxes.map((b) => {
        let n = 0, r = 0, g = 0, bl = 0;
        for (let i = b.lo; i < b.hi; i++) {
            const e = entries[i];
            n += e.n;
            r += e.r * e.n;
            g += e.g * e.n;
            bl += e.b * e.n;
        }
        if (n === 0) return { r: 0, g: 0, b: 0 };
        return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(bl / n) };
    });
}

// Nearest palette entry, memoised on the exact 24-bit colour.
//
// The cache is the whole performance story. A full recording is hundreds of
// millions of pixels but only tens of thousands of DISTINCT colours, because it
// is a UI and not a photograph, so the linear scan runs a few tens of thousands
// of times rather than a few hundred million.
function makeMapper(palette) {
    const cache = new Map();
    const n = palette.length;
    const pr = new Int32Array(n);
    const pg = new Int32Array(n);
    const pb = new Int32Array(n);
    for (let i = 0; i < n; i++) { pr[i] = palette[i].r; pg[i] = palette[i].g; pb[i] = palette[i].b; }

    return function nearest(r, g, b) {
        const key = (r << 16) | (g << 8) | b;
        const hit = cache.get(key);
        if (hit !== undefined) return hit;

        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < n; i++) {
            const dr = r - pr[i];
            const dg = g - pg[i];
            const db = b - pb[i];
            // Luma weighting: the eye resolves green detail far better than
            // blue, and an unweighted distance visibly mangles the blue accent
            // colour this app uses for every interactive element.
            const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
            if (d < bestDist) { bestDist = d; best = i; }
        }
        cache.set(key, best);
        return best;
    };
}

// ---------------------------------------------------------------------------
// LZW
// ---------------------------------------------------------------------------

// Variable-width LZW as GIF specifies it. The order of operations below is not
// a matter of taste: the decoder reconstructs the dictionary one code BEHIND
// the encoder, so a code is emitted at the current width and the width is
// bumped afterwards. Doing it the intuitive way round produces a file that most
// decoders read as corrupt a few hundred codes in, which is the sort of bug
// that only shows up at the bottom of a large frame.
function lzwEncode(indices, minCodeSize) {
    const out = [];
    let accum = 0;
    let accumBits = 0;

    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;

    let codeSize = minCodeSize + 1;
    let maxCode = (1 << codeSize) - 1;
    let next = endCode + 1;
    let clearPending = false;
    let dict = new Map();

    function emitBits(code, bits) {
        accum |= code << accumBits;
        accumBits += bits;
        while (accumBits >= 8) {
            out.push(accum & 0xFF);
            accum >>= 8;
            accumBits -= 8;
        }
    }

    function output(code) {
        emitBits(code, codeSize);
        if (next > maxCode || clearPending) {
            if (clearPending) {
                codeSize = minCodeSize + 1;
                maxCode = (1 << codeSize) - 1;
                clearPending = false;
            } else {
                codeSize++;
                // At 12 bits the ceiling is set above every reachable code so
                // this branch stops firing rather than running off the end.
                maxCode = codeSize === 12 ? MAX_CODES : (1 << codeSize) - 1;
            }
        }
    }

    output(clearCode);

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const c = indices[i];
        const key = (prefix << 8) | c;
        const known = dict.get(key);
        if (known !== undefined) {
            prefix = known;
            continue;
        }
        output(prefix);
        prefix = c;
        if (next < MAX_CODES) {
            dict.set(key, next++);
        } else {
            dict = new Map();
            next = endCode + 1;
            clearPending = true;
            output(clearCode);     // emitted at the OLD width, then reset
        }
    }

    output(prefix);
    output(endCode);
    while (accumBits > 0) {
        out.push(accum & 0xFF);
        accum >>= 8;
        accumBits -= 8;
    }

    return Buffer.from(out);
}

function subBlock(data) {
    const parts = [];
    for (let i = 0; i < data.length; i += 255) {
        const chunk = data.subarray(i, Math.min(i + 255, data.length));
        parts.push(Buffer.from([chunk.length]), chunk);
    }
    parts.push(Buffer.from([0x00]));
    return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

function u16(value) {
    return Buffer.from([value & 0xFF, (value >> 8) & 0xFF]);
}

/**
 * @param {object} opts
 * @param {number} opts.width           frame width in pixels
 * @param {number} opts.height          frame height in pixels
 * @param {number} opts.frameCount      how many frames readFrame will serve
 * @param {(i:number)=>Buffer} opts.readFrame  raw pixels for frame i
 * @param {number[]} opts.delaysMs      display time per frame, milliseconds
 * @param {string} [opts.pixelOrder]    'bgra' (Electron on Windows) or 'rgba'
 * @param {number} [opts.maxColors]     palette size, 2..255
 * @param {number} [opts.loop]          0 = forever
 * @param {(msg:string)=>void} [opts.onProgress]
 */
function encodeGif(opts) {
    const {
        width, height, frameCount, readFrame, delaysMs,
        pixelOrder = 'bgra', maxColors = 255, loop = 0, onProgress = () => {}
    } = opts;

    if (frameCount < 1) throw new Error('encodeGif: nothing to encode');
    if (maxColors < 2 || maxColors > 255) {
        // 255 and not 256: one index is reserved for transparency, which is
        // what the whole inter-frame diff is built on.
        throw new Error('encodeGif: maxColors must be 2..255 (index 255 is reserved for transparency)');
    }

    // Pass 1 -- the palette. Every frame is read, because a colour that appears
    // only in the last two seconds still has to be representable.
    const hist = newHistogram();
    for (let i = 0; i < frameCount; i++) {
        addToHistogram(hist, readFrame(i), pixelOrder);
        if (i % 25 === 0) onProgress(`palette pass ${i + 1}/${frameCount}`);
    }

    const palette = buildPalette(hist, maxColors);
    const transparentIndex = palette.length;
    onProgress(`palette: ${palette.length} colours, transparent index ${transparentIndex}`);

    const nearest = makeMapper(palette);

    // A GIF colour table is a power of two, and it has to be big enough to hold
    // the transparent index as well as the colours.
    let tableBits = 1;
    while ((1 << tableBits) < palette.length + 1) tableBits++;
    const tableSize = 1 << tableBits;

    // Pass 2 -- index, diff, crop, compress.
    const canvas = new Int16Array(width * height).fill(-1);
    const indices = new Uint8Array(width * height);
    const records = [];

    const bOff = pixelOrder === 'bgra' ? 0 : 2;
    const rOff = pixelOrder === 'bgra' ? 2 : 0;

    for (let f = 0; f < frameCount; f++) {
        const pixels = readFrame(f);
        let minX = width, minY = height, maxX = -1, maxY = -1;

        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                const p = row + x;
                const o = p * 4;
                const idx = nearest(pixels[o + rOff], pixels[o + 1], pixels[o + bOff]);
                if (canvas[p] === idx) {
                    indices[p] = transparentIndex;
                } else {
                    indices[p] = idx;
                    canvas[p] = idx;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        const delay = Math.max(2, Math.round(delaysMs[f] / 10));

        if (maxX < 0) {
            // Nothing moved. Give the time to the previous frame instead of
            // spending bytes to redraw an identical picture. With no previous
            // frame there is nothing to extend, so the first frame is always
            // written even if it is blank.
            if (records.length > 0) {
                records[records.length - 1].delay += delay;
                continue;
            }
            minX = 0; minY = 0; maxX = 0; maxY = 0;
        }

        const w = maxX - minX + 1;
        const h = maxY - minY + 1;

        const sub = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            const src = (minY + y) * width + minX;
            sub.set(indices.subarray(src, src + w), y * w);
        }

        records.push({
            x: minX, y: minY, w, h, delay,
            // minCodeSize has a floor of 2 in the format even when the image
            // uses fewer colours than that.
            data: lzwEncode(sub, Math.max(2, tableBits))
        });

        if (f % 25 === 0) onProgress(`encode pass ${f + 1}/${frameCount}`);
    }

    // Assemble.
    const parts = [];
    parts.push(Buffer.from('GIF89a', 'ascii'));

    parts.push(u16(width), u16(height));
    // Global colour table present, 8-bit colour resolution, not sorted.
    parts.push(Buffer.from([0x80 | 0x70 | (tableBits - 1), 0x00, 0x00]));

    const table = Buffer.alloc(tableSize * 3);
    for (let i = 0; i < palette.length; i++) {
        table[i * 3] = palette[i].r;
        table[i * 3 + 1] = palette[i].g;
        table[i * 3 + 2] = palette[i].b;
    }
    parts.push(table);

    // NETSCAPE2.0, the de facto looping extension.
    parts.push(Buffer.from([0x21, 0xFF, 0x0B]));
    parts.push(Buffer.from('NETSCAPE2.0', 'ascii'));
    parts.push(Buffer.from([0x03, 0x01]), u16(loop), Buffer.from([0x00]));

    for (const rec of records) {
        // Disposal 1 (leave in place) is what makes a transparent pixel mean
        // "same as before" rather than "hole".
        parts.push(Buffer.from([0x21, 0xF9, 0x04, (1 << 2) | 0x01]));
        parts.push(u16(Math.min(rec.delay, 0xFFFF)));
        parts.push(Buffer.from([transparentIndex, 0x00]));

        parts.push(Buffer.from([0x2C]));
        parts.push(u16(rec.x), u16(rec.y), u16(rec.w), u16(rec.h));
        parts.push(Buffer.from([0x00]));                  // no local table
        parts.push(Buffer.from([Math.max(2, tableBits)]));
        parts.push(subBlock(rec.data));
    }

    parts.push(Buffer.from([0x3B]));

    return { buffer: Buffer.concat(parts), frames: records.length, colors: palette.length };
}

module.exports = { encodeGif, buildPalette, lzwEncode, newHistogram, addToHistogram };
