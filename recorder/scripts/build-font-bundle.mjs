#!/usr/bin/env node

/**
 * Build a compact browser font bundle from one or more original PCF files.
 *
 * Usage:
 *   node recorder/scripts/build-font-bundle.mjs \
 *     --body recorder/fonts/wenquanyi_13px.pcf \
 *     --decor recorder/fonts/wenquanyi_9pt.pcf \
 *     --out recorder/fonts/wenquanyi-bitmap-song.wqbm
 *
 * The body font keeps every encoded glyph. The decorative font is subset to
 * the characters used by this UI, or to --decor-chars when supplied.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const DEFAULT_DECOR_CHARS = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  ..." .·:—-−/<>◀▶",
  ..."()[]",
].join("");

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parsePcf(buffer) {
  if (!buffer.byteOffset || buffer.byteOffset === 0) {
    buffer = buffer.buffer;
  } else {
    buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x70636601) fail("Invalid PCF header");
  const count = view.getUint32(4, true);
  const tables = new Map();
  for (let i = 0; i < count; i += 1) {
    const offset = 8 + i * 16;
    tables.set(view.getUint32(offset, true), {
      format: view.getUint32(offset + 4, true),
      size: view.getUint32(offset + 8, true),
      offset: view.getUint32(offset + 12, true),
    });
  }
  const table = type => tables.get(type);
  const endian = format => (format & 4) === 0 ? "little" : "big";
  const readU16 = (offset, little) => view.getUint16(offset, little);
  const readI16 = (offset, little) => view.getInt16(offset, little);
  const readU32 = (offset, little) => view.getUint32(offset, little);

  const metricsTable = table(4);
  const metricsLittle = endian(metricsTable.format) === "little";
  let p = metricsTable.offset + 4;
  const compressed = (metricsTable.format & 0x100) !== 0;
  const metricCount = compressed ? readU16(p, metricsLittle) : readU32(p, metricsLittle);
  p += compressed ? 2 : 4;
  const metrics = [];
  for (let i = 0; i < metricCount; i += 1) {
    if (compressed) {
      metrics.push({
        left: bytes[p++] - 128, right: bytes[p++] - 128,
        advance: bytes[p++] - 128, ascent: bytes[p++] - 128,
        descent: bytes[p++] - 128,
      });
    } else {
      metrics.push({
        left: readI16(p, metricsLittle), right: readI16(p + 2, metricsLittle),
        advance: readI16(p + 4, metricsLittle), ascent: readI16(p + 6, metricsLittle),
        descent: readI16(p + 8, metricsLittle),
      });
      p += 12;
    }
  }

  const bitmapTable = table(8);
  const bitmapLittle = endian(bitmapTable.format) === "little";
  p = bitmapTable.offset + 4;
  const bitmapCount = readU32(p, bitmapLittle);
  p += 4;
  const offsets = Array.from({ length: bitmapCount }, () => {
    const value = readU32(p, bitmapLittle);
    p += 4;
    return value;
  });
  const sizes = Array.from({ length: 4 }, () => {
    const value = readU32(p, bitmapLittle);
    p += 4;
    return value;
  });
  const bitmapDataOffset = p;
  const padBytes = 1 << (bitmapTable.format & 3);
  const msbFirst = (bitmapTable.format & 8) !== 0;

  const encodingTable = table(32);
  const encodingLittle = endian(encodingTable.format) === "little";
  p = encodingTable.offset + 4;
  const minByte2 = readU16(p, encodingLittle);
  const maxByte2 = readU16(p + 2, encodingLittle);
  const minByte1 = readU16(p + 4, encodingLittle);
  const maxByte1 = readU16(p + 6, encodingLittle);
  const defaultChar = readU16(p + 8, encodingLittle);
  p += 10;
  const columns = maxByte2 - minByte2 + 1;
  const rows = maxByte1 - minByte1 + 1;
  const codepoints = [];
  for (let byte1 = minByte1; byte1 <= maxByte1; byte1 += 1) {
    for (let byte2 = minByte2; byte2 <= maxByte2; byte2 += 1) {
      const glyphIndex = readU16(p, encodingLittle);
      p += 2;
      if (glyphIndex !== 0xffff) codepoints.push({
        codePoint: (byte1 << 8) | byte2,
        glyphIndex,
      });
    }
  }
  const defaultGlyphIndex = codepoints.find(item => item.codePoint === defaultChar)?.glyphIndex ?? 0;

  return {
    bytes, metrics, offsets, bitmapDataOffset, padBytes, msbFirst,
    codepoints, defaultGlyphIndex,
  };
}

function glyphBytes(font, glyphIndex, metric) {
  const width = Math.max(0, metric.right - metric.left);
  const height = Math.max(0, metric.ascent + metric.descent);
  // PCF pads each scanline to a byte width of 1, 2, 4, or 8 bytes. It is
  // not equivalent to rounding the bit count to bytes and then multiplying
  // by the pad size.
  const stride = Math.ceil(width / (font.padBytes * 8)) * font.padBytes;
  const length = stride * height;
  const start = font.bitmapDataOffset + font.offsets[glyphIndex];
  return font.bytes.slice(start, start + length);
}

function makeSubset(source, chars, keepAll) {
  const requested = keepAll
    ? source.codepoints
    : [...new Set([...chars].map(character => character.codePointAt(0)))]
      .map(codePoint => source.codepoints.find(item => item.codePoint === codePoint))
      .filter(Boolean);
  const used = [...new Set([
    source.defaultGlyphIndex,
    ...requested.map(item => item.glyphIndex),
  ])];
  const remap = new Map(used.map((glyphIndex, index) => [glyphIndex, index]));
  const glyphs = used.map(glyphIndex => {
    const metric = source.metrics[glyphIndex];
    const data = glyphBytes(source, glyphIndex, metric);
    return {
      metric,
      width: Math.max(0, metric.right - metric.left),
      height: Math.max(0, metric.ascent + metric.descent),
      stride: Math.ceil(
        Math.max(0, metric.right - metric.left) / (source.padBytes * 8),
      ) * source.padBytes,
      data,
    };
  });
  return {
    // Preserve the source font's global scale reference. Computing this from
    // only the retained decorative glyphs made the subset report 12px instead
    // of the original font's 16px maximum, so the runtime rounded its LCD
    // scale from 2× up to 3× and every decorative label became oversized.
    nativeHeight: Math.max(
      1,
      ...source.metrics.map(metric => metric.ascent + metric.descent),
    ),
    padBytes: source.padBytes,
    msbFirst: source.msbFirst,
    defaultGlyph: remap.get(source.defaultGlyphIndex) ?? 0,
    codepoints: requested.map(item => [item.codePoint, remap.get(item.glyphIndex)]),
    glyphs,
  };
}

function writeBundle(fonts) {
  const chunks = [];
  const header = Buffer.alloc(12);
  header.write("WQBM", 0, "ascii");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(fonts.length, 6);
  header.writeUInt32LE(0, 8);
  chunks.push(header);

  for (const font of fonts) {
    const section = [];
    const meta = Buffer.alloc(24);
    meta.writeUInt16LE(font.nativeHeight, 0);
    meta.writeUInt8(font.padBytes, 2);
    meta.writeUInt8(font.msbFirst ? 1 : 0, 3);
    meta.writeUInt32LE(font.defaultGlyph, 4);
    meta.writeUInt32LE(font.glyphs.length, 8);
    meta.writeUInt32LE(font.codepoints.length, 12);
    section.push(meta);
    for (const glyph of font.glyphs) {
      const record = Buffer.alloc(24);
      record.writeInt16LE(glyph.metric.left, 0);
      record.writeInt16LE(glyph.metric.right, 2);
      record.writeInt16LE(glyph.metric.advance, 4);
      record.writeInt16LE(glyph.metric.ascent, 6);
      record.writeInt16LE(glyph.metric.descent, 8);
      record.writeUInt16LE(glyph.width, 10);
      record.writeUInt16LE(glyph.height, 12);
      record.writeUInt16LE(0, 14);
      record.writeUInt32LE(glyph.stride, 16);
      record.writeUInt32LE(glyph.data.length, 20);
      section.push(record, Buffer.from(glyph.data));
    }
    for (const [codePoint, glyphIndex] of font.codepoints) {
      const record = Buffer.alloc(8);
      record.writeUInt32LE(codePoint, 0);
      record.writeUInt32LE(glyphIndex, 4);
      section.push(record);
    }
    const sectionData = Buffer.concat(section);
    const sectionHeader = Buffer.alloc(4);
    sectionHeader.writeUInt32LE(sectionData.length, 0);
    chunks.push(sectionHeader, sectionData);
  }
  return Buffer.concat(chunks);
}

const bodyPath = arg("--body", path.join(root, "fonts/wenquanyi_13px.pcf"));
const decorPath = arg("--decor", path.join(root, "fonts/wenquanyi_9pt.pcf"));
const outputPath = arg("--out", path.join(root, "fonts/wenquanyi-bitmap-song.wqbm"));
const decorChars = arg("--decor-chars", DEFAULT_DECOR_CHARS);

const body = makeSubset(parsePcf(fs.readFileSync(bodyPath)), "", true);
const decor = makeSubset(parsePcf(fs.readFileSync(decorPath)), decorChars, false);
const bundle = writeBundle([body, decor]);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, bundle);

console.log(`Wrote ${outputPath}`);
console.log(`  body glyphs: ${body.glyphs.length}, codepoints: ${body.codepoints.length}`);
console.log(`  decor glyphs: ${decor.glyphs.length}, codepoints: ${decor.codepoints.length}`);
console.log(`  raw bundle: ${bundle.length} bytes`);
