'use strict';

// A GIF89a reader, for checking what gif-encode.js produced.
//
// WHY IT EXISTS SEPARATELY. An encoder checked only against itself proves
// nothing: any misreading of the format that both halves share cancels out and
// the file still fails in somebody else's browser. This was WRITTEN FROM THE
// FORMAT, not from the encoder beside it, and that is the whole of its value.
//
// So: if this and the encoder ever disagree, the interesting question is which
// one is wrong. Do not "fix" this file by copying what the encoder does -- that
// converts a real check into a tautology, which is a defect this repository has
// caught in its own tests twice.
//
// It composites as a viewer does, so a decoded frame is the whole picture at
// that moment rather than the sub-rectangle the file stored: disposal method 1
// leaves the canvas alone, and a transparent pixel means "whatever was already
// there".

function lzwDecode(data, minCodeSize, pixelCount) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;

    let dict = [];
    let codeSize = minCodeSize + 1;
    let next = endCode + 1;

    function reset() {
        dict = new Array(clearCode + 2);
        for (let i = 0; i < clearCode; i++) dict[i] = [i];
        codeSize = minCodeSize + 1;
        next = endCode + 1;
    }
    reset();

    const out = new Uint8Array(pixelCount);
    let outPos = 0;
    let bitPos = 0;
    let prev = null;
    const totalBits = data.length * 8;

    while (outPos < pixelCount && bitPos + codeSize <= totalBits) {
        let code = 0;
        for (let i = 0; i < codeSize; i++) {
            code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
            bitPos++;
        }

        if (code === clearCode) { reset(); prev = null; continue; }
        if (code === endCode) break;

        let entry;
        if (dict[code] !== undefined) {
            entry = dict[code];
        } else if (prev !== null) {
            entry = prev.concat([prev[0]]);          // the KwKwK case
        } else {
            throw new Error(`lzwDecode: code ${code} arrived before any dictionary entry`);
        }

        for (let i = 0; i < entry.length && outPos < pixelCount; i++) out[outPos++] = entry[i];

        if (prev !== null && next < 4096) {
            dict[next++] = prev.concat([entry[0]]);
            // The decoder trails the encoder by exactly one code, so it widens
            // on the same condition: `next` no longer fits the current width.
            if (next > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
        }
        prev = entry;
    }

    return out;
}

/**
 * @param {Buffer} buf a complete GIF89a file
 * @param {object} [opts]
 * @param {(i:number)=>boolean} [opts.keep] which composited frames to retain.
 *        Compositing always runs for every frame -- this only decides whether
 *        the result is kept, so a long recording can be checked without holding
 *        every frame in memory at once.
 */
function decodeGif(buf, opts = {}) {
    const keep = opts.keep || (() => true);

    const sig = buf.toString('ascii', 0, 6);
    if (sig !== 'GIF89a') throw new Error(`not a GIF89a file (signature "${sig}")`);

    let p = 6;
    const width = buf.readUInt16LE(p); p += 2;
    const height = buf.readUInt16LE(p); p += 2;
    const packed = buf[p]; p += 1;
    p += 2;                                          // background index, aspect ratio

    const palette = [];
    if (packed & 0x80) {
        const size = 1 << ((packed & 0x07) + 1);
        for (let i = 0; i < size; i++) {
            palette.push({ r: buf[p], g: buf[p + 1], b: buf[p + 2] });
            p += 3;
        }
    }

    function readSubBlocks() {
        const chunks = [];
        for (;;) {
            const len = buf[p]; p += 1;
            if (len === 0) break;
            chunks.push(buf.subarray(p, p + len));
            p += len;
        }
        return Buffer.concat(chunks);
    }

    const frames = [];
    const canvas = new Uint8Array(width * height * 3);
    let gce = null;
    let loopCount = null;
    let blocks = 0;

    for (;;) {
        const marker = buf[p];
        if (marker === undefined) throw new Error('file ended without a trailer');
        if (marker === 0x3B) break;

        if (marker === 0x21) {
            p += 1;
            const label = buf[p]; p += 1;
            if (label === 0xF9) {
                const len = buf[p]; p += 1;
                const flags = buf[p];
                const delay = buf.readUInt16LE(p + 1);
                const transparentIndex = buf[p + 3];
                p += len + 1;
                gce = {
                    disposal: (flags >> 2) & 0x07,
                    hasTransparency: (flags & 0x01) !== 0,
                    delay,
                    transparentIndex
                };
            } else if (label === 0xFF) {
                const len = buf[p]; p += 1;
                const name = buf.toString('ascii', p, p + 11);
                p += len;
                const body = readSubBlocks();
                if (name === 'NETSCAPE2.0' && body.length >= 3) loopCount = body.readUInt16LE(1);
            } else {
                p += 1;
                readSubBlocks();
            }
            continue;
        }

        if (marker !== 0x2C) throw new Error(`unexpected block 0x${marker.toString(16)} at byte ${p}`);

        p += 1;
        const x = buf.readUInt16LE(p); p += 2;
        const y = buf.readUInt16LE(p); p += 2;
        const w = buf.readUInt16LE(p); p += 2;
        const h = buf.readUInt16LE(p); p += 2;
        const imgPacked = buf[p]; p += 1;
        if (imgPacked & 0x80) throw new Error('a local colour table is not expected from this encoder');
        if (imgPacked & 0x40) throw new Error('an interlaced frame is not expected from this encoder');

        const minCodeSize = buf[p]; p += 1;
        const indices = lzwDecode(readSubBlocks(), minCodeSize, w * h);

        for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
                const idx = indices[row * w + col];
                if (gce && gce.hasTransparency && idx === gce.transparentIndex) continue;
                const c = palette[idx] || { r: 0, g: 0, b: 0 };
                const o = ((y + row) * width + (x + col)) * 3;
                canvas[o] = c.r;
                canvas[o + 1] = c.g;
                canvas[o + 2] = c.b;
            }
        }

        const frame = {
            index: blocks, x, y, w, h,
            delay: gce ? gce.delay : 0,
            disposal: gce ? gce.disposal : 0,
            rgb: keep(blocks) ? Uint8Array.prototype.slice.call(canvas) : null
        };
        frames.push(frame);
        blocks++;
    }

    if (blocks === 0) throw new Error('the file contains no image blocks');
    return { width, height, palette, frames, loopCount };
}

module.exports = { decodeGif, lzwDecode };
