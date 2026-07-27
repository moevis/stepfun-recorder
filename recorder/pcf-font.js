const PCF_METRICS = 1 << 2;
const PCF_BITMAPS = 1 << 3;
const PCF_BDF_ENCODINGS = 1 << 5;
const PCF_COMPRESSED_METRICS = 0x100;
const PCF_BYTE_MASK = 1 << 2;
const PCF_BIT_MASK = 1 << 3;
const PCF_GLYPH_PAD_MASK = 3;

export class PcfBitmapFont {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.tables = this.readTableDirectory();
    this.metrics = this.readMetrics();
    this.bitmap = this.readBitmaps();
    this.encoding = this.readEncodings();
    // Keep glyph cells on an integer pixel grid so the PCF bitmap stays crisp.
    this.cellGap = 0;
    this.displayScale = 1;
    this.nativeHeight = Math.max(
      1,
      ...this.metrics.map(metric => metric.ascent + metric.descent),
    );
  }

  static async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Unable to load PCF font: HTTP ${response.status}`);
    return new PcfBitmapFont(await response.arrayBuffer());
  }

  readTableDirectory() {
    if (
      this.bytes[0] !== 0x01
      || this.bytes[1] !== 0x66
      || this.bytes[2] !== 0x63
      || this.bytes[3] !== 0x70
    ) {
      throw new Error("Invalid PCF font header");
    }

    const count = this.view.getUint32(4, true);
    const tables = new Map();
    for (let index = 0; index < count; index += 1) {
      const offset = 8 + index * 16;
      const type = this.view.getUint32(offset, true);
      tables.set(type, {
        format: this.view.getUint32(offset + 4, true),
        size: this.view.getUint32(offset + 8, true),
        offset: this.view.getUint32(offset + 12, true),
      });
    }
    return tables;
  }

  tableReader(type) {
    const table = this.tables.get(type);
    if (!table) throw new Error(`PCF table ${type} is missing`);
    const format = this.view.getUint32(table.offset, true);
    const littleEndian = (format & PCF_BYTE_MASK) === 0;
    let position = table.offset + 4;
    return {
      format,
      table,
      u8: () => this.view.getUint8(position++),
      u16: () => {
        const value = this.view.getUint16(position, littleEndian);
        position += 2;
        return value;
      },
      i16: () => {
        const value = this.view.getInt16(position, littleEndian);
        position += 2;
        return value;
      },
      u32: () => {
        const value = this.view.getUint32(position, littleEndian);
        position += 4;
        return value;
      },
      get position() {
        return position;
      },
    };
  }

  readMetrics() {
    const reader = this.tableReader(PCF_METRICS);
    const compressed = (reader.format & PCF_COMPRESSED_METRICS) !== 0;
    const count = compressed ? reader.u16() : reader.u32();
    const metrics = [];

    for (let index = 0; index < count; index += 1) {
      if (compressed) {
        metrics.push({
          left: reader.u8() - 0x80,
          right: reader.u8() - 0x80,
          advance: reader.u8() - 0x80,
          ascent: reader.u8() - 0x80,
          descent: reader.u8() - 0x80,
        });
      } else {
        metrics.push({
          left: reader.i16(),
          right: reader.i16(),
          advance: reader.i16(),
          ascent: reader.i16(),
          descent: reader.i16(),
        });
        reader.u16(); // attributes
      }
    }
    return metrics;
  }

  readBitmaps() {
    const reader = this.tableReader(PCF_BITMAPS);
    const count = reader.u32();
    const offsets = Array.from({ length: count }, () => reader.u32());
    const sizes = Array.from({ length: 4 }, () => reader.u32());

    return {
      format: reader.format,
      offsets,
      sizes,
      dataOffset: reader.position,
      padBytes: 1 << (reader.format & PCF_GLYPH_PAD_MASK),
      msbFirst: (reader.format & PCF_BIT_MASK) !== 0,
    };
  }

  readEncodings() {
    const reader = this.tableReader(PCF_BDF_ENCODINGS);
    const minByte2 = reader.u16();
    const maxByte2 = reader.u16();
    const minByte1 = reader.u16();
    const maxByte1 = reader.u16();
    const defaultChar = reader.u16();
    const columns = maxByte2 - minByte2 + 1;
    const rows = maxByte1 - minByte1 + 1;
    const glyphs = Array.from({ length: columns * rows }, () => reader.u16());

    return {
      minByte2,
      maxByte2,
      minByte1,
      maxByte1,
      defaultChar,
      columns,
      glyphs,
    };
  }

  glyphIndexForCodePoint(codePoint) {
    const byte1 = codePoint >> 8;
    const byte2 = codePoint & 0xff;
    const encoding = this.encoding;
    if (
      byte1 < encoding.minByte1
      || byte1 > encoding.maxByte1
      || byte2 < encoding.minByte2
      || byte2 > encoding.maxByte2
    ) {
      return this.defaultGlyphIndex();
    }
    const index = (byte1 - encoding.minByte1) * encoding.columns
      + byte2 - encoding.minByte2;
    const glyphIndex = encoding.glyphs[index];
    return glyphIndex === 0xffff ? this.defaultGlyphIndex() : glyphIndex;
  }

  defaultGlyphIndex() {
    const codePoint = this.encoding.defaultChar;
    const byte1 = codePoint >> 8;
    const byte2 = codePoint & 0xff;
    if (
      byte1 < this.encoding.minByte1
      || byte1 > this.encoding.maxByte1
      || byte2 < this.encoding.minByte2
      || byte2 > this.encoding.maxByte2
    ) {
      return 0;
    }
    const index = (byte1 - this.encoding.minByte1) * this.encoding.columns
      + byte2 - this.encoding.minByte2;
    const glyphIndex = this.encoding.glyphs[index];
    return glyphIndex === 0xffff ? 0 : glyphIndex;
  }

  fontSizeFromContext(context) {
    return Number.parseFloat(context.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "26");
  }

  pixelScale(context) {
    return Math.max(
      1,
      Math.round(this.fontSizeFromContext(context) / this.nativeHeight) * this.displayScale,
    );
  }

  cellMetrics(context) {
    const scale = this.pixelScale(context);
    return {
      scale,
      pitch: scale + this.cellGap,
      size: Math.max(1, scale - 0.18),
    };
  }

  measure(text, context) {
    const { pitch } = this.cellMetrics(context);
    let width = 0;
    for (const character of String(text)) {
      const metric = this.metrics[this.glyphIndexForCodePoint(character.codePointAt(0))];
      const advance = metric?.advance ?? this.nativeHeight;
      width += advance * pitch;
    }
    return { width };
  }

  drawText(context, text, x, y, maxWidth) {
    const characters = [...String(text)];
    const { pitch } = this.cellMetrics(context);
    const naturalWidth = characters.reduce((width, character) => {
      const metric = this.metrics[this.glyphIndexForCodePoint(character.codePointAt(0))];
      return width + (metric?.advance ?? this.nativeHeight) * pitch;
    }, 0);
    const widthScale = maxWidth && naturalWidth > maxWidth ? maxWidth / naturalWidth : 1;

    let startX = x;
    const renderedWidth = naturalWidth * widthScale;
    if (context.textAlign === "center") startX -= renderedWidth / 2;
    if (context.textAlign === "right" || context.textAlign === "end") startX -= renderedWidth;

    context.save();
    context.imageSmoothingEnabled = false;
    context.translate(Math.round(startX), Math.round(y));
    context.scale(widthScale, 1);

    // A restrained two-pixel LCD projection: a dim offset layer sits behind
    // the crisp bitmap cell, giving the glyph a little optical spill without
    // turning the whole display into a glow.
    context.save();
    context.globalAlpha *= 0.18;
    let shadowPenX = 0;
    for (const character of characters) {
      const glyphIndex = this.glyphIndexForCodePoint(character.codePointAt(0));
      const metric = this.metrics[glyphIndex];
      if (!metric) continue;
      this.drawGlyph(context, glyphIndex, metric, shadowPenX, pitch, 2, 2);
      shadowPenX += metric.advance * pitch;
    }
    context.restore();

    let penX = 0;
    for (const character of characters) {
      const glyphIndex = this.glyphIndexForCodePoint(character.codePointAt(0));
      const metric = this.metrics[glyphIndex];
      if (!metric) continue;
      this.drawGlyph(context, glyphIndex, metric, penX, pitch, 0, 0);
      penX += metric.advance * pitch;
    }
    context.restore();
  }

  drawGlyph(context, glyphIndex, metric, penX, pitch, offsetX = 0, offsetY = 0) {
    const scale = pitch - this.cellGap;
    const cellSize = scale;
    const width = Math.max(0, metric.right - metric.left);
    const height = Math.max(0, metric.ascent + metric.descent);
    if (!width || !height) return;

    const stride = Math.ceil(width / (this.bitmap.padBytes * 8)) * this.bitmap.padBytes;
    const glyphOffset = this.bitmap.dataOffset + this.bitmap.offsets[glyphIndex];
    const top = -metric.ascent * scale;
    const left = penX + metric.left * scale;

    for (let row = 0; row < height; row += 1) {
      let runStart = -1;
      for (let column = 0; column <= width; column += 1) {
        let active = false;
        if (column < width) {
          const byte = this.bytes[glyphOffset + row * stride + (column >> 3)];
          const bit = this.bitmap.msbFirst ? 7 - (column & 7) : column & 7;
          active = ((byte >> bit) & 1) === 1;
        }
        if (active && runStart < 0) runStart = column;
        if (!active && runStart >= 0) {
          for (let cell = runStart; cell < column; cell += 1) {
            context.fillRect(
              left + cell * pitch + offsetX,
              top + row * pitch + offsetY,
              cellSize,
              cellSize,
            );
          }
          runStart = -1;
        }
      }
    }
  }
}

/**
 * Runtime representation of the compact WQBM bundle produced by
 * scripts/build-font-bundle.mjs. It deliberately exposes the same drawing and
 * measuring API as PcfBitmapFont, so the recorder does not care which source
 * format supplied the bitmap glyphs.
 */
export class PackedBitmapFont {
  constructor({ nativeHeight, defaultGlyph, codepoints, glyphs }) {
    this.nativeHeight = nativeHeight;
    this.defaultGlyph = defaultGlyph;
    this.glyphs = glyphs;
    this.encoding = new Map(codepoints);
    this.cellGap = 0;
    this.displayScale = 1;
  }

  glyphIndexForCodePoint(codePoint) {
    return this.encoding.get(codePoint) ?? this.defaultGlyph;
  }

  fontSizeFromContext(context) {
    return Number.parseFloat(context.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "26");
  }

  pixelScale(context) {
    return Math.max(
      1,
      Math.round(this.fontSizeFromContext(context) / this.nativeHeight) * this.displayScale,
    );
  }

  cellMetrics(context) {
    const scale = this.pixelScale(context);
    return { scale, pitch: scale + this.cellGap, size: Math.max(1, scale - 0.18) };
  }

  measure(text, context) {
    const { pitch } = this.cellMetrics(context);
    let width = 0;
    for (const character of String(text)) {
      const glyph = this.glyphs[this.glyphIndexForCodePoint(character.codePointAt(0))];
      width += (glyph?.advance ?? this.nativeHeight) * pitch;
    }
    return { width };
  }

  drawText(context, text, x, y, maxWidth) {
    const characters = [...String(text)];
    const { pitch } = this.cellMetrics(context);
    const naturalWidth = characters.reduce((width, character) => {
      const glyph = this.glyphs[this.glyphIndexForCodePoint(character.codePointAt(0))];
      return width + (glyph?.advance ?? this.nativeHeight) * pitch;
    }, 0);
    const widthScale = maxWidth && naturalWidth > maxWidth ? maxWidth / naturalWidth : 1;
    let startX = x;
    const renderedWidth = naturalWidth * widthScale;
    if (context.textAlign === "center") startX -= renderedWidth / 2;
    if (context.textAlign === "right" || context.textAlign === "end") startX -= renderedWidth;

    context.save();
    context.imageSmoothingEnabled = false;
    context.translate(Math.round(startX), Math.round(y));
    context.scale(widthScale, 1);
    context.save();
    context.globalAlpha *= 0.18;
    let shadowPenX = 0;
    for (const character of characters) {
      const glyph = this.glyphs[this.glyphIndexForCodePoint(character.codePointAt(0))];
      if (!glyph) continue;
      this.drawGlyph(context, glyph, shadowPenX, pitch, 2, 2);
      shadowPenX += glyph.advance * pitch;
    }
    context.restore();

    let penX = 0;
    for (const character of characters) {
      const glyph = this.glyphs[this.glyphIndexForCodePoint(character.codePointAt(0))];
      if (!glyph) continue;
      this.drawGlyph(context, glyph, penX, pitch);
      penX += glyph.advance * pitch;
    }
    context.restore();
  }

  drawGlyph(context, glyph, penX, pitch, offsetX = 0, offsetY = 0) {
    const cellSize = pitch - this.cellGap;
    const top = -glyph.ascent * cellSize;
    const left = penX + glyph.left * cellSize;
    for (let row = 0; row < glyph.height; row += 1) {
      let runStart = -1;
      for (let column = 0; column <= glyph.width; column += 1) {
        let active = false;
        if (column < glyph.width) {
          const byte = glyph.data[row * glyph.stride + (column >> 3)];
          const bit = glyph.msbFirst ? 7 - (column & 7) : column & 7;
          active = ((byte >> bit) & 1) === 1;
        }
        if (active && runStart < 0) runStart = column;
        if (!active && runStart >= 0) {
          for (let cell = runStart; cell < column; cell += 1) {
            context.fillRect(
              left + cell * pitch + offsetX,
              top + row * pitch + offsetY,
              cellSize,
              cellSize,
            );
          }
          runStart = -1;
        }
      }
    }
  }
}

export async function loadBitmapFontBundle(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load bitmap font bundle: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "WQBM") {
    throw new Error("Invalid WQBM font bundle header");
  }
  if (view.getUint16(4, true) !== 1) throw new Error("Unsupported WQBM version");
  const fontCount = view.getUint16(6, true);
  const fonts = [];
  let position = 12;

  for (let fontIndex = 0; fontIndex < fontCount; fontIndex += 1) {
    const sectionLength = view.getUint32(position, true);
    position += 4;
    const sectionEnd = position + sectionLength;
    const nativeHeight = view.getUint16(position, true);
    const padBytes = view.getUint8(position + 2);
    const msbFirst = view.getUint8(position + 3) !== 0;
    const defaultGlyph = view.getUint32(position + 4, true);
    const glyphCount = view.getUint32(position + 8, true);
    const codepointCount = view.getUint32(position + 12, true);
    position += 24;
    const glyphs = [];
    for (let i = 0; i < glyphCount; i += 1) {
      const left = view.getInt16(position, true);
      const right = view.getInt16(position + 2, true);
      const advance = view.getInt16(position + 4, true);
      const ascent = view.getInt16(position + 6, true);
      const descent = view.getInt16(position + 8, true);
      const width = view.getUint16(position + 10, true);
      const height = view.getUint16(position + 12, true);
      const stride = view.getUint32(position + 16, true);
      const dataLength = view.getUint32(position + 20, true);
      position += 24;
      const data = bytes.slice(position, position + dataLength);
      position += dataLength;
      glyphs.push({
        left, right, advance, ascent, descent, width, height, stride,
        data, padBytes, msbFirst,
      });
    }
    const codepoints = [];
    for (let i = 0; i < codepointCount; i += 1) {
      codepoints.push([
        view.getUint32(position, true),
        view.getUint32(position + 4, true),
      ]);
      position += 8;
    }
    if (position !== sectionEnd) throw new Error("Corrupt WQBM font section");
    fonts.push(new PackedBitmapFont({ nativeHeight, defaultGlyph, codepoints, glyphs }));
  }
  return fonts;
}
