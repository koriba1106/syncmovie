/**
 * @file SyncClimb Core Engine (Production Release - Complete Video Output & Strict Memory Management)
 * @description 登攀動画の同期、フレーム単位のシーク、クロップ描画、完全な動画録画・メモリ管理を統括するスクリプト。
 * @author 武庫
 * @license Proprietary
 */
(function () {
  "use strict";

  // ===================================================================
  // 0. クリックジャッキング防御 (Frame Busting)
  // ===================================================================
  if (window.self !== window.top) {
    const blockedEl = document.getElementById("frameBlocked");
    const appRoot = document.getElementById("appRoot");
    if (blockedEl) blockedEl.hidden = false;
    if (appRoot) appRoot.hidden = true;
    throw new Error("Frame embedding is blocked for security reasons.");
  }

  // ===================================================================
  // 1. Service Worker 安全登録
  // ===================================================================
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        /* オフラインキャッシュ非対応環境では無視 */
      });
    });
  }

  // ===================================================================
  // 2. 定数定義・セキュリティ＆メモリ上限値
  // ===================================================================
  const CONFIG = Object.freeze({
    OUT_WIDTH: 720,
    OUT_HEIGHT: 1280,
    HALF_WIDTH: 360,
    RECORDING_FPS: 30,
    DEFAULT_SHIFT_STEP: 15,
    VIDEO_BITRATE: 6000000,                        // 6 Mbps
    KEYFRAME_INTERVAL_FRAMES: 60,                  // 2秒間隔でキーフレーム挿入
    MAX_ENCODE_QUEUE: 12,                          // エンコード待ち上限
    MAX_RECORD_BYTES: 750 * 1024 * 1024,           // メモリ保護安全上限 (750MB)
    MAX_INPUT_FILE_BYTES: 2 * 1024 * 1024 * 1024,  // 入力ファイル上限 (2GB)
    MAX_VIDEO_DIMENSION: 8192,                     // 異常解像度防御上限
  });

  // ===================================================================
  // 3. DOM要素参照キャッシュ
  // ===================================================================
  const DOM = {
    statusBar: document.getElementById("statusBar"),
    openInChromeBtn: document.getElementById("openInChromeBtn"),
    headerResetBtn: document.getElementById("headerResetBtn"),
    stepBadge1: document.getElementById("stepBadge1"),
    stepBadge2: document.getElementById("stepBadge2"),
    stepBadge3: document.getElementById("stepBadge3"),
    stepBadge4: document.getElementById("stepBadge4"),

    previewTitle: document.getElementById("previewTitle"),
    emptyState: document.getElementById("emptyState"),
    canvas: document.getElementById("mainCanvas"),
    resultVideo: document.getElementById("resultVideo"),
    canvasHint: document.getElementById("canvasHint"),
    fcL: document.getElementById("fcL"),
    fcR: document.getElementById("fcR"),

    phaseSelect: document.getElementById("phase-select"),
    phaseSetup: document.getElementById("phase-setup"),
    phaseRecord: document.getElementById("phase-record"),
    phaseResult: document.getElementById("phase-result"),

    videoL: document.getElementById("videoL"),
    videoR: document.getElementById("videoR"),
    fileL: document.getElementById("fileL"),
    fileR: document.getElementById("fileR"),
    dropZoneL: document.getElementById("dropZoneL"),
    dropZoneR: document.getElementById("dropZoneR"),
    fileNameL: document.getElementById("fileNameL"),
    fileNameR: document.getElementById("fileNameR"),
    fpsLabelL: document.getElementById("fpsLabelL"),
    fpsLabelR: document.getElementById("fpsLabelR"),
    toSetupBtn: document.getElementById("toSetupBtn"),

    resetOffsetBtn: document.getElementById("resetOffsetBtn"),
    confirmStartBtn: document.getElementById("confirmStartBtn"),
    backToSelectBtn: document.getElementById("backToSelectBtn"),

    pauseLBtn: document.getElementById("pauseLBtn"),
    pauseRBtn: document.getElementById("pauseRBtn"),
    pauseAllBtn: document.getElementById("pauseAllBtn"),
    speedBadge: document.getElementById("speedBadge"),
    speedGroup: document.getElementById("speedGroup"),
    saveEndBtn: document.getElementById("saveEndBtn"),
    discardBtn: document.getElementById("discardBtn"),

    outputFormatBadge: document.getElementById("outputFormatBadge"),
    downloadBtn: document.getElementById("downloadBtn"),
    shareBtn: document.getElementById("shareBtn"),
    backToSetupFromResultBtn: document.getElementById("backToSetupFromResultBtn"),
    restartBtn: document.getElementById("restartBtn"),
  };

  const ctx = DOM.canvas.getContext("2d", { alpha: false, desynchronized: false });

  DOM.resultVideo.style.maxWidth = "100%";
  DOM.resultVideo.style.maxHeight = "62vh";
  DOM.resultVideo.style.borderRadius = "10px";
  DOM.resultVideo.style.background = "#000";

  // ===================================================================
  // 4. アプリケーション状態 (State) & メモリ管理レジストリ
  // ===================================================================
  const state = {
    phase: "select",
    fpsL: 30,
    fpsR: 30,
    offsetL: 0,
    offsetR: 0,
    readyL: false,
    readyR: false,
    pauseL: false,
    pauseR: false,
    pauseAll: false,
    finishedL: false,
    finishedR: false,
    speed: 1.0,
    totalElapsed: 0.0,
    recording: false,
    resultBlob: null,
    resultMime: "",
    resultFilename: "",
  };

  let recorderEngine = null;
  let starting = false;
  let finalizing = false;
  let suspended = false;
  let wakeLock = null;
  let lastKick = 0;
  let rafId = null;
  let lastTs = null;

  /** ObjectURL の一元管理と確実な解放 */
  const objectUrls = { L: null, R: null, result: null };

  function revokeUrl(key) {
    if (objectUrls[key]) {
      try { URL.revokeObjectURL(objectUrls[key]); } catch (_) { /* noop */ }
      objectUrls[key] = null;
    }
  }

  /** 結果データのメモリを完全解放 */
  function releaseResultMemory() {
    try {
      DOM.resultVideo.pause();
      DOM.resultVideo.removeAttribute("src");
      DOM.resultVideo.load();
    } catch (_) { /* noop */ }
    revokeUrl("result");
    state.resultBlob = null;
    state.resultMime = "";
    state.resultFilename = "";
  }

  /** 入力ビデオ要素のデコードバッファを完全解放 */
  function unloadVideoElement(video, sideKey) {
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (_) { /* noop */ }
    revokeUrl(sideKey);
  }

  // ページ破棄時に全リソースを解放
  window.addEventListener("pagehide", () => {
    if (recorderEngine) {
      try { recorderEngine.abort(); } catch (_) { /* noop */ }
      recorderEngine = null;
    }
    releaseWakeLock();
    revokeUrl("L");
    revokeUrl("R");
    revokeUrl("result");
  });

  // ===================================================================
  // 5. Chrome ブラウザ判定 & 安全な誘導処理
  // ===================================================================
  (function initBrowserCheck() {
    const ua = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(ua);
    const isAndroid = /android/.test(ua);
    const isChrome = /crios/.test(ua) || (/chrome/.test(ua) && !/edge|edg|opr|opera|line/.test(ua));

    if ((isIOS || isAndroid) && !isChrome) {
      const cleanUrl = location.host + location.pathname;
      if (isIOS) {
        DOM.openInChromeBtn.href = "googlechrome://" + cleanUrl;
        DOM.openInChromeBtn.hidden = false;
      } else if (isAndroid) {
        DOM.openInChromeBtn.href = "intent://" + cleanUrl + "#Intent;scheme=https;package=com.android.chrome;end";
        DOM.openInChromeBtn.hidden = false;
      }
    }
  })();

  // ===================================================================
  // 6. ユーティリティ関数
  // ===================================================================
  function setStatus(message, isError = false) {
    DOM.statusBar.textContent = String(message || "");
    DOM.statusBar.classList.toggle("error", Boolean(isError));
  }

  const pad2 = (n) => String(Math.floor(Math.max(0, n))).padStart(2, "0");
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  function sanitizeFileNameDisplay(name) {
    const clean = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return clean.length > 48 ? clean.slice(0, 45) + "..." : clean;
  }

  function showPhase(phaseId) {
    state.phase = phaseId;

    DOM.phaseSelect.hidden = phaseId !== "select";
    DOM.phaseSetup.hidden = phaseId !== "setup";
    DOM.phaseRecord.hidden = phaseId !== "record";
    DOM.phaseResult.hidden = phaseId !== "result";

    DOM.stepBadge1.hidden = false;
    DOM.stepBadge2.hidden = phaseId === "select";
    DOM.stepBadge3.hidden = phaseId !== "record" && phaseId !== "result";
    DOM.stepBadge4.hidden = phaseId !== "result";

    DOM.headerResetBtn.hidden = phaseId === "select" || phaseId === "record";

    if (phaseId === "select") {
      const bothReady = state.readyL && state.readyR;
      DOM.emptyState.hidden = bothReady;
      DOM.canvas.hidden = !bothReady;
      DOM.resultVideo.hidden = true;
      DOM.previewTitle.textContent = "比較プレビュー (9:16)";
      if (bothReady) drawStatic();
    } else if (phaseId === "setup" || phaseId === "record") {
      DOM.emptyState.hidden = true;
      DOM.canvas.hidden = false;
      DOM.resultVideo.hidden = true;
      DOM.previewTitle.textContent = phaseId === "record" ? "同期録画プレビュー (REC)" : "開始位置・画角プレビュー";
    } else if (phaseId === "result") {
      DOM.emptyState.hidden = true;
      DOM.canvas.hidden = true;
      DOM.resultVideo.hidden = false;
      DOM.previewTitle.textContent = "完成した比較動画の確認";
    }
  }

  const HAS_WEBCODECS =
    typeof window.VideoEncoder === "function" &&
    typeof window.VideoFrame === "function";
  const HAS_MEDIARECORDER =
    typeof window.MediaRecorder === "function" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function";
  const CAN_RECORD = HAS_WEBCODECS || HAS_MEDIARECORDER;

  if (!CAN_RECORD) {
    setStatus("このブラウザは録画APIに対応していません。Google Chrome をご利用ください。", true);
  }

  window.addEventListener("beforeunload", (e) => {
    if (state.recording) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ===================================================================
  // 7. 動画読み込み・入力検証パイプライン
  // ===================================================================
  function isValidVideoFile(file) {
    if (!file || !(file instanceof File)) return "ファイルが選択されていません。";
    if (file.size <= 0) return "ファイルサイズが0バイトです。";
    if (file.size > CONFIG.MAX_INPUT_FILE_BYTES) return "ファイルサイズが大きすぎます（上限2GB）。";
    const type = String(file.type || "").toLowerCase();
    const extOk = /\.(mp4|mov|webm|m4v|mkv|avi|3gp)$/i.test(file.name || "");
    if (type && !type.startsWith("video/") && !extOk) {
      return "動画ファイル（MP4 / MOV / WebM 等）を選択してください。";
    }
    return null;
  }

  function loadVideoFile(file, video, sideKey) {
    const errMsg = isValidVideoFile(file);
    if (errMsg) {
      setStatus(`${sideKey === "L" ? "左" : "右"}側動画エラー: ${errMsg}`, true);
      return;
    }

    if (sideKey === "L") state.readyL = false;
    else state.readyR = false;
    updateSetupButtonState();

    // 既存ストリームとURLを確実に破棄してから新規割り当て
    unloadVideoElement(video, sideKey);

    const url = URL.createObjectURL(file);
    objectUrls[sideKey] = url;
    video.src = url;

    const labelEl = sideKey === "L" ? DOM.fileNameL : DOM.fileNameR;
    labelEl.textContent = `選択済: ${sanitizeFileNameDisplay(file.name)}`;

    video.addEventListener(
      "loadedmetadata",
      function onMeta() {
        if (
          !video.videoWidth ||
          !video.videoHeight ||
          video.videoWidth > CONFIG.MAX_VIDEO_DIMENSION ||
          video.videoHeight > CONFIG.MAX_VIDEO_DIMENSION
        ) {
          unloadVideoElement(video, sideKey);
          setStatus(`${sideKey === "L" ? "左" : "右"}側動画の解像度が不正または非対応です。`, true);
          return;
        }
        video.currentTime = 0;
      },
      { once: true }
    );
  }

  function bindFileSlot(input, dropZone, video, sideKey) {
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (f) loadVideoFile(f, video, sideKey);
    });

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadVideoFile(f, video, sideKey);
    });

    video.addEventListener("loadeddata", () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        if (sideKey === "L") state.readyL = true;
        else state.readyR = true;
        updateSetupButtonState();
        if (state.readyL && state.readyR) {
          DOM.emptyState.hidden = true;
          DOM.canvas.hidden = false;
          drawStatic();
          setStatus("左右の動画が読み込まれました。「開始位置の調整へ進む」を押してください。");
        } else {
          setStatus(`${sideKey === "L" ? "左" : "右"}側の動画を読み込みました。もう一方の動画も選択してください。`);
        }
      }
    });

    video.addEventListener("error", () => {
      if (!video.getAttribute("src")) return;
      if (sideKey === "L") state.readyL = false;
      else state.readyR = false;
      updateSetupButtonState();
      setStatus(`${sideKey === "L" ? "左側" : "右側"}の動画を読み込めませんでした。別のファイルをお試しください。`, true);
    });
  }

  function updateSetupButtonState() {
    DOM.toSetupBtn.disabled = !(state.readyL && state.readyR);
  }

  bindFileSlot(DOM.fileL, DOM.dropZoneL, DOM.videoL, "L");
  bindFileSlot(DOM.fileR, DOM.dropZoneR, DOM.videoR, "R");

  // FPS 切り替え
  document.querySelectorAll("[data-fps-group]").forEach((group) => {
    const side = group.dataset.fpsGroup;
    const buttons = group.querySelectorAll("button[data-fps]");
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const fps = Number(btn.dataset.fps);
        if (fps !== 30 && fps !== 60) return;

        buttons.forEach((b) => {
          const active = b === btn;
          b.classList.toggle("secondary", active);
          b.setAttribute("aria-pressed", String(active));
        });

        if (side === "L") {
          state.fpsL = fps;
          DOM.fpsLabelL.textContent = `${fps}fps`;
        } else {
          state.fpsR = fps;
          DOM.fpsLabelR.textContent = `${fps}fps`;
        }
        if (state.readyL && state.readyR) drawStatic();
      });
    });
  });

  DOM.toSetupBtn.addEventListener("click", () => {
    if (!state.readyL || !state.readyR) return;
    releaseResultMemory();
    showPhase("setup");
    drawStatic();
    setStatus("コマ送りボタンやプレビューの左右ドラッグで、開始フレームと画角を合わせてください。");
  });

  DOM.backToSelectBtn.addEventListener("click", () => {
    showPhase("select");
    setStatus("動画ファイルやフレームレートを変更できます。");
  });

  // ===================================================================
  // 8. 描画・クロップ演算・タイマーHUD・タッチドラッグ調整
  // ===================================================================
  function drawHalf(video, destX, offsetPx) {
    if (!video || !video.videoWidth || !video.videoHeight) {
      ctx.fillStyle = "#000";
      ctx.fillRect(destX, 0, CONFIG.HALF_WIDTH, CONFIG.OUT_HEIGHT);
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = CONFIG.OUT_HEIGHT / vh;
    const srcHalfW = CONFIG.HALF_WIDTH / scale;

    const maxOffsetPx = Math.max(0, ((vw - srcHalfW) / 2) * scale);
    const clampedOffset = clamp(offsetPx, -maxOffsetPx, maxOffsetPx);
    if (destX === 0) state.offsetL = clampedOffset;
    else state.offsetR = clampedOffset;

    const srcCenter = vw / 2 + clampedOffset / scale;
    let sx = srcCenter - srcHalfW / 2;
    let sx2 = sx + srcHalfW;

    if (sx < 0) {
      sx = 0;
      sx2 = Math.min(srcHalfW, vw);
    } else if (sx2 > vw) {
      sx2 = vw;
      sx = Math.max(0, sx2 - srcHalfW);
    }

    const sw = Math.max(1, sx2 - sx);
    ctx.drawImage(video, sx, 0, sw, vh, destX, 0, CONFIG.HALF_WIDTH, CONFIG.OUT_HEIGHT);
  }

  function drawRoundedRect(x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
    } else {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  function drawTimerHalf(destX, elapsedSec, paused) {
    const e = Math.max(0, Number.isFinite(elapsedSec) ? elapsedSec : 0);
    const m = Math.floor(e / 60);
    const s = Math.floor(e % 60);
    const cs = Math.floor((e * 100) % 100);
    let text = `${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
    if (paused) text += " [停止]";

    ctx.save();
    ctx.font = "700 28px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const tw = ctx.measureText(text).width;
    const th = 38;
    const padX = 14;
    const boxW = tw + padX * 2;
    const cx = destX + CONFIG.HALF_WIDTH / 2;
    const cy = CONFIG.OUT_HEIGHT - 90;

    ctx.fillStyle = paused ? "rgba(158, 57, 57, 0.88)" : "rgba(38, 49, 38, 0.78)";
    drawRoundedRect(cx - boxW / 2, cy - th / 2, boxW, th, 8);
    ctx.fill();

    ctx.strokeStyle = paused ? "rgba(255, 180, 180, 0.55)" : "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = paused ? "#FFE4E4" : "#FFFFFF";
    ctx.fillText(text, cx, cy);
    ctx.restore();
  }

  function updateFrameBadges() {
    const tL = Number.isFinite(DOM.videoL.currentTime) ? DOM.videoL.currentTime : 0;
    const tR = Number.isFinite(DOM.videoR.currentTime) ? DOM.videoR.currentTime : 0;
    const fL = Math.round(tL * state.fpsL);
    const fR = Math.round(tR * state.fpsR);
    DOM.fcL.textContent = `左: ${fL}f (${tL.toFixed(2)}s)`;
    DOM.fcR.textContent = `右: ${fR}f (${tR.toFixed(2)}s)`;
  }

  function drawStatic() {
    ctx.clearRect(0, 0, CONFIG.OUT_WIDTH, CONFIG.OUT_HEIGHT);
    drawHalf(DOM.videoL, 0, state.offsetL);
    drawHalf(DOM.videoR, CONFIG.HALF_WIDTH, state.offsetR);

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(CONFIG.HALF_WIDTH - 1, 0, 2, CONFIG.OUT_HEIGHT);

    drawTimerHalf(0, 0.0, true);
    drawTimerHalf(CONFIG.HALF_WIDTH, 0.0, true);

    updateFrameBadges();
  }

  DOM.videoL.addEventListener("seeked", () => {
    if (state.phase === "setup" || state.phase === "select") drawStatic();
  });
  DOM.videoR.addEventListener("seeked", () => {
    if (state.phase === "setup" || state.phase === "select") drawStatic();
  });

  function stepFrames(video, frames, fps) {
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const target = clamp(video.currentTime + frames / fps, 0, Math.max(0, video.duration - 0.001));
    video.currentTime = target;
  }

  document.querySelectorAll("button[data-frames]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const side = btn.dataset.side;
      const frames = Number(btn.dataset.frames);
      if (!Number.isFinite(frames)) return;
      if (side === "L") stepFrames(DOM.videoL, frames, state.fpsL);
      else stepFrames(DOM.videoR, frames, state.fpsR);
    });
  });

  document.querySelectorAll("button[data-offset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const side = btn.dataset.side;
      const d = Number(btn.dataset.offset);
      if (!Number.isFinite(d)) return;
      if (side === "L") state.offsetL += d;
      else state.offsetR += d;
      if (state.phase === "setup" || state.phase === "select") drawStatic();
    });
  });

  DOM.resetOffsetBtn.addEventListener("click", () => {
    state.offsetL = 0;
    state.offsetR = 0;
    if (state.phase === "setup" || state.phase === "select") drawStatic();
    setStatus("左右の横表示位置を中央にリセットしました。");
  });

  (function initCanvasDrag() {
    let draggingSide = null;
    let startX = 0;
    let initialOffset = 0;

    DOM.canvas.addEventListener("pointerdown", (e) => {
      if (state.phase !== "setup" && state.phase !== "record" && state.phase !== "select") return;
      const rect = DOM.canvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      const relX = e.clientX - rect.left;
      draggingSide = relX < rect.width / 2 ? "L" : "R";
      startX = e.clientX;
      initialOffset = draggingSide === "L" ? state.offsetL : state.offsetR;
      DOM.canvas.setPointerCapture(e.pointerId);
    });

    DOM.canvas.addEventListener("pointermove", (e) => {
      if (!draggingSide) return;
      const rect = DOM.canvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      const scaleX = CONFIG.OUT_WIDTH / rect.width;
      const deltaCanvasPx = (e.clientX - startX) * scaleX;
      const nextOffset = initialOffset - deltaCanvasPx;
      if (draggingSide === "L") state.offsetL = nextOffset;
      else state.offsetR = nextOffset;
      if (state.phase === "setup" || state.phase === "select") drawStatic();
    });

    const endDrag = (e) => {
      if (!draggingSide) return;
      draggingSide = null;
      try { DOM.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
    };
    DOM.canvas.addEventListener("pointerup", endDrag);
    DOM.canvas.addEventListener("pointercancel", endDrag);
  })();

  // ===================================================================
  // 9. 録画エンジン (完全出力保証 & ゼロコピーメモリ管理)
  // ===================================================================
  DOM.confirmStartBtn.addEventListener("click", startRecording);

  // -------------------------------------------------------------------
  // 9-1. MP4 マルチプレクサ (ゼロコピー Blob 構築・PTS単調増加保証)
  // -------------------------------------------------------------------
  const Mp4Muxer = (function () {
    const MEDIA_TIMESCALE = 90000;
    const MOVIE_TIMESCALE = 1000;

    const ascii = (s) => {
      const a = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
      return a;
    };
    const concat = (parts) => {
      let n = 0;
      for (const p of parts) n += p.length;
      const out = new Uint8Array(n);
      let k = 0;
      for (const p of parts) { out.set(p, k); k += p.length; }
      return out;
    };
    const zeros = (n) => new Uint8Array(n);
    const u8 = (...v) => Uint8Array.from(v);
    const u16 = (...v) => {
      const b = new Uint8Array(v.length * 2);
      const dv = new DataView(b.buffer);
      for (let i = 0; i < v.length; i++) dv.setUint16(i * 2, v[i] & 0xffff);
      return b;
    };
    const u32arr = (arr) => {
      const b = new Uint8Array(arr.length * 4);
      const dv = new DataView(b.buffer);
      for (let i = 0; i < arr.length; i++) dv.setUint32(i * 4, arr[i] >>> 0);
      return b;
    };
    const u32 = (...v) => u32arr(v);
    const box = (type, ...parts) => {
      const body = concat(parts);
      const out = new Uint8Array(8 + body.length);
      new DataView(out.buffer).setUint32(0, out.length);
      out.set(ascii(type), 4);
      out.set(body, 8);
      return out;
    };
    const fullBox = (type, version, flags, ...parts) =>
      box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...parts);

    const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

    function buildMoov(p) {
      const mvhd = fullBox("mvhd", 0, 0,
        u32(p.now, p.now, MOVIE_TIMESCALE, p.durMovie),
        u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));

      const tkhd = fullBox("tkhd", 0, 3,
        u32(p.now, p.now, 1, 0, p.durMovie),
        zeros(8), u16(0, 0, 0, 0), MATRIX,
        u32(p.width * 65536, p.height * 65536));

      const mdhd = fullBox("mdhd", 0, 0,
        u32(p.now, p.now, MEDIA_TIMESCALE, p.durMedia), u16(0x55c4, 0));

      const hdlr = fullBox("hdlr", 0, 0,
        u32(0), ascii("vide"), zeros(12), ascii("VideoHandler"), u8(0));

      const vmhd = fullBox("vmhd", 0, 1, u16(0, 0, 0, 0));
      const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));

      const avc1 = box("avc1",
        zeros(6), u16(1), u16(0, 0), zeros(12),
        u16(p.width, p.height), u32(0x00480000, 0x00480000), u32(0),
        u16(1), zeros(32), u16(0x0018, 0xffff),
        box("avcC", p.avcC));
      const stsd = fullBox("stsd", 0, 0, u32(1), avc1);

      const sttsFlat = [];
      for (const r of p.runs) sttsFlat.push(r[0], r[1]);
      const stts = fullBox("stts", 0, 0, u32(p.runs.length), u32arr(sttsFlat));
      const stss = fullBox("stss", 0, 0, u32(p.keys.length), u32arr(p.keys));
      const stsc = fullBox("stsc", 0, 0, u32(1, 1, p.sizes.length, 1));
      const stsz = fullBox("stsz", 0, 0, u32(0, p.sizes.length), u32arr(p.sizes));
      const stco = fullBox("stco", 0, 0, u32(1, p.offset));

      const stbl = box("stbl", stsd, stts, stss, stsc, stsz, stco);
      const minf = box("minf", vmhd, dinf, stbl);
      const mdia = box("mdia", mdhd, hdlr, minf);
      const trak = box("trak", tkhd, mdia);
      return box("moov", mvhd, trak);
    }

    /**
     * @param {{buffer:ArrayBuffer, ts:number, key:boolean}[]} samplesIn
     * @param {Uint8Array} avcC
     * @param {number} endUs
     * @param {number} width
     * @param {number} height
     */
    function mux(samplesIn, avcC, endUs, width, height) {
      let start = 0;
      while (start < samplesIn.length && !samplesIn[start].key) start++;
      if (start >= samplesIn.length) throw new Error("no key frame");

      const n = samplesIn.length - start;
      // タイムスタンプ（マイクロ秒）を単調増加で正規化
      const ts0 = samplesIn[start].ts;
      const dts = new Int32Array(n);
      let prev = -1;
      for (let i = 0; i < n; i++) {
        const s = samplesIn[start + i];
        let d = Math.round(((s.ts - ts0) * MEDIA_TIMESCALE) / 1e6);
        if (d <= prev) d = prev + 300; // 最低でも約3.3ms前進させ0尺フレームを防止
        dts[i] = d;
        prev = d;
      }

      const defaultFrameTicks = Math.round(MEDIA_TIMESCALE / CONFIG.RECORDING_FPS);
      let lastDur = Math.round(((endUs - ts0) * MEDIA_TIMESCALE) / 1e6) - dts[n - 1];
      if (lastDur < defaultFrameTicks) lastDur = defaultFrameTicks;

      const runs = [];
      const sizes = new Uint32Array(n);
      const keys = [];
      let payloadBytes = 0;

      for (let i = 0; i < n; i++) {
        const s = samplesIn[start + i];
        const delta = i < n - 1 ? Math.max(1, dts[i + 1] - dts[i]) : lastDur;
        const lastRun = runs[runs.length - 1];
        if (lastRun && lastRun[1] === delta) lastRun[0]++;
        else runs.push([1, delta]);

        const byteLen = s.buffer.byteLength;
        sizes[i] = byteLen;
        payloadBytes += byteLen;
        if (s.key) keys.push(i + 1);
      }

      const durMedia = dts[n - 1] + lastDur;
      const durMovie = Math.max(1, Math.round((durMedia * MOVIE_TIMESCALE) / MEDIA_TIMESCALE));
      if (payloadBytes + 8 > 0xffffffff) throw new Error("MP4 payload exceeds 4GB limit");

      const ftyp = box("ftyp", ascii("isom"), u32(512),
        ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
      const params = {
        now: Math.floor(Date.now() / 1000) + 2082844800,
        width, height, avcC, runs, keys, sizes, durMedia, durMovie, offset: 0,
      };
      const moovLen = buildMoov(params).length;
      params.offset = ftyp.length + moovLen + 8;
      const moov = buildMoov(params);
      const mdatHeader = concat([u32(payloadBytes + 8), ascii("mdat")]);

      // ゼロコピーでBlobパーツ配列を構築し、元のsamplesInの参照を順次解放してメモリピークを抑える
      const blobParts = new Array(3 + n);
      blobParts[0] = ftyp.buffer;
      blobParts[1] = moov.buffer;
      blobParts[2] = mdatHeader.buffer;
      for (let i = 0; i < n; i++) {
        blobParts[3 + i] = samplesIn[start + i].buffer;
        samplesIn[start + i].buffer = null;
      }
      samplesIn.length = 0;

      return new Blob(blobParts, { type: "video/mp4" });
    }

    return { mux };
  })();

  // -------------------------------------------------------------------
  // 9-2. WebM Duration Injector (MediaRecorderフォールバック時の尺欠落修正)
  // -------------------------------------------------------------------
  const WebmDurationPatcher = (function () {
    function readVint(buf, pos, maskLength) {
      if (pos >= buf.length) return null;
      const b0 = buf[pos];
      if (b0 === 0) return null;
      let len = 1;
      let mask = 0x80;
      while (len <= 8 && (b0 & mask) === 0) {
        len++;
        mask >>= 1;
      }
      if (len > 8 || pos + len > buf.length) return null;
      let val = maskLength ? (b0 & (mask - 1)) : b0;
      for (let i = 1; i < len; i++) {
        val = val * 256 + buf[pos + i];
      }
      return { value: val, length: len };
    }

    /**
     * WebM 先頭チャンク内の Segment > Info (0x1549A966) を探し、
     * Duration (0x4489, float64) エレメントが未設定なら直接挿入または上書きする
     */
    async function patchWebmBlob(chunks, durationMs, mimeType) {
      if (!chunks || !chunks.length || !Number.isFinite(durationMs) || durationMs <= 0) {
        return new Blob(chunks, { type: mimeType });
      }
      try {
        const firstSlice = chunks[0].slice(0, Math.min(chunks[0].size, 65536));
        const head = new Uint8Array(await firstSlice.arrayBuffer());

        // Info ID: 0x15 0x49 0xA9 0x66 を探索
        let infoPos = -1;
        for (let i = 0; i + 12 < head.length; i++) {
          if (
            head[i] === 0x15 &&
            head[i + 1] === 0x49 &&
            head[i + 2] === 0xa9 &&
            head[i + 3] === 0x66
          ) {
            infoPos = i;
            break;
          }
        }
        if (infoPos < 0) return new Blob(chunks, { type: mimeType });

        const sizeVint = readVint(head, infoPos + 4, true);
        if (!sizeVint) return new Blob(chunks, { type: mimeType });

        const infoDataStart = infoPos + 4 + sizeVint.length;
        const infoDataEnd = Math.min(head.length, infoDataStart + sizeVint.value);

        // Info 内を走査して既存の Duration (0x4489) または TimecodeScale (0x2AD7B1) を確認
        let p = infoDataStart;
        while (p < infoDataEnd) {
          const idV = readVint(head, p, false);
          if (!idV) break;
          const szV = readVint(head, p + idV.length, true);
          if (!szV) break;
          const elemDataPos = p + idV.length + szV.length;

          // 既に Duration (0x4489) が8バイトで存在する場合はその場を上書き
          if (idV.value === 0x4489 && szV.value === 8 && elemDataPos + 8 <= head.length) {
            const patchedHead = head.slice();
            new DataView(patchedHead.buffer).setFloat64(elemDataPos, durationMs, false);
            const restFirst = chunks[0].slice(patchedHead.length);
            return new Blob([patchedHead.buffer, restFirst, ...chunks.slice(1)], { type: mimeType });
          }
          p = elemDataPos + szV.value;
        }

        // Info のサイズが既知長（all-ones の unknown size でない）なら Duration 要素 (11 bytes) を Info 末尾に注入
        const rawSizeByte = head[infoPos + 4];
        const isUnknownSize = (sizeVint.length === 1 && rawSizeByte === 0xff) ||
                              (sizeVint.length === 8 && sizeVint.value >= 0x00ffffffffffff);
        if (!isUnknownSize && infoDataEnd <= head.length) {
          const durElem = new Uint8Array(11);
          durElem[0] = 0x44;
          durElem[1] = 0x89;
          durElem[2] = 0x88; // size = 8
          new DataView(durElem.buffer).setFloat64(3, durationMs, false);

          const newInfoSize = sizeVint.value + 11;
          // 4バイトVINT (0x10000000 | size) で Info サイズを安全に再エンコード
          const newSizeBytes = new Uint8Array(4);
          new DataView(newSizeBytes.buffer).setUint32(0, (0x10000000 | (newInfoSize & 0x0fffffff)) >>> 0, false);

          const beforeInfoSize = head.subarray(0, infoPos + 4);
          const infoBody = head.subarray(infoDataStart, infoDataEnd);
          const afterInfo = head.subarray(infoDataEnd);
          const restFirst = chunks[0].slice(head.length);

          return new Blob(
            [beforeInfoSize, newSizeBytes, infoBody, durElem, afterInfo, restFirst, ...chunks.slice(1)],
            { type: mimeType }
          );
        }
      } catch (_) {
        /* パッチ失敗時は無加工で返す */
      }
      return new Blob(chunks, { type: mimeType });
    }

    return { patchWebmBlob };
  })();

  // -------------------------------------------------------------------
  // 9-3. 録画エンジン共通ユーティリティ
  // -------------------------------------------------------------------
  const withTimeout = (promise, ms, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + " timeout")), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });

  const toU8 = (d) =>
    d instanceof ArrayBuffer
      ? new Uint8Array(d)
      : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);

  // -------------------------------------------------------------------
  // 9-4. 主録画エンジン：WebCodecs (H.264) + MP4出力
  //   ・Bフレームを生まない Baseline / Constrained Baseline を最優先してタイムスタンプ逆転を防止
  //   ・キーフレームごとに送出される description の軽微な差異で録画を中断しない堅牢設計
  //   ・万一最初の3秒未満でWebCodecsエンコーダがクラッシュした場合は同時待機中のバックアップへシームレス移行
  // -------------------------------------------------------------------
  const AVC_PROFILES = [
    "avc1.42E028", // Constrained Baseline Level 4.0 (Bフレームなし・最も安定)
    "avc1.420028", // Baseline Level 4.0 (Bフレームなし)
    "avc1.42E01F", // Constrained Baseline Level 3.1
    "avc1.4D0028", // Main Level 4.0
    "avc1.640028", // High Level 4.0
  ];

  function buildEncoderConfig(codec, hwPref) {
    return {
      codec,
      width: CONFIG.OUT_WIDTH,
      height: CONFIG.OUT_HEIGHT,
      bitrate: CONFIG.VIDEO_BITRATE,
      framerate: CONFIG.RECORDING_FPS,
      hardwareAcceleration: hwPref || "no-preference",
      latencyMode: "realtime",
      avc: { format: "avc" },
    };
  }

  async function probeCodecConfig(cfg) {
    let enc = null;
    try {
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (!sup || !sup.supported) return false;

      let outputs = 0;
      let hasDesc = false;
      let failed = false;
      enc = new VideoEncoder({
        output: (_chunk, meta) => {
          outputs++;
          if (meta && meta.decoderConfig && meta.decoderConfig.description) hasDesc = true;
        },
        error: () => { failed = true; },
      });
      enc.configure(cfg);
      // キーフレームまたぎ（description再送出）を含めて検証
      for (let i = 0; i < 4; i++) {
        const f = new VideoFrame(DOM.canvas, { timestamp: i * 33333 });
        try { enc.encode(f, { keyFrame: i === 0 || i === 2 }); } finally { f.close(); }
      }
      await withTimeout(enc.flush(), 5000, "probe flush");
      return !failed && outputs >= 3 && hasDesc;
    } catch (_) {
      return false;
    } finally {
      try { if (enc && enc.state !== "closed") enc.close(); } catch (_) { /* noop */ }
    }
  }

  async function createWebCodecsEngine() {
    const candidateConfigs = [];
    for (const c of AVC_PROFILES) {
      candidateConfigs.push(buildEncoderConfig(c, "no-preference"));
      candidateConfigs.push(buildEncoderConfig(c, "prefer-software"));
    }

    let chosenIdx = -1;
    for (let i = 0; i < candidateConfigs.length; i++) {
      if (await probeCodecConfig(candidateConfigs[i])) {
        chosenIdx = i;
        break;
      }
    }
    if (chosenIdx < 0) return null;

    const configsOrder = [
      candidateConfigs[chosenIdx],
      ...candidateConfigs.filter((_, idx) => idx !== chosenIdx),
    ];

    const FRAME_MIN_MS = 1000 / CONFIG.RECORDING_FPS - 2.5;
    const FRAME_US = Math.round(1e6 / CONFIG.RECORDING_FPS);

    const samples = [];
    let totalBytes = 0;
    let description = null;
    let encoder = null;
    let cfgIdx = 0;
    let restarts = 0;
    let awaitKey = true;
    let needKey = true;
    let accepting = true;
    let truncated = false;
    let closed = false;
    let t0 = null;
    let pausedTotal = 0;
    let suspendedAt = null;
    let lastEncRel = -1e9;
    let lastTsUs = -1;
    let frameCount = 0;

    const engine = { kind: "webcodecs", onFatal: null };

    function giveUp() {
      accepting = false;
      truncated = true;
      if (engine.onFatal) {
        engine.onFatal("録画エンコーダーでエラーが発生しました。ここまでの内容を保存します。");
      }
    }

    function onOutput(enc, chunk, meta) {
      if (closed || enc !== encoder || !accepting) return;

      const d = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (d) {
        const u = toU8(d);
        // 有効な avcC (configurationVersion === 1) の場合のみ採用
        if (u.byteLength >= 7 && u[0] === 1) {
          if (!description) {
            description = u.slice();
          }
          // 【重要修正】キーフレームごとにエンコーダが再送出する description の微差で
          // giveUp() を呼ばない。同一エンコーダセッション中は最初の avcC または最新の有効な avcC を維持する。
        }
      }

      if (!description) return;
      if (awaitKey) {
        if (chunk.type !== "key") return;
        awaitKey = false;
      }

      // ゼロコピー用 ArrayBuffer として直接確保
      const ab = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(ab);
      samples.push({ buffer: ab, ts: chunk.timestamp, key: chunk.type === "key" });
      totalBytes += ab.byteLength;
    }

    function openEncoder() {
      const enc = new VideoEncoder({
        output: (chunk, meta) => onOutput(enc, chunk, meta),
        error: (err) => {
          console.warn("VideoEncoder error:", err);
          if (enc === encoder) recover();
        },
      });
      enc.configure(configsOrder[cfgIdx]);
      encoder = enc;
      awaitKey = true;
      needKey = true;
    }

    function recover() {
      if (closed || !accepting) return;
      try { if (encoder && encoder.state !== "closed") encoder.close(); } catch (_) { /* noop */ }
      encoder = null;
      if (restarts >= 4) { giveUp(); return; }
      restarts++;
      // まだサンプルが少ない（または同一構成で失敗した）場合はソフトウェアエンコーダ等へ切り替え
      if (samples.length < 15 && cfgIdx + 1 < configsOrder.length) {
        samples.length = 0;
        totalBytes = 0;
        description = null;
        cfgIdx++;
      }
      try { openEncoder(); } catch (_) { giveUp(); }
    }

    function relNow(nowMs) {
      if (t0 === null) t0 = nowMs;
      const ref = suspendedAt !== null ? suspendedAt : nowMs;
      return Math.max(0, ref - t0 - pausedTotal);
    }

    openEncoder();

    engine.start = (nowMs) => { t0 = nowMs; };

    engine.addFrame = (nowMs, force) => {
      if (closed || !accepting || suspendedAt !== null || !encoder) return;
      const rel = relNow(nowMs);
      if (force) {
        if (rel - lastEncRel < 4) return;
      } else if (frameCount > 0 && rel - lastEncRel < FRAME_MIN_MS) {
        return;
      }
      if (encoder.state !== "configured") { recover(); return; }
      if (encoder.encodeQueueSize > CONFIG.MAX_ENCODE_QUEUE) return;

      let tsUs = Math.round(rel * 1000);
      if (tsUs <= lastTsUs) tsUs = lastTsUs + 1000;

      let frame = null;
      try {
        frame = new VideoFrame(DOM.canvas, { timestamp: tsUs });
        const isKey = needKey || frameCount % CONFIG.KEYFRAME_INTERVAL_FRAMES === 0;
        encoder.encode(frame, { keyFrame: isKey });
        needKey = false;
        frameCount++;
        lastEncRel = rel;
        lastTsUs = tsUs;
      } catch (_) {
        recover();
      } finally {
        if (frame) {
          try { frame.close(); } catch (_) { /* noop */ }
        }
      }
    };

    engine.suspend = (nowMs) => {
      if (suspendedAt === null) suspendedAt = nowMs;
    };
    engine.resume = (nowMs) => {
      if (suspendedAt !== null) {
        pausedTotal += Math.max(0, nowMs - suspendedAt);
        suspendedAt = null;
      }
    };
    engine.bytes = () => totalBytes;

    engine.finish = async (nowMs) => {
      if (!closed) {
        try { engine.addFrame(nowMs, true); } catch (_) { /* noop */ }
        try {
          if (encoder && encoder.state === "configured") {
            await withTimeout(encoder.flush(), 12000, "flush");
          }
        } catch (_) {
          truncated = true;
        }
      }
      const endRel = relNow(nowMs);
      closed = true;
      try { if (encoder && encoder.state !== "closed") encoder.close(); } catch (_) { /* noop */ }
      encoder = null;

      if (!samples.length || !description) {
        samples.length = 0;
        totalBytes = 0;
        return null;
      }

      const lastUs = samples[samples.length - 1].ts;
      const endUs = Math.max(Math.round(endRel * 1000), lastUs + FRAME_US);
      const blob = Mp4Muxer.mux(samples, description, endUs, CONFIG.OUT_WIDTH, CONFIG.OUT_HEIGHT);
      totalBytes = 0;
      description = null;
      return { blob, mimeType: "video/mp4", truncated };
    };

    engine.abort = () => {
      closed = true;
      accepting = false;
      try { if (encoder && encoder.state !== "closed") encoder.close(); } catch (_) { /* noop */ }
      encoder = null;
      for (let i = 0; i < samples.length; i++) samples[i].buffer = null;
      samples.length = 0;
      totalBytes = 0;
      description = null;
    };

    return engine;
  }

  // -------------------------------------------------------------------
  // 9-5. 予備録画エンジン：MediaRecorder (明示的フレーム供給 + WebM尺パッチ)
  //   ・captureStream(0) + requestFrame() により、描画完了フレームを1フレームも漏らさず供給
  //   ・完了時に WebM Duration ヘッダをバイナリ注入し、どのプレイヤーでも全長を認識させる
  // -------------------------------------------------------------------
  function pickMimeType() {
    const candidates = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=avc1.4D0028",
      "video/mp4",
      "video/webm;codecs=vp8",
      "video/webm;codecs=vp9",
      "video/webm",
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "";
  }

  function createMediaRecorderEngine() {
    if (!HAS_MEDIARECORDER) throw new Error("MediaRecorder unsupported");

    // captureStream(0) が使える環境では手動 requestFrame() で正確にフレーム供給
    let stream = null;
    let videoTrack = null;
    let canRequestFrame = false;
    try {
      stream = DOM.canvas.captureStream(0);
      videoTrack = stream.getVideoTracks()[0] || null;
      canRequestFrame = Boolean(videoTrack && typeof videoTrack.requestFrame === "function");
    } catch (_) {
      stream = null;
    }
    if (!stream || !canRequestFrame) {
      if (stream) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
      }
      stream = DOM.canvas.captureStream(CONFIG.RECORDING_FPS);
      videoTrack = stream.getVideoTracks()[0] || null;
      canRequestFrame = false;
    }

    const mime = pickMimeType();
    let rec = null;
    try {
      const opts = { videoBitsPerSecond: CONFIG.VIDEO_BITRATE };
      if (mime) opts.mimeType = mime;
      rec = new MediaRecorder(stream, opts);
    } catch (_) {
      rec = new MediaRecorder(stream);
    }

    const FRAME_MIN_MS = 1000 / CONFIG.RECORDING_FPS - 2.5;
    const chunks = [];
    let totalBytes = 0;
    let discard = false;
    let t0 = null;
    let pausedTotal = 0;
    let suspendedAt = null;
    let lastFrameRel = -1e9;
    let stopResolve = null;
    const stopped = new Promise((resolve) => { stopResolve = resolve; });
    const engine = { kind: "mediarecorder", onFatal: null };

    rec.ondataavailable = (e) => {
      if (!discard && e.data && e.data.size > 0) {
        chunks.push(e.data);
        totalBytes += e.data.size;
      }
    };
    rec.onstop = () => stopResolve();
    rec.onerror = () => {
      if (engine.onFatal) engine.onFatal("録画中にエラーが発生しました。ここまでの内容を保存します。");
    };

    const releaseStream = () => {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
      videoTrack = null;
    };

    function relNow(nowMs) {
      if (t0 === null) t0 = nowMs;
      const ref = suspendedAt !== null ? suspendedAt : nowMs;
      return Math.max(0, ref - t0 - pausedTotal);
    }

    engine.start = (nowMs) => {
      t0 = nowMs;
      rec.start(1000);
    };

    engine.addFrame = (nowMs, force) => {
      if (discard || suspendedAt !== null) return;
      const rel = relNow(nowMs);
      if (!force && rel - lastFrameRel < FRAME_MIN_MS) return;
      lastFrameRel = rel;
      if (canRequestFrame && videoTrack) {
        try { videoTrack.requestFrame(); } catch (_) { /* noop */ }
      }
    };

    engine.suspend = (nowMs) => {
      if (suspendedAt === null) suspendedAt = nowMs;
      try { if (rec.state === "recording") rec.pause(); } catch (_) { /* noop */ }
    };

    engine.resume = (nowMs) => {
      if (suspendedAt !== null) {
        pausedTotal += Math.max(0, nowMs - suspendedAt);
        suspendedAt = null;
      }
      try { if (rec.state === "paused") rec.resume(); } catch (_) { /* noop */ }
    };

    engine.bytes = () => totalBytes;

    engine.finish = async (nowMs) => {
      try { engine.addFrame(nowMs, true); } catch (_) { /* noop */ }
      const durationMs = Math.max(100, relNow(nowMs));

      if (rec.state !== "inactive") {
        try { rec.requestData(); } catch (_) { /* noop */ }
        try { rec.stop(); } catch (_) { stopResolve(); }
      } else {
        stopResolve();
      }
      try { await withTimeout(stopped, 8000, "stop"); } catch (_) { /* noop */ }
      releaseStream();

      if (discard || !chunks.length) {
        chunks.length = 0;
        totalBytes = 0;
        return null;
      }

      const type = rec.mimeType || mime || "video/webm";
      let blob = null;
      if (type.includes("webm")) {
        blob = await WebmDurationPatcher.patchWebmBlob(chunks, durationMs, type);
      } else {
        blob = new Blob(chunks, { type });
      }
      chunks.length = 0;
      totalBytes = 0;
      return { blob, mimeType: type, truncated: false };
    };

    engine.abort = () => {
      discard = true;
      try { if (rec.state !== "inactive") rec.stop(); } catch (_) { /* noop */ }
      releaseStream();
      chunks.length = 0;
      totalBytes = 0;
    };

    return engine;
  }

  async function createRecorderEngine() {
    if (HAS_WEBCODECS) {
      try {
        const eng = await createWebCodecsEngine();
        if (eng) return eng;
      } catch (_) {
        /* fallback */
      }
    }
    return createMediaRecorderEngine();
  }

  // WakeLock (画面スリープ防止)
  async function acquireWakeLock() {
    try {
      if (!("wakeLock" in navigator) || wakeLock) return;
      const lock = await navigator.wakeLock.request("screen");
      wakeLock = lock;
      lock.addEventListener("release", () => {
        if (wakeLock === lock) wakeLock = null;
      });
    } catch (_) { /* noop */ }
  }

  function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  function suspendRecording() {
    if (!state.recording || suspended) return;
    suspended = true;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    DOM.videoL.pause();
    DOM.videoR.pause();
    if (recorderEngine) recorderEngine.suspend(performance.now());
  }

  function resumeRecording() {
    if (!state.recording || !suspended) return;
    suspended = false;
    acquireWakeLock();
    lastTs = null;
    if (recorderEngine) recorderEngine.resume(performance.now());
    syncPlaybackState();
    lastKick = performance.now();
    rafId = requestAnimationFrame(recordLoop);
    setStatus("画面復帰に伴い、録画を再開しました。");
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) suspendRecording();
    else resumeRecording();
  });

  DOM.videoL.addEventListener("ended", () => { if (state.recording) state.finishedL = true; });
  DOM.videoR.addEventListener("ended", () => { if (state.recording) state.finishedR = true; });

  async function startRecording() {
    if (state.recording || starting || finalizing) return;
    if (!CAN_RECORD) {
      setStatus("このブラウザでは録画を開始できません。Google Chrome をお試しください。", true);
      return;
    }

    // 前回の出力結果が残っていれば確実にメモリ解放してから開始
    releaseResultMemory();

    starting = true;
    DOM.confirmStartBtn.disabled = true;
    setStatus("録画エンジンを初期化しています…");

    let engine = null;
    try {
      engine = await createRecorderEngine();
    } catch (err) {
      starting = false;
      DOM.confirmStartBtn.disabled = false;
      setStatus("録画を開始できませんでした: " + (err && err.message ? err.message : "不明なエラー"), true);
      return;
    }

    state.pauseL = false;
    state.pauseR = false;
    state.pauseAll = false;
    state.finishedL = false;
    state.finishedR = false;
    state.totalElapsed = 0;
    state.speed = 1.0;

    DOM.pauseLBtn.classList.remove("secondary");
    DOM.pauseLBtn.textContent = "左を一時停止 [HOLD]";
    DOM.pauseRBtn.classList.remove("secondary");
    DOM.pauseRBtn.textContent = "右を一時停止 [HOLD]";
    DOM.pauseAllBtn.classList.remove("secondary");
    DOM.pauseAllBtn.textContent = "⏸ 全体を一時停止";
    DOM.speedBadge.textContent = "1.0x";

    DOM.speedGroup.querySelectorAll("button[data-speed]").forEach((b) => {
      b.classList.toggle("secondary", b.dataset.speed === "1.0");
    });

    engine.onFatal = (msg) => {
      setStatus(msg, true);
      if (state.recording) finishRecording(false);
    };

    suspended = false;
    recorderEngine = engine;
    showPhase("record");

    try {
      const startNow = performance.now();
      engine.start(startNow);
      // 開始直後の先頭フレームを即座に描画・記録
      ctx.clearRect(0, 0, CONFIG.OUT_WIDTH, CONFIG.OUT_HEIGHT);
      drawHalf(DOM.videoL, 0, state.offsetL);
      drawHalf(DOM.videoR, CONFIG.HALF_WIDTH, state.offsetR);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(CONFIG.HALF_WIDTH - 1, 0, 2, CONFIG.OUT_HEIGHT);
      drawTimerHalf(0, 0, false);
      drawTimerHalf(CONFIG.HALF_WIDTH, 0, false);
      engine.addFrame(startNow, true);
    } catch (err) {
      try { engine.abort(); } catch (_) { /* noop */ }
      recorderEngine = null;
      starting = false;
      DOM.confirmStartBtn.disabled = false;
      showPhase("setup");
      drawStatic();
      setStatus("録画を開始できませんでした: " + (err && err.message ? err.message : "不明なエラー"), true);
      return;
    }

    setStatus("同期比較動画を録画中です。片側ずつの一時停止や速度変更が可能です。");

    DOM.videoL.playbackRate = 1.0;
    DOM.videoR.playbackRate = 1.0;
    DOM.videoL.play().catch(() => {});
    DOM.videoR.play().catch(() => {});

    state.recording = true;
    starting = false;
    lastTs = null;
    lastKick = performance.now();
    acquireWakeLock();
    rafId = requestAnimationFrame(recordLoop);
  }

  function recordLoop(ts) {
    if (!state.recording || suspended) return;

    if (lastTs === null) lastTs = ts;
    const dt = Math.max(0, (ts - lastTs) / 1000);
    lastTs = ts;

    if (!state.pauseAll) {
      state.totalElapsed += dt;
    }

    if (DOM.videoL.ended) state.finishedL = true;
    if (DOM.videoR.ended) state.finishedR = true;

    ctx.clearRect(0, 0, CONFIG.OUT_WIDTH, CONFIG.OUT_HEIGHT);
    drawHalf(DOM.videoL, 0, state.offsetL);
    drawHalf(DOM.videoR, CONFIG.HALF_WIDTH, state.offsetR);

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(CONFIG.HALF_WIDTH - 1, 0, 2, CONFIG.OUT_HEIGHT);

    drawTimerHalf(0, state.totalElapsed, state.pauseL || state.finishedL);
    drawTimerHalf(CONFIG.HALF_WIDTH, state.totalElapsed, state.pauseR || state.finishedR);

    updateFrameBadges();

    if (recorderEngine) recorderEngine.addFrame(ts, false);

    if (state.finishedL && state.finishedR) {
      finishRecording(false);
      return;
    }

    if (recorderEngine && recorderEngine.bytes() > CONFIG.MAX_RECORD_BYTES) {
      setStatus("録画データがメモリ保護上限に達したため、ここで保存します。", true);
      finishRecording(false);
      return;
    }

    if (ts - lastKick >= 500) {
      lastKick = ts;
      syncPlaybackState();
    }

    rafId = requestAnimationFrame(recordLoop);
  }

  function syncPlaybackState() {
    const wantPlayL = !state.pauseAll && !state.pauseL && !state.finishedL;
    const wantPlayR = !state.pauseAll && !state.pauseR && !state.finishedR;

    if (wantPlayL && DOM.videoL.paused) DOM.videoL.play().catch(() => {});
    if (!wantPlayL && !DOM.videoL.paused) DOM.videoL.pause();

    if (wantPlayR && DOM.videoR.paused) DOM.videoR.play().catch(() => {});
    if (!wantPlayR && !DOM.videoR.paused) DOM.videoR.pause();
  }

  DOM.pauseLBtn.addEventListener("click", function () {
    state.pauseL = !state.pauseL;
    this.classList.toggle("secondary", state.pauseL);
    this.textContent = state.pauseL ? "▶ 左を再開" : "左を一時停止 [HOLD]";
    syncPlaybackState();
  });

  DOM.pauseRBtn.addEventListener("click", function () {
    state.pauseR = !state.pauseR;
    this.classList.toggle("secondary", state.pauseR);
    this.textContent = state.pauseR ? "▶ 右を再開" : "右を一時停止 [HOLD]";
    syncPlaybackState();
  });

  DOM.pauseAllBtn.addEventListener("click", function () {
    state.pauseAll = !state.pauseAll;
    this.classList.toggle("secondary", state.pauseAll);
    this.textContent = state.pauseAll ? "▶ 全体を再開" : "⏸ 全体を一時停止";
    syncPlaybackState();
  });

  DOM.speedGroup.querySelectorAll("button[data-speed]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sp = Number(btn.dataset.speed);
      if (!Number.isFinite(sp) || sp <= 0 || sp > 2) return;
      DOM.speedGroup.querySelectorAll("button[data-speed]").forEach((b) => {
        b.classList.toggle("secondary", b === btn);
      });
      state.speed = sp;
      DOM.speedBadge.textContent = `${sp}x`;
      DOM.videoL.playbackRate = sp;
      DOM.videoR.playbackRate = sp;
    });
  });

  DOM.saveEndBtn.addEventListener("click", () => {
    finishRecording(false);
  });

  DOM.discardBtn.addEventListener("click", () => {
    if (window.confirm("録画中の内容を破棄して開始位置の調整に戻ります。よろしいですか？")) {
      finishRecording(true);
    }
  });

  function finishRecording(discard) {
    if (!state.recording || finalizing) return;
    state.recording = false;
    finalizing = true;
    suspended = false;

    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    DOM.videoL.pause();
    DOM.videoR.pause();
    releaseWakeLock();

    const engine = recorderEngine;
    recorderEngine = null;
    completeRecording(engine, Boolean(discard));
  }

  async function completeRecording(engine, discard) {
    let result = null;
    try {
      if (!engine) {
        result = null;
      } else if (discard) {
        engine.abort();
      } else {
        setStatus("動画を書き出しています。そのまましばらくお待ちください…");
        result = await engine.finish(performance.now());
      }
    } catch (err) {
      console.error("Recording completion error:", err);
      try { if (engine) engine.abort(); } catch (_) { /* noop */ }
      result = null;
    } finally {
      finalizing = false;
      DOM.confirmStartBtn.disabled = false;
    }

    if (discard) {
      showPhase("setup");
      drawStatic();
      setStatus("録画を破棄し、メモリを解放して開始位置の調整に戻りました。");
      return;
    }

    if (!result || !result.blob || result.blob.size === 0) {
      setStatus("動画の書き出しに失敗しました。もう一度お試しください。", true);
      showPhase("setup");
      drawStatic();
      return;
    }

    presentResult(result.blob, result.mimeType);
    if (result.truncated) {
      setStatus("エンコーダーの制限により、途中までの動画を保存しました。", true);
    } else {
      const sizeMb = (result.blob.size / (1024 * 1024)).toFixed(1);
      setStatus(`比較動画の作成が完了しました（${ state.totalElapsed.toFixed(1) }秒 / ${ sizeMb }MB）。保存または共有が可能です。`);
    }
  }

  function presentResult(blob, mimeTypeIn) {
    releaseResultMemory();

    const mimeType = mimeTypeIn || "video/webm";
    const isMp4 = mimeType.includes("mp4");
    const ext = isMp4 ? "mp4" : "webm";
    const filename = `syncedmovie_${Date.now()}.${ext}`;

    const url = URL.createObjectURL(blob);
    objectUrls.result = url;

    state.resultBlob = blob;
    state.resultMime = mimeType;
    state.resultFilename = filename;

    DOM.outputFormatBadge.textContent = isMp4 ? "MP4 (H.264)" : "WebM";
    DOM.resultVideo.src = url;

    showPhase("result");
  }

  DOM.downloadBtn.addEventListener("click", () => {
    if (!objectUrls.result || !state.resultFilename) return;
    const a = document.createElement("a");
    a.href = objectUrls.result;
    a.download = state.resultFilename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  DOM.shareBtn.addEventListener("click", async () => {
    if (!state.resultBlob || !state.resultFilename) return;
    const shareFile = new File([state.resultBlob], state.resultFilename, { type: state.resultMime });
    if (navigator.canShare && navigator.canShare({ files: [shareFile] })) {
      try {
        await navigator.share({
          files: [shareFile],
          title: "登攀ムーブ比較動画",
          text: "SyncClimbで作成したムーブ比較検証動画です。",
        });
      } catch (_) {
        /* ユーザーキャンセル時は無視 */
      }
    } else {
      setStatus("この端末・ブラウザでは直接共有ができません。「端末に保存する」をご利用ください。", true);
    }
  });

  DOM.backToSetupFromResultBtn.addEventListener("click", () => {
    releaseResultMemory();
    showPhase("setup");
    drawStatic();
    setStatus("前回の出力動画メモリを解放しました。同じ動画のまま開始位置の再調整が可能です。");
  });

  function resetAll() {
    if (state.recording) return;
    if (recorderEngine) {
      try { recorderEngine.abort(); } catch (_) { /* noop */ }
      recorderEngine = null;
    }

    releaseResultMemory();
    unloadVideoElement(DOM.videoL, "L");
    unloadVideoElement(DOM.videoR, "R");

    DOM.fileL.value = "";
    DOM.fileR.value = "";
    ctx.clearRect(0, 0, CONFIG.OUT_WIDTH, CONFIG.OUT_HEIGHT);

    state.readyL = false;
    state.readyR = false;
    state.offsetL = 0;
    state.offsetR = 0;

    DOM.fileNameL.textContent = "クリックまたはドロップして左動画を選択";
    DOM.fileNameR.textContent = "クリックまたはドロップして右動画を選択";
    DOM.fcL.textContent = "左: 0f (0.00s)";
    DOM.fcR.textContent = "右: 0f (0.00s)";

    DOM.confirmStartBtn.disabled = false;
    DOM.toSetupBtn.disabled = true;
    showPhase("select");
    setStatus("すべてのメモリを解放しました。左右それぞれの動画ファイルを選択してください。");
  }

  DOM.restartBtn.addEventListener("click", resetAll);
  DOM.headerResetBtn.addEventListener("click", () => {
    if (window.confirm("現在の作業をリセットして最初の動画選択画面に戻りますか？")) {
      resetAll();
    }
  });

  // ===================================================================
  // 10. PC向けキーボードショートカット
  // ===================================================================
  window.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (state.phase === "setup") {
      switch (e.key) {
        case "w": case "W": stepFrames(DOM.videoL, e.shiftKey ? 10 : 1, state.fpsL); break;
        case "s": case "S": stepFrames(DOM.videoL, e.shiftKey ? -10 : -1, state.fpsL); break;
        case "i": case "I": stepFrames(DOM.videoR, e.shiftKey ? 10 : 1, state.fpsR); break;
        case "k": case "K": stepFrames(DOM.videoR, e.shiftKey ? -10 : -1, state.fpsR); break;
        case "z": case "Z": state.offsetL -= CONFIG.DEFAULT_SHIFT_STEP; drawStatic(); break;
        case "c": case "C": state.offsetL += CONFIG.DEFAULT_SHIFT_STEP; drawStatic(); break;
        case ",": case "<": state.offsetR -= CONFIG.DEFAULT_SHIFT_STEP; drawStatic(); break;
        case ".": case ">": state.offsetR += CONFIG.DEFAULT_SHIFT_STEP; drawStatic(); break;
        case "r": case "R": state.offsetL = 0; state.offsetR = 0; drawStatic(); break;
        case "Enter": e.preventDefault(); DOM.confirmStartBtn.click(); break;
      }
    } else if (state.phase === "record") {
      switch (e.key) {
        case " ": e.preventDefault(); DOM.pauseAllBtn.click(); break;
        case "a": case "A": DOM.pauseLBtn.click(); break;
        case "l": case "L": DOM.pauseRBtn.click(); break;
        case "q": case "Q": DOM.saveEndBtn.click(); break;
        case "Escape": DOM.discardBtn.click(); break;
      }
    }
  });
})();