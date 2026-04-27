const DEFAULT_MODEL_ID = "onnx-community/whisper-small";
const TARGET_SAMPLE_RATE = 16000;
const SRT_BOM = "\ufeff";
const HELPER_URL = "http://127.0.0.1:8765";
const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
const OPENCC_URL = "https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/esm/full.js";

let pipeline = null;
let traditionalConverter = null;

const ui = {
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  fileName: document.querySelector("#fileName"),
  modelSelect: document.querySelector("#modelSelect"),
  statusTitle: document.querySelector("#statusTitle"),
  statusText: document.querySelector("#statusText"),
  timerText: document.querySelector("#timerText"),
  progressBar: document.querySelector("#progressBar"),
  preview: document.querySelector("#preview"),
  youtubeUrl: document.querySelector("#youtubeUrl"),
  rightsCheck: document.querySelector("#rightsCheck"),
  checkButton: document.querySelector("#checkButton"),
  helperButton: document.querySelector("#helperButton"),
  youtubeDownloadButton: document.querySelector("#youtubeDownloadButton"),
  downloadButton: document.querySelector("#downloadButton"),
  helperStatus: document.querySelector("#helperStatus"),
  helpDialog: document.querySelector("#helpDialog"),
};

let transcriber = null;
let loadedModelId = "";
let activeDevice = "";
let srtContent = "";
let selectedFile = null;
let timer = null;
let startedAt = 0;

ui.fileInput.addEventListener("change", () => {
  const [file] = ui.fileInput.files;
  if (file) handleFile(file);
});

["dragenter", "dragover"].forEach((eventName) => {
  ui.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    ui.dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  ui.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    ui.dropZone.classList.remove("dragging");
  });
});

ui.dropZone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (file) handleFile(file);
});

ui.checkButton.addEventListener("click", checkEnvironment);
ui.helperButton.addEventListener("click", checkHelper);
ui.youtubeDownloadButton.addEventListener("click", startYoutubeDownload);
ui.downloadButton.addEventListener("click", downloadSrt);
ui.modelSelect.addEventListener("change", () => {
  transcriber = null;
  loadedModelId = "";
  ui.downloadButton.disabled = true;
  srtContent = "";
  ui.preview.hidden = true;
  ui.preview.textContent = "";
  setStatus("模型已切換", "下一次上傳或拖曳檔案時，會載入新選擇的 Whisper 模型。", 0);
});

async function handleFile(file) {
  selectedFile = file;
  srtContent = "";
  ui.downloadButton.disabled = true;
  ui.preview.hidden = true;
  ui.preview.textContent = "";
  ui.fileName.textContent = `${file.name}（${formatBytes(file.size)}）`;

  try {
    startTimer();
    setStatus("準備音訊", "正在讀取媒體檔並轉成 Whisper 需要的 16 kHz 音訊。", 8);
    const audio = await decodeToMono16k(file);

    const modelId = getSelectedModelId();
    setStatus("載入 Whisper", `正在載入 ${modelLabel(modelId)}，第一次使用會下載模型並快取在瀏覽器裡。`, 18);
    transcriber = transcriber && loadedModelId === modelId ? transcriber : await createTranscriber(modelId);

    setStatus("Whisper 正在辨識中", `目前使用 ${modelLabel(modelId)} / ${deviceLabel(activeDevice)}，影片越長需要等越久。`, 42);
    const result = await transcriber(audio, {
      language: "chinese",
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });

    setStatus("轉換繁體中文", "正在把辨識結果整理為繁體中文字幕。", 88);
    const cues = await convertCuesToTraditional(normalizeChunks(result));
    srtContent = SRT_BOM + buildSrt(cues, getSubtitleMode());
    ui.preview.textContent = srtContent.slice(1, 1800);
    ui.preview.hidden = false;
    ui.downloadButton.disabled = false;
    setStatus("字幕已完成", "可以下載 SRT 字幕檔，也可以再拖曳另一個檔案重新辨識。", 100);
  } catch (error) {
    console.error(error);
    setStatus("處理失敗", getFriendlyError(error), 0);
  } finally {
    stopTimer();
  }
}

async function decodeToMono16k(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("此瀏覽器不支援音訊解碼。");
  }

  const context = new AudioContextClass();
  const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
  const mono = mixToMono(decoded);
  const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  await context.close();
  return resampled;
}

function mixToMono(audioBuffer) {
  const { numberOfChannels, length } = audioBuffer;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      mono[index] += data[index] / numberOfChannels;
    }
  }
  return mono;
}

function resampleLinear(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const newLength = Math.round(input.length / ratio);
  const output = new Float32Array(newLength);

  for (let index = 0; index < newLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const weight = position - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }

  return output;
}

async function getBestDevice() {
  if (!("gpu" in navigator)) return "wasm";
  try {
    const adapter = await withTimeout(navigator.gpu.requestAdapter(), 2500);
    return adapter ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

function withTimeout(promise, milliseconds) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error("timeout")), milliseconds);
    }),
  ]);
}

async function createTranscriber(modelId) {
  const transcriberPipeline = await getPipeline();
  const preferredDevice = await getBestDevice();
  try {
    activeDevice = preferredDevice;
    const nextTranscriber = await transcriberPipeline("automatic-speech-recognition", modelId, {
      device: preferredDevice,
      progress_callback: updateModelProgress,
    });
    loadedModelId = modelId;
    return nextTranscriber;
  } catch (error) {
    if (preferredDevice !== "webgpu") throw error;
    console.warn("WebGPU 載入失敗，改用 CPU 模式。", error);
    setStatus("改用 CPU 模式", "WebGPU 載入不成功，正在改用較穩定的 CPU 模式。", 24);
    activeDevice = "wasm";
    const nextTranscriber = await transcriberPipeline("automatic-speech-recognition", modelId, {
      device: "wasm",
      progress_callback: updateModelProgress,
    });
    loadedModelId = modelId;
    return nextTranscriber;
  }
}

async function getPipeline() {
  if (pipeline) return pipeline;

  const transformers = await import(TRANSFORMERS_URL);
  transformers.env.allowLocalModels = false;
  transformers.env.useBrowserCache = true;
  pipeline = transformers.pipeline;
  return pipeline;
}

async function getTraditionalConverter() {
  if (traditionalConverter) return traditionalConverter;

  const opencc = await import(OPENCC_URL);
  traditionalConverter = opencc.Converter({ from: "cn", to: "tw" });
  return traditionalConverter;
}

async function convertCuesToTraditional(cues) {
  try {
    const converter = await getTraditionalConverter();
    return cues.map((cue) => ({
      ...cue,
      text: converter(cue.text),
    }));
  } catch (error) {
    console.warn("繁體轉換載入失敗，保留 Whisper 原始文字。", error);
    return cues;
  }
}

function updateModelProgress(progress) {
  if (!progress?.progress) return;
  const value = Math.min(40, 18 + progress.progress * 0.22);
  setProgress(value);
}

function normalizeChunks(result) {
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  if (chunks.length === 0) {
    return [{
      text: result?.text || "",
      start: 0,
      end: Math.max(2, Math.ceil((result?.text || "").length / 6)),
    }];
  }

  return chunks
    .map((chunk, index) => {
      const [start, end] = Array.isArray(chunk.timestamp) ? chunk.timestamp : [index * 4, index * 4 + 4];
      return {
        text: cleanText(chunk.text),
        start: Number.isFinite(start) ? start : index * 4,
        end: Number.isFinite(end) ? end : (Number.isFinite(start) ? start + 4 : index * 4 + 4),
      };
    })
    .filter((cue) => cue.text);
}

function buildSrt(cues, mode) {
  const merged = mergeCues(cues, mode);
  return merged.map((cue, index) => {
    return `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`;
  }).join("\n");
}

function mergeCues(cues, mode) {
  const maxChars = { tight: 38, standard: 56, loose: 82 }[mode];
  const maxSeconds = { tight: 4.5, standard: 7, loose: 10 }[mode];
  const result = [];

  for (const cue of cues) {
    const last = result.at(-1);
    if (!last) {
      result.push({ ...cue });
      continue;
    }

    const combinedText = `${last.text}${needsSpace(last.text, cue.text) ? " " : ""}${cue.text}`;
    const combinedDuration = cue.end - last.start;
    if (combinedText.length <= maxChars && combinedDuration <= maxSeconds) {
      last.text = combinedText;
      last.end = Math.max(last.end, cue.end);
    } else {
      result.push({ ...cue });
    }
  }

  return result.map((cue) => ({
    ...cue,
    end: Math.max(cue.end, cue.start + 0.8),
  }));
}

function needsSpace(left, right) {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatSrtTime(seconds) {
  const safeSeconds = Math.max(0, seconds || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = Math.floor(safeSeconds % 60);
  const millis = Math.round((safeSeconds - Math.floor(safeSeconds)) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${String(millis).padStart(3, "0")}`;
}

function getSubtitleMode() {
  return document.querySelector("input[name='subtitleMode']:checked")?.value || "standard";
}

function getSelectedModelId() {
  return ui.modelSelect?.value || DEFAULT_MODEL_ID;
}

function modelLabel(modelId) {
  return {
    "onnx-community/whisper-tiny": "Tiny",
    "onnx-community/whisper-base": "Base",
    "onnx-community/whisper-small": "Small",
  }[modelId] || modelId;
}

function downloadSrt() {
  if (!srtContent || !selectedFile) return;
  const basename = selectedFile.name.replace(/\.[^.]+$/, "");
  const blob = new Blob([srtContent], { type: "application/x-subrip;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${basename}.srt`;
  link.click();
  URL.revokeObjectURL(url);
}

async function checkEnvironment() {
  setStatus("正在檢查環境", "正在確認瀏覽器可用的辨識模式。", 20);
  try {
    const device = await getBestDevice();
    const cache = "caches" in window ? "支援模型快取" : "不支援模型快取";
    setStatus("環境檢查完成", `此瀏覽器會使用 ${deviceLabel(device)}，${cache}。`, 100);
  } catch (error) {
    setStatus("環境檢查失敗", getFriendlyError(error), 0);
  }
}

async function checkHelper() {
  setStatus("正在檢查本機助手", "正在連線到本機助手服務。", 20);
  ui.helperStatus.textContent = "正在檢查本機助手連線...";
  try {
    const response = await fetch(`${HELPER_URL}/health`, { cache: "no-store" });
    if (!response.ok) throw new Error("本機助手沒有回應。");
    const data = await response.json();
    ui.helperStatus.textContent = `本機助手已連線，下載資料夾：${data.download_dir}`;
    setStatus("本機助手已連線", "可以貼上 YouTube 網址並下載影片。", 100);
    return true;
  } catch {
    ui.helperStatus.textContent = "尚未連上本機助手，請先執行 local-helper/start-helper.bat。";
    ui.helpDialog.showModal();
    setStatus("找不到本機助手", "請先啟動本機字幕助手，再回來按「檢查本機助手」。", 0);
    return false;
  }
}

async function startYoutubeDownload() {
  const url = ui.youtubeUrl.value.trim();
  if (!url) {
    setStatus("請貼上網址", "請先貼上 YouTube 影片網址。", 0);
    return;
  }
  if (!ui.rightsCheck.checked) {
    setStatus("需要確認授權", "請先確認影片為自己擁有、已取得授權，或平台明確允許下載。", 0);
    return;
  }

  const helperReady = await checkHelper();
  if (!helperReady) return;

  try {
    setStatus("建立下載工作", "正在把 YouTube 網址交給本機助手。", 5);
    ui.youtubeDownloadButton.disabled = true;
    const response = await fetch(`${HELPER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, confirmed: true }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "建立下載工作失敗。");
    await pollYoutubeJob(data.job_id);
  } catch (error) {
    setStatus("下載失敗", getFriendlyError(error), 0);
  } finally {
    ui.youtubeDownloadButton.disabled = false;
  }
}

async function pollYoutubeJob(jobId) {
  while (true) {
    await wait(1500);
    const response = await fetch(`${HELPER_URL}/jobs/${jobId}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "讀取下載進度失敗。");

    const job = data.job;
    setStatus("本機助手下載中", job.message || "下載中", job.progress || 0);
    ui.helperStatus.textContent = job.file ? `已下載：${job.file}` : job.message;

    if (job.status === "done") {
      setStatus("影片下載完成", `檔案已放在：${job.file}。請把影片拖到上方上傳區產生字幕。`, 100);
      return;
    }
    if (job.status === "error") {
      throw new Error(job.message || "下載失敗。");
    }
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function startTimer() {
  stopTimer();
  startedAt = Date.now();
  ui.timerText.textContent = "已等待 0 分 0 秒";
  timer = window.setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    ui.timerText.textContent = `已等待 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
  }, 1000);
}

function stopTimer() {
  if (timer) window.clearInterval(timer);
  timer = null;
}

function setStatus(title, text, progress) {
  ui.statusTitle.textContent = title;
  ui.statusText.textContent = text;
  setProgress(progress);
}

function setProgress(value) {
  ui.progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function deviceLabel(device) {
  return device === "webgpu" ? "WebGPU 加速" : "CPU 模式";
}

function getFriendlyError(error) {
  const message = String(error?.message || error);
  if (message.includes("decodeAudioData")) {
    return "這個檔案格式瀏覽器無法解碼，請先轉成 mp3 或 wav 再試一次。";
  }
  if (message.includes("fetch") || message.includes("Failed to fetch")) {
    return "模型下載失敗，請確認網路可連到 Hugging Face 後再試一次。";
  }
  return message || "發生未知錯誤，請換一個檔案再試一次。";
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}
