import { loadBitmapFontBundle } from "./pcf-font.js";

const canvas = document.querySelector("#lcd");
const ctx = canvas.getContext("2d");
const logoCanvas = document.createElement("canvas");
const logoCtx = logoCanvas.getContext("2d");
const ghostCanvas = document.createElement("canvas");
const ghostCtx = ghostCanvas.getContext("2d");
const recordButton = document.querySelector("#recordButton");
const stopButton = document.querySelector("#stopButton");
const clearButton = document.querySelector("#clearButton");
const menuButton = document.querySelector("#menuButton");
const settingsPanel = document.querySelector("#settingsPanel");
const endpointInput = document.querySelector("#endpoint");
const apiKeyInput = document.querySelector("#apiKey");
const meterNeedle = document.querySelector("#meterNeedle");
const voiceIndicator = document.querySelector("#voiceIndicator");

const canvasFontFamily = "WenQuanYi Bitmap Song";
const decorationFontFamily = "WenQuanYi Bitmap Song 9pt";
const canvasFont = (weight = 500) => `${weight} 34px "${canvasFontFamily}"`;
// Keep the same integer pixel scale as the 13px content font. The 9pt PCF
// should change the glyph design, not make its individual LCD cells smaller.
const decorationFont = () => `500 34px "${decorationFontFamily}"`;
const canvasLineHeight = 34;

const nativeFillText = ctx.fillText.bind(ctx);
const nativeMeasureText = ctx.measureText.bind(ctx);
let bitmapFont;
let decorationFontBitmap;

ctx.fillText = (text, x, y, maxWidth) => {
  if (bitmapFont) {
    bitmapFont.drawText(ctx, String(text), x, y, maxWidth);
  } else {
    nativeFillText(text, x, y, maxWidth);
  }
};

ctx.measureText = text => {
  if (bitmapFont) return bitmapFont.measure(String(text), ctx);
  return nativeMeasureText(text);
};

function fillDecorationText(text, x, y, align = "left") {
  ctx.save();
  ctx.textAlign = align;
  ctx.font = decorationFont();
  if (decorationFontBitmap) {
    decorationFontBitmap.drawText(ctx, text, x, y);
  } else {
    nativeFillText(text, x, y);
  }
  ctx.restore();
}

function renderSettingsBitmapLabels() {
  if (!decorationFontBitmap) return;
  for (const label of document.querySelectorAll(".bitmap-label")) {
    const text = label.dataset.text ?? "";
    const labelContext = label.getContext("2d");
    labelContext.font = `500 26px "${decorationFontFamily}"`;
    const width = Math.max(1, Math.ceil(decorationFontBitmap.measure(text, labelContext).width));
    const height = decorationFontBitmap.nativeHeight + 8;
    label.width = width;
    label.height = height;
    labelContext.font = `500 26px "${decorationFontFamily}"`;
    labelContext.fillStyle = label.classList.contains("bitmap-label-invert")
      ? "#c9d0a4"
      : "#253027";
    labelContext.imageSmoothingEnabled = false;
    decorationFontBitmap.drawText(
      labelContext,
      text,
      0,
      decorationFontBitmap.nativeHeight + 3,
    );
  }
}

const palette = [
  "#273229",
  "#364237",
  "#485448",
  "#5d6958",
  "#737e68",
  "#89937a",
  "#9da68a",
  "#b0b892",
];

const samples = [
  {
    source: "我想预订一张明天早上去上海的火车票，最好是靠窗的位置。",
    translated: "I’d like to book a train ticket to Shanghai tomorrow morning, preferably a window seat.",
  },
  {
    source: "到达以后请给我发消息，我会在车站出口等你。",
    translated: "Send me a message when you arrive. I’ll be waiting for you at the station exit.",
  },
  {
    source: "这个录音机会一边听你说话，一边把翻译显示在屏幕上。",
    translated: "This recorder listens to you and displays the translation on screen at the same time.",
  },
];

const state = {
  mode: "idle",
  startedAt: 0,
  elapsedBeforePause: 0,
  source: "",
  translated: "",
  sourceIndex: 0,
  translationIndex: 0,
  sampleIndex: 0,
  battery: 4,
  lastSourceTick: 0,
  lastTranslationTick: 0,
  toast: "",
  toastUntil: 0,
  rounds: [],
  viewingRound: -1,
  ghostStartedAt: 0,
  ghostDuration: 190,
  lcdFrame: null,
  lcdFrameTime: 0,
  lcdHoldMs: 76,
  dbLevel: -40,
  displayedDb: -40,
  voiceDetected: false,
  realtime: {
    socket: null,
    audioContext: null,
    processor: null,
    source: null,
    stream: null,
    enabled: false,
    connecting: false,
    responseDone: false,
    transcriptDone: false,
  },
};

const ENDPOINT_STORAGE_KEY = "recorder.endpoint";
const API_KEY_STORAGE_KEY = "recorder.apiKey";
const LEGACY_ENDPOINT_STORAGE_KEY = "recroder.endpoint";
const LEGACY_API_KEY_STORAGE_KEY = "recroder.apiKey";
const DEFAULT_ENDPOINT = "wss://api.stepfun.com/v1/realtime";

function loadConnectionSettings() {
  try {
    const storedEndpoint = localStorage.getItem(ENDPOINT_STORAGE_KEY)
      ?? localStorage.getItem(LEGACY_ENDPOINT_STORAGE_KEY);
    const storedApiKey = localStorage.getItem(API_KEY_STORAGE_KEY)
      ?? localStorage.getItem(LEGACY_API_KEY_STORAGE_KEY);
    endpointInput.value = storedEndpoint?.trim() || DEFAULT_ENDPOINT;
    if (storedApiKey !== null) apiKeyInput.value = storedApiKey;
  } catch (error) {
    console.warn("Unable to read connection settings from localStorage", error);
  }
}

function saveConnectionSettings() {
  const endpoint = endpointInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  try {
    localStorage.setItem(ENDPOINT_STORAGE_KEY, endpoint);
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    localStorage.removeItem(LEGACY_ENDPOINT_STORAGE_KEY);
    localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
  } catch (error) {
    console.warn("Unable to save connection settings to localStorage", error);
  }
}

loadConnectionSettings();

function syncCanvasOrientation() {
  const portrait = window.matchMedia("(max-width: 650px) and (orientation: portrait)").matches;
  const width = portrait ? 600 : 840;
  const height = portrait ? 690 : 440;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function captureScreenGhost() {
  ghostCanvas.width = canvas.width;
  ghostCanvas.height = canvas.height;
  ghostCtx.clearRect(0, 0, ghostCanvas.width, ghostCanvas.height);
  ghostCtx.drawImage(canvas, 0, 0);
  state.ghostStartedAt = performance.now();
}

function drawScreenGhost(now) {
  if (!state.ghostStartedAt || ghostCanvas.width !== canvas.width || ghostCanvas.height !== canvas.height) return;
  const progress = Math.min(1, (now - state.ghostStartedAt) / state.ghostDuration);
  if (progress >= 1) {
    state.ghostStartedAt = 0;
    ghostCtx.clearRect(0, 0, ghostCanvas.width, ghostCanvas.height);
    return;
  }

  // Quantized, fast LCD persistence: the previous frame hangs briefly,
  // then drops away in a few visible gray-level steps.
  const stepped = Math.ceil((1 - progress) * 5) / 5;
  ctx.save();
  ctx.globalAlpha = stepped * .42;
  ctx.globalCompositeOperation = "multiply";
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(ghostCanvas, 0, 0);
  ctx.restore();
}

function drawLcdPersistence(now) {
  if (!state.lcdFrame) return;
  const elapsedMs = now - state.lcdFrameTime;
  const fadeProgress = elapsedMs <= state.lcdHoldMs
    ? 0
    : Math.min(1, (elapsedMs - state.lcdHoldMs) / 115);
  const stepped = Math.ceil((1 - fadeProgress) * 4) / 4;
  if (fadeProgress >= 1) {
    state.lcdFrame = null;
    return;
  }
  ctx.save();
  ctx.globalAlpha = stepped * .36;
  ctx.globalCompositeOperation = "multiply";
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(state.lcdFrame, 0, 0);
  ctx.restore();
}

function rememberLcdFrame(now) {
  const frame = document.createElement("canvas");
  frame.width = canvas.width;
  frame.height = canvas.height;
  frame.getContext("2d").drawImage(canvas, 0, 0);
  state.lcdFrame = frame;
  state.lcdFrameTime = now;
}

function roundedRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function pixelLine(x1, y1, x2, y2, color = palette[1], width = 2) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.stroke();
}

function fitText(text, maxWidth, font) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

function wrapText(text, maxWidth, maxLines, font) {
  ctx.font = font;
  const units = [...text];
  const lines = [];
  let line = "";

  for (const unit of units) {
    const attempt = line + unit;
    if (ctx.measureText(attempt).width > maxWidth && line) {
      lines.push(line.trim());
      line = unit === " " ? "" : unit;
      if (lines.length === maxLines) break;
    } else {
      line = attempt;
    }
  }
  if (line && lines.length < maxLines) lines.push(line.trim());

  const renderedLength = lines.join("").replaceAll(" ", "").length;
  const originalLength = text.replaceAll(" ", "").length;
  if (renderedLength < originalLength && lines.length) {
    lines[lines.length - 1] = fitText(`${lines.at(-1)}…`, maxWidth, font);
  }
  return lines;
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function elapsed(now) {
  if (state.mode === "recording") return state.elapsedBeforePause + now - state.startedAt;
  return state.elapsedBeforePause;
}

function drawDotMatrix() {
  ctx.fillStyle = palette[7];
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalAlpha = 0.21;
  ctx.fillStyle = palette[2];
  for (let y = 4; y < canvas.height; y += 9) {
    for (let x = 4; x < canvas.width; x += 9) {
      ctx.fillRect(x, y, 2.4, 2.4);
    }
  }
  ctx.globalAlpha = 1;

  const noise = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  noise.addColorStop(0, "rgba(255,255,255,.045)");
  noise.addColorStop(0.46, "rgba(255,255,255,0)");
  noise.addColorStop(1, "rgba(24,36,28,.09)");
  ctx.fillStyle = noise;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawBattery() {
  const x = 762;
  const y = 31;
  ctx.strokeStyle = palette[1];
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, 45, 22);
  ctx.fillStyle = palette[1];
  ctx.fillRect(808, y + 6, 5, 10);
  for (let i = 0; i < state.battery; i += 1) {
    ctx.fillRect(x + 5 + i * 9, y + 5, 6, 12);
  }
}

function drawPortraitBattery() {
  const x = canvas.width - 70;
  const y = 28;
  ctx.strokeStyle = palette[1];
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, 42, 21);
  ctx.fillStyle = palette[1];
  ctx.fillRect(x + 43, y + 6, 5, 9);
  for (let i = 0; i < state.battery; i += 1) {
    ctx.fillRect(x + 5 + i * 8, y + 5, 5, 11);
  }
}

function drawStepfunLogo(centerX, centerY, size) {
  const scale = 2;
  const renderSize = Math.round(size * scale);
  logoCanvas.width = renderSize;
  logoCanvas.height = renderSize;

  const radius = renderSize / 2;
  logoCtx.clearRect(0, 0, renderSize, renderSize);
  logoCtx.fillStyle = palette[1];
  logoCtx.beginPath();
  logoCtx.arc(radius, radius, radius - scale, 0, Math.PI * 2);
  logoCtx.fill();

  // 3 × 3 grid. The listed cells are knocked out of the circular mark.
  const cutouts = [
    [0, 1],
    [0, 2],
    [1, 1],
    [2, 0],
    [2, 1],
  ];
  const gridSize = renderSize * .58;
  const gridLeft = (renderSize - gridSize) / 2;
  const gridTop = (renderSize - gridSize) / 2;
  const gap = renderSize * .035;
  const cell = (gridSize - gap * 2) / 3;

  logoCtx.globalCompositeOperation = "destination-out";
  for (const [row, col] of cutouts) {
    const x = Math.round(gridLeft + col * (cell + gap));
    const y = Math.round(gridTop + row * (cell + gap));
    const w = Math.round(cell);
    const h = Math.round(cell);
    const r = Math.max(2, Math.round(scale * 1.6));
    logoCtx.beginPath();
    logoCtx.moveTo(x + r, y);
    logoCtx.arcTo(x + w, y, x + w, y + h, r);
    logoCtx.arcTo(x + w, y + h, x, y + h, r);
    logoCtx.arcTo(x, y + h, x, y, r);
    logoCtx.arcTo(x, y, x + w, y, r);
    logoCtx.closePath();
    logoCtx.fill();
  }
  logoCtx.globalCompositeOperation = "source-over";

  ctx.save();
  // The shadow is generated from the finished alpha mask, not from a circle.
  // This means the rounded cut-outs also cast a very small, believable inner
  // shadow instead of being filled back in by a generic circular shadow.
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = renderSize;
  shadowCanvas.height = renderSize;
  const shadowCtx = shadowCanvas.getContext("2d");
  shadowCtx.filter = `blur(${Math.round(scale * 1.4)}px)`;
  shadowCtx.globalAlpha = 0.34;
  shadowCtx.drawImage(logoCanvas, scale * 2, scale * 2);
  shadowCtx.filter = "none";
  shadowCtx.globalCompositeOperation = "source-in";
  shadowCtx.fillStyle = palette[0];
  shadowCtx.fillRect(0, 0, renderSize, renderSize);
  shadowCtx.globalCompositeOperation = "source-over";

  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 0.34;
  ctx.drawImage(
    shadowCanvas,
    Math.round(centerX - size / 2),
    Math.round(centerY - size / 2),
    Math.round(size),
    Math.round(size),
  );
  ctx.globalAlpha = 1;
  ctx.drawImage(
    logoCanvas,
    Math.round(centerX - size / 2),
    Math.round(centerY - size / 2),
    Math.round(size),
    Math.round(size),
  );
  ctx.restore();
}

function drawIdleMessage() {
  ctx.textAlign = "center";
  const portrait = canvas.height > canvas.width;

  drawStepfunLogo(
    canvas.width / 2,
    portrait ? 267 : 176,
    portrait ? 118 : 104,
  );

  ctx.fillStyle = palette[2];
  ctx.font = canvasFont();
  ctx.fillText("STEPFUN RECORDER", canvas.width / 2, portrait ? 371 : 266);
  ctx.font = canvasFont(400);
  ctx.fillStyle = palette[4];
  ctx.fillText("PRESS REC TO BEGIN", canvas.width / 2, portrait ? 408 : 300);
  ctx.textAlign = "left";
}

function drawStoppedMessage() {
  if (!state.rounds.length) return;
  ctx.fillStyle = palette[4];
  fillDecorationText("◀ ▶ REVIEW", 801, 416, "right");
}

function drawRoundBlock(round, roundNumber, y, isCurrent, now) {
  const cursor = isCurrent && state.mode === "recording";
  ctx.fillStyle = isCurrent ? palette[2] : palette[4];
  fillDecorationText(`ROUND ${String(roundNumber).padStart(2, "0")}`, 39, y + 38);
  fillDecorationText(isCurrent ? "NOW" : "HISTORY", 801, y + 38, "right");
  pixelLine(39, y + 58, 801, y + 58, isCurrent ? palette[3] : palette[5], 1);

  ctx.fillStyle = palette[4];
  // Leave a little more breathing room below the ROUND divider. The bitmap
  // glyphs have a visible top projection, so placing them too close makes the
  // Chinese line look pressed against the rule.
  fillDecorationText("ZH", 42, y + 84);
  fillDecorationText("EN", 42, y + 119);

  const sourceFont = canvasFont();
  const translatedFont = canvasFont();
  const textLeft = 79;
  const textRight = canvas.width - 42;
  const availableTextWidth = textRight - textLeft;
  const sourceLines = wrapText(round.source || "···", availableTextWidth, 1, sourceFont);
  const translatedLines = wrapText(round.translated || "···", availableTextWidth, 2, translatedFont);

  ctx.fillStyle = round.source ? palette[0] : palette[4];
  ctx.font = sourceFont;
  ctx.fillText(sourceLines[0] || "···", 79, y + 88);

  ctx.fillStyle = round.translated ? palette[1] : palette[4];
  ctx.font = translatedFont;
  translatedLines.forEach((line, index) => ctx.fillText(line, 79, y + 122 + index * canvasLineHeight));

  if (cursor && Math.floor(now / 430) % 2 === 0) {
    const activeFont = round.translated ? translatedFont : sourceFont;
    const activeLines = round.translated ? translatedLines : sourceLines;
    ctx.font = activeFont;
    const lastLine = activeLines.at(-1) || "";
    const cursorX = 79 + ctx.measureText(lastLine).width + 4;
    const activeLineIndex = activeLines.length - 1;
    const activeBaseline = round.translated
      ? y + 122 + activeLineIndex * canvasLineHeight
      : y + 88;
    const cursorHeight = 22;
    const cursorY = activeBaseline - cursorHeight;
    ctx.fillRect(Math.min(cursorX, 793), cursorY, 3, cursorHeight);
  }

}

function visibleRounds() {
  const browsableRounds = getBrowsableRounds();
  if ((state.mode === "stopped" || state.mode === "paused") && browsableRounds.length) {
    const end = Math.min(state.viewingRound, browsableRounds.length - 1);
    const start = Math.max(0, end - 1);
    return browsableRounds.slice(start, end + 1).map((round, index) => ({
      ...round,
      number: start + index + 1,
      current: start + index === end,
    }));
  }

  const completed = state.rounds.slice(-1).map((round, index) => ({
    ...round,
    number: state.rounds.length - index,
    current: false,
  }));
  return [
    ...completed,
    {
      source: state.source,
      translated: state.translated,
      number: state.rounds.length + 1,
      current: true,
    },
  ].slice(-2);
}

function getBrowsableRounds() {
  if (state.mode !== "paused") return state.rounds;
  if (!state.source && !state.translated) return state.rounds;
  const latest = state.rounds.at(-1);
  if (latest?.source === state.source && latest?.translated === state.translated) return state.rounds;
  return [
    ...state.rounds,
    {
      source: state.source,
      translated: state.translated,
    },
  ];
}

function drawPortraitRound(round, roundNumber, y, isCurrent, now) {
  const left = 29;
  const right = canvas.width - 29;
  const width = right - left;
  const cursor = isCurrent && state.mode === "recording";

  ctx.fillStyle = isCurrent ? palette[2] : palette[4];
  fillDecorationText(`ROUND ${String(roundNumber).padStart(2, "0")}`, left, y + 38);
  fillDecorationText(isCurrent ? "NOW" : "HISTORY", right, y + 38, "right");
  pixelLine(left, y + 59, right, y + 59, isCurrent ? palette[3] : palette[5], 1);

  ctx.fillStyle = palette[4];
  fillDecorationText("ZH", left + 2, y + 91);
  const sourceFont = canvasFont();
  const portraitTextWidth = canvas.width - (left + 39) - 29;
  const sourceLines = wrapText(round.source || "···", portraitTextWidth, 2, sourceFont);
  ctx.fillStyle = round.source ? palette[0] : palette[4];
  ctx.font = sourceFont;
  sourceLines.forEach((line, index) => ctx.fillText(line, left + 39, y + 94 + index * canvasLineHeight));

  // Continue EN on exactly the next bitmap-text line after the final ZH line.
  // With the +3 baseline offset below, this keeps both orientations on the
  // same 34px line grid rather than inserting a separate blank line.
  const translationY = y + 91 + sourceLines.length * canvasLineHeight;
  ctx.fillStyle = palette[4];
  fillDecorationText("EN", left + 2, translationY);
  const translatedFont = canvasFont();
  const translatedLines = wrapText(round.translated || "···", portraitTextWidth, 3, translatedFont);
  ctx.fillStyle = round.translated ? palette[1] : palette[4];
  ctx.font = translatedFont;
  translatedLines.forEach((line, index) => {
    ctx.fillText(line, left + 39, translationY + 3 + index * canvasLineHeight);
  });

  if (cursor && Math.floor(now / 430) % 2 === 0) {
    const lines = round.translated ? translatedLines : sourceLines;
    const font = round.translated ? translatedFont : sourceFont;
    ctx.font = font;
    const lastLine = lines.at(-1) || "";
    const x = left + 39 + ctx.measureText(lastLine).width + 3;
    const cursorY = round.translated
      ? translationY - 14 + (lines.length - 1) * canvasLineHeight
      : y + 75 + (lines.length - 1) * canvasLineHeight;
    ctx.fillRect(Math.min(x, right - 4), cursorY, 3, round.translated ? 19 : 22);
  }

}

function drawPortraitScreen(now) {
  const clock = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const isRecording = state.mode === "recording";
  const isPaused = state.mode === "paused";

  ctx.fillStyle = palette[1];
  fillDecorationText(clock, 29, 46);

  ctx.beginPath();
  ctx.arc(164, 39, 7, 0, Math.PI * 2);
  ctx.fillStyle = isRecording && Math.floor(now / 500) % 2 === 0 ? palette[0] : palette[5];
  ctx.fill();
  ctx.fillStyle = palette[2];
  if (!isPaused) {
    fillDecorationText(isRecording ? "REC" : "STBY", 179, 45);
  }

  fillDecorationText(formatDuration(elapsed(now)), canvas.width / 2, 46, "center");
  if (state.mode === "stopped" && state.rounds.length) {
    const roundNumber = state.viewingRound + 1;
    ctx.fillStyle = palette[2];
    fillDecorationText(
      `SAVED · ROUND ${String(roundNumber).padStart(2, "0")}`,
      canvas.width - 88,
      45,
      "right",
    );
  }
  drawPortraitBattery();
  pixelLine(29, 65, canvas.width - 29, 65, palette[2], 2);

  if (state.mode === "idle" || (state.mode === "stopped" && !state.rounds.length)) {
    drawIdleMessage();
  } else {
    const rounds = visibleRounds();
    // Keep the first round anchored to the same top position whether one or
    // two rounds are visible, instead of vertically centering a lone round.
    const startY = 64;
    const gap = 268;
    rounds.forEach((round, index) => {
      drawPortraitRound(
        round,
        round.number,
        startY + index * gap,
        round.current,
        now,
      );
    });
    if (state.mode === "stopped" && state.rounds.length) {
      ctx.fillStyle = palette[4];
      fillDecorationText("◀ ▶ REVIEW", canvas.width - 29, 655, "right");
    }
  }

}

function drawScreen(now) {
  syncCanvasOrientation();
  drawDotMatrix();
  if (!settingsPanel.hidden) return;

  if (canvas.height > canvas.width) {
    drawPortraitScreen(now);
    drawScreenGhost(now);
    return;
  }

  const clock = new Date();
  const clockText = clock.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  ctx.fillStyle = palette[1];
  fillDecorationText(clockText, 38, 50);

  const isRecording = state.mode === "recording";
  const isPaused = state.mode === "paused";
  ctx.beginPath();
  ctx.arc(281, 42, 8, 0, Math.PI * 2);
  ctx.fillStyle = isRecording && Math.floor(now / 500) % 2 === 0 ? palette[0] : palette[5];
  ctx.fill();
  ctx.fillStyle = palette[2];
  if (!isPaused) {
    fillDecorationText(isRecording ? "REC" : "STBY", 298, 48);
  }

  fillDecorationText(formatDuration(elapsed(now)), canvas.width / 2, 50, "center");
  if (state.mode === "stopped" && state.rounds.length) {
    const roundNumber = state.viewingRound + 1;
    ctx.fillStyle = palette[2];
    fillDecorationText(
      `SAVED · ROUND ${String(roundNumber).padStart(2, "0")}`,
      742,
      48,
      "right",
    );
  }
  drawBattery();
  pixelLine(38, 70, 802, 70, palette[2], 2);

  if (state.mode === "idle" || (state.mode === "stopped" && !state.rounds.length)) {
    drawIdleMessage();
  } else {
    const rounds = visibleRounds();
    // Two horizontal rounds need slightly more vertical room than the old
    // 159px stride, particularly when English wraps to two lines.
    const startY = 70;
    const roundGap = rounds.length === 1 ? 0 : 185;
    rounds.forEach((round, index) => {
      drawRoundBlock(round, round.number, startY + index * roundGap, round.current, now);
    });
    if (state.mode === "stopped") drawStoppedMessage();
  }

  if (state.toast && now < state.toastUntil) {
    ctx.font = canvasFont();
    const width = ctx.measureText(state.toast).width + 30;
    ctx.fillStyle = palette[1];
    ctx.fillRect((canvas.width - width) / 2, 382, width, 31);
    ctx.fillStyle = palette[7];
    ctx.textAlign = "center";
    ctx.fillText(state.toast, canvas.width / 2, 403);
    ctx.textAlign = "left";
  }

  drawScreenGhost(now);
}

function realtimeSend(event) {
  const socket = state.realtime.socket;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function downsampleToPcm16(input, inputRate, outputRate = 24000) {
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < Math.max(start + 1, end); j += 1) sum += input[j] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

function measureInputDb(samples) {
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sumSquares += samples[index] * samples[index];
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return Math.max(-40, Math.min(0, 20 * Math.log10(Math.max(rms, 0.00001))));
}

function setVoiceIndicator(active) {
  if (active === state.voiceDetected) return;
  state.voiceDetected = active;
  voiceIndicator.classList.toggle("is-active", active);
  voiceIndicator.setAttribute("aria-label", active ? "检测到人声" : "未检测到人声");
}

function closeRealtime() {
  const realtime = state.realtime;
  realtime.processor?.disconnect();
  realtime.source?.disconnect();
  realtime.audioContext?.close().catch(() => {});
  realtime.stream?.getTracks().forEach(track => track.stop());
  if (realtime.socket && realtime.socket.readyState < WebSocket.CLOSING) realtime.socket.close();
  realtime.socket = null;
  realtime.processor = null;
  realtime.source = null;
  realtime.audioContext = null;
  realtime.stream = null;
  realtime.enabled = false;
  realtime.connecting = false;
  state.dbLevel = -40;
  setVoiceIndicator(false);
}

function applyRealtimeEvent(event) {
  if (event.type === "input_audio_buffer.speech_started") {
    setVoiceIndicator(true);
    return;
  }
  if (event.type === "input_audio_buffer.speech_stopped") {
    setVoiceIndicator(false);
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    state.source += event.delta ?? "";
    state.sourceIndex = state.source.length;
    return;
  }
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    state.source = event.transcript ?? state.source;
    state.sourceIndex = state.source.length;
    state.realtime.transcriptDone = true;
    finishRealtimeTurnIfReady();
    return;
  }
  if (event.type === "response.audio_transcript.delta") {
    state.translated += event.delta ?? "";
    state.translationIndex = state.translated.length;
    return;
  }
  if (event.type === "response.audio_transcript.done" && !state.translated) {
    state.translated = event.transcript ?? "";
    state.translationIndex = state.translated.length;
    return;
  }
  if (event.type === "response.done") {
    state.realtime.responseDone = true;
    finishRealtimeTurnIfReady();
    return;
  }
  if (event.type === "error") {
    state.toast = event.error?.message || "REALTIME CONNECTION ERROR";
    state.toastUntil = performance.now() + 2600;
  }
}

function finishRealtimeTurnIfReady() {
  const realtime = state.realtime;
  if (!realtime.responseDone || !realtime.transcriptDone) return;
  commitCurrentRound();
  state.source = "";
  state.translated = "";
  state.sourceIndex = 0;
  state.translationIndex = 0;
  realtime.responseDone = false;
  realtime.transcriptDone = false;
}

async function connectRealtime() {
  if (state.realtime.enabled || state.realtime.connecting) return true;
  const endpoint = endpointInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  if (!endpoint || !apiKey) {
    state.toast = "SET ENDPOINT AND API KEY IN MENU";
    state.toastUntil = performance.now() + 2400;
    return false;
  }

  state.realtime.connecting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(2048, 1, 1);
    const mute = audioContext.createGain();
    mute.gain.value = 0;
    const configuredUrl = new URL(endpoint, window.location.href);
    if (!configuredUrl.pathname.endsWith("/v1/realtime")) {
      configuredUrl.pathname = `${configuredUrl.pathname.replace(/\/+$/, "")}/v1/realtime`;
    }
    configuredUrl.searchParams.set("model", "stepaudio-2.5-realtime");
    // Realtime API beta browser protocol: the browser cannot set an
    // Authorization header, so the API key is carried in the negotiated
    // WebSocket subprotocol, matching the beta client convention.
    const socket = new WebSocket(configuredUrl.toString(), [
      "realtime",
      `openai-insecure-api-key.${apiKey}`,
      "openai-beta.realtime-v1",
    ]);

    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    });

    state.realtime.socket = socket;
    state.realtime.stream = stream;
    state.realtime.audioContext = audioContext;
    state.realtime.source = source;
    state.realtime.processor = processor;
    state.realtime.enabled = true;
    state.realtime.connecting = false;
    state.realtime.responseDone = false;

    socket.addEventListener("message", message => {
      try {
        applyRealtimeEvent(JSON.parse(message.data));
      } catch (error) {
        console.warn("Invalid realtime event", error);
      }
    });
    socket.addEventListener("close", () => {
      state.realtime.enabled = false;
      state.dbLevel = -40;
      setVoiceIndicator(false);
      if (state.mode === "recording") state.mode = "paused";
    });

    realtimeSend({
      type: "session.update",
      session: {
        modalities: ["text"],
        instructions: [
          "你是一名专业的中译英同声传译员。",
          "将用户说出的中文忠实、自然、简洁地翻译为英文。",
          "准确保留人名、地名、机构名、数字、日期、时间、金额、单位和专有名词；不要增添、删减、解释或总结。",
          "保留原话的语气、意图和疑问或命令形式，口语应译成自然的英文口语。",
          "如果原话有短暂口误或重复，只做不改变含义的最小整理；内容不确定时不要猜测或补充事实。",
          "只输出英文译文，不要输出中文原文、前缀、引号、注释、说明或任何额外内容。",
        ].join(" "),
        input_audio_format: "pcm16",
        turn_detection: {
          type: "server_vad",
          interrupt: false,
          create_response: true,
        },
      },
    });

    processor.onaudioprocess = event => {
      const samples = event.inputBuffer.getChannelData(0);
      state.dbLevel = state.mode === "recording" ? measureInputDb(samples) : -40;
      if (state.mode !== "recording" || socket.readyState !== WebSocket.OPEN) return;
      const pcm = downsampleToPcm16(samples, audioContext.sampleRate);
      realtimeSend({ type: "input_audio_buffer.append", audio: arrayBufferToBase64(pcm) });
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(audioContext.destination);
    return true;
  } catch (error) {
    closeRealtime();
    state.toast = error.message || "REALTIME CONNECTION FAILED";
    state.toastUntil = performance.now() + 2800;
    return false;
  }
}

function streamText(now) {
  if (state.realtime.enabled) return;
  if (state.mode !== "recording") return;
  const sample = samples[state.sampleIndex];

  if (state.sourceIndex < sample.source.length && now - state.lastSourceTick > 62) {
    const amount = Math.random() > .72 ? 2 : 1;
    state.sourceIndex = Math.min(sample.source.length, state.sourceIndex + amount);
    state.source = sample.source.slice(0, state.sourceIndex);
    state.lastSourceTick = now;
  }

  if (state.translationIndex < sample.translated.length && now - state.lastTranslationTick > 48) {
    const leadLimit = Math.max(2, Math.floor((state.sourceIndex / sample.source.length) * sample.translated.length) + 5);
    if (state.translationIndex < leadLimit) {
      const amount = Math.random() > .58 ? 2 : 1;
      state.translationIndex = Math.min(sample.translated.length, state.translationIndex + amount);
      state.translated = sample.translated.slice(0, state.translationIndex);
    }
    state.lastTranslationTick = now;
  }

  if (state.sourceIndex === sample.source.length && state.translationIndex === sample.translated.length) {
    if (!state.completeAt) state.completeAt = now;
    if (now - state.completeAt > 1800) {
      transitionToNextRound(now);
    }
  }
}

function transitionToNextRound(now) {
  // The persistence belongs to the actual round transition only. Do not
  // capture on the final streaming character, otherwise the LCD flashes
  // after the sentence is complete while the round is still unchanged.
  rememberLcdFrame(now);
  commitCurrentRound();
  state.sampleIndex = (state.sampleIndex + 1) % samples.length;
  state.source = "";
  state.translated = "";
  state.sourceIndex = 0;
  state.translationIndex = 0;
  state.completeAt = 0;
}

function commitCurrentRound() {
  if (!state.source && !state.translated) return;
  const latest = state.rounds.at(-1);
  if (latest?.source === state.source && latest?.translated === state.translated) return;
  state.rounds.push({
    source: state.source,
    translated: state.translated,
  });
  state.viewingRound = state.rounds.length - 1;
}

function updateHistoryControls() {
  const browsableRounds = getBrowsableRounds();
  const canBrowse = (state.mode === "stopped" || state.mode === "paused") && browsableRounds.length > 0;
  recordButton.classList.toggle("history-mode", canBrowse);
  recordButton.classList.toggle("can-browse", canBrowse);
  recordButton.classList.toggle("history-start", !canBrowse || state.viewingRound <= 0);
  recordButton.classList.toggle("history-end", !canBrowse || state.viewingRound >= browsableRounds.length - 1);
}

function browseRound(delta) {
  const browsableRounds = getBrowsableRounds();
  if ((state.mode !== "stopped" && state.mode !== "paused") || !browsableRounds.length) return;
  const nextRound = Math.max(0, Math.min(browsableRounds.length - 1, state.viewingRound + delta));
  if (nextRound === state.viewingRound) return;
  captureScreenGhost();
  state.viewingRound = nextRound;
}

function animate(now) {
  streamText(now);
  updateLevelMeter(now);
  updateHistoryControls();
  drawScreen(now);
  drawLcdPersistence(now);
  requestAnimationFrame(animate);
}

function dbToPosition(db) {
  const points = [
    [-40, 3],
    [-24, 20],
    [-12, 40],
    [-6, 61],
    [-3, 78],
    [0, 94],
  ];
  for (let index = 1; index < points.length; index += 1) {
    const [lowDb, lowPosition] = points[index - 1];
    const [highDb, highPosition] = points[index];
    if (db <= highDb) {
      const progress = (db - lowDb) / (highDb - lowDb);
      return lowPosition + (highPosition - lowPosition) * progress;
    }
  }
  return points.at(-1)[1];
}

function updateLevelMeter(now) {
  if (state.mode === "recording" && !state.realtime.enabled) {
    const speech = Math.sin(now * .009) * 4.5
      + Math.sin(now * .021) * 2.4
      + Math.sin(now * .0037) * 3.2;
    const transient = Math.max(0, Math.sin(now * .041)) * 3;
    state.dbLevel = Math.max(-34, Math.min(-1, -13 + speech + transient));
  } else if (state.mode !== "recording") {
    state.dbLevel = -40;
  }
  const response = state.dbLevel > state.displayedDb ? .38 : .12;
  state.displayedDb += (state.dbLevel - state.displayedDb) * response;
  const position = dbToPosition(state.displayedDb);
  meterNeedle.style.left = `${position}%`;
  meterNeedle.style.setProperty("--needle-angle", `${(position - 48) * .055}deg`);

}

async function setRecording() {
  if (state.mode === "recording") {
    state.elapsedBeforePause += performance.now() - state.startedAt;
    state.mode = "paused";
    state.dbLevel = -40;
    setVoiceIndicator(false);
    state.viewingRound = getBrowsableRounds().length - 1;
  } else {
    if (state.mode === "idle" || state.mode === "stopped") {
      state.elapsedBeforePause = 0;
      state.rounds = [];
      state.viewingRound = -1;
      state.source = "";
      state.translated = "";
      state.sourceIndex = 0;
      state.translationIndex = 0;
      state.completeAt = 0;
    }
    const connected = await connectRealtime();
    if (!connected) return;
    state.startedAt = performance.now();
    state.lastSourceTick = performance.now();
    state.lastTranslationTick = performance.now();
    state.mode = "recording";
  }
  recordButton.classList.toggle("is-recording", state.mode === "recording");
  recordButton.setAttribute("aria-pressed", String(state.mode === "recording"));
}

recordButton.addEventListener("click", (event) => {
  settingsPanel.hidden = true;
  const bounds = recordButton.getBoundingClientRect();
  const position = (event.clientX - bounds.left) / bounds.width;

  if ((state.mode === "stopped" || state.mode === "paused") && getBrowsableRounds().length && position < .34) {
    browseRound(-1);
    return;
  }
  if ((state.mode === "stopped" || state.mode === "paused") && getBrowsableRounds().length && position > .66) {
    browseRound(1);
    return;
  }
  void setRecording();
});

function getDialSide(event) {
  const bounds = recordButton.getBoundingClientRect();
  const position = (event.clientX - bounds.left) / bounds.width;
  if (position < .34) return "left";
  if (position > .66) return "right";
  return "";
}

function updateHistoryHover(event) {
  recordButton.classList.remove("history-hover-left", "history-hover-right");
  const side = getDialSide(event);
  if (side === "left") {
    recordButton.classList.add("history-hover-left");
  } else if (side === "right") {
    recordButton.classList.add("history-hover-right");
  }
}

function updateHistoryPress(event) {
  recordButton.classList.remove("history-press-left", "history-press-right");
  const side = getDialSide(event);
  if (side === "left") {
    recordButton.classList.add("history-press-left");
  } else if (side === "right") {
    recordButton.classList.add("history-press-right");
  }
}

recordButton.addEventListener("pointerenter", updateHistoryHover);
recordButton.addEventListener("pointermove", updateHistoryHover);
recordButton.addEventListener("pointerdown", (event) => {
  updateHistoryHover(event);
  updateHistoryPress(event);
});
recordButton.addEventListener("pointerup", (event) => {
  recordButton.classList.remove("history-press-left", "history-press-right");
  updateHistoryHover(event);
});
recordButton.addEventListener("pointercancel", () => {
  recordButton.classList.remove("history-press-left", "history-press-right");
});
recordButton.addEventListener("pointerleave", () => {
  recordButton.classList.remove(
    "history-press-left",
    "history-press-right",
    "history-hover-left",
    "history-hover-right",
  );
});

stopButton.addEventListener("click", () => {
  if (state.mode === "recording") {
    state.elapsedBeforePause += performance.now() - state.startedAt;
  }
  commitCurrentRound();
  state.mode = "stopped";
  closeRealtime();
  state.viewingRound = state.rounds.length - 1;
  recordButton.classList.remove("is-recording");
  recordButton.setAttribute("aria-pressed", "false");
  settingsPanel.hidden = true;
});

clearButton.addEventListener("click", () => {
  settingsPanel.hidden = true;
  state.rounds = [];
  state.viewingRound = -1;

  if (state.mode === "recording" || state.mode === "paused") {
    state.sampleIndex = 0;
    state.source = "";
    state.translated = "";
    state.sourceIndex = 0;
    state.translationIndex = 0;
    state.completeAt = 0;
    state.elapsedBeforePause = 0;
    if (state.mode === "recording") state.startedAt = performance.now();
    state.lastSourceTick = performance.now();
    state.lastTranslationTick = performance.now();
    return;
  }

  state.mode = "idle";
  state.source = "";
  state.translated = "";
  state.sourceIndex = 0;
  state.translationIndex = 0;
  state.completeAt = 0;
  state.elapsedBeforePause = 0;
  recordButton.classList.remove("is-recording");
  recordButton.setAttribute("aria-pressed", "false");
});

menuButton.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  menuButton.setAttribute("aria-pressed", String(!settingsPanel.hidden));
  if (!settingsPanel.hidden) {
    renderSettingsBitmapLabels();
    endpointInput.focus();
  }
});

settingsPanel.addEventListener("submit", (event) => {
  event.preventDefault();
  saveConnectionSettings();
  settingsPanel.hidden = true;
  menuButton.setAttribute("aria-pressed", "false");
  state.toast = "CONNECTION SETTINGS SAVED";
  state.toastUntil = performance.now() + 1800;
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && settingsPanel.hidden) {
    event.preventDefault();
    void setRecording();
  }
  if ((state.mode === "stopped" || state.mode === "paused") && event.key === "ArrowLeft" && state.viewingRound > 0) {
    browseRound(-1);
  }
  if ((state.mode === "stopped" || state.mode === "paused") && event.key === "ArrowRight" && state.viewingRound < getBrowsableRounds().length - 1) {
    browseRound(1);
  }
  if (event.key === "Escape" && !settingsPanel.hidden) {
    settingsPanel.hidden = true;
    menuButton.setAttribute("aria-pressed", "false");
  }
});

window.addEventListener("resize", syncCanvasOrientation);
syncCanvasOrientation();

async function start() {
  try {
    const fontUrl = new URL("./fonts/wenquanyi-bitmap-song.wqbm", import.meta.url);
    [bitmapFont, decorationFontBitmap] = await loadBitmapFontBundle(fontUrl);
    renderSettingsBitmapLabels();
    document.documentElement.dataset.bitmapFont = "loaded";
  } catch (error) {
    console.error("WenQuanYi PCF fonts failed to load; using browser fallback.", error);
    document.documentElement.dataset.bitmapFont = "fallback";
  }
  requestAnimationFrame(animate);
}

start();
