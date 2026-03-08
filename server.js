const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");

const app = express();
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, "uploads");
const CONVERT_DIR = path.join(__dirname, "converted");
[UPLOAD_DIR, CONVERT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Multer: save to disk ──
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ── Find ffmpeg / ffprobe (system or bundled) ──
function which(name) {
  try {
    const r = require("child_process").execSync(`which ${name} 2>/dev/null`).toString().trim();
    if (r) return r;
  } catch {}
  // Try npm packages as fallback
  try { if (name === "ffmpeg") return require("ffmpeg-static"); } catch {}
  try { if (name === "ffprobe") return require("ffprobe-static").path; } catch {}
  return name; // hope it's on PATH
}
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
console.log(`[init] FFMPEG path: ${FFMPEG}`);
console.log(`[init] FFPROBE path: ${FFPROBE}`);

// ── Run a command as promise (with configurable timeout) ──
function run(cmd, args, opts = {}) {
  const timeout = opts.timeout || 120000; // default 2 min
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, timeout, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

// ── Analyze with ffprobe ──
async function analyze(filePath) {
  const { stdout } = await run(FFPROBE, [
    "-v", "quiet", "-print_format", "json",
    "-show_format", "-show_streams", filePath
  ]);
  const data = JSON.parse(stdout);
  const stream = (data.streams || []).find(s => s.codec_type === "audio") || {};
  const fmt = data.format || {};

  const channels = parseInt(stream.channels) || 0;
  const sampleRate = parseInt(stream.sample_rate) || 0;
  const bitDepth = parseInt(stream.bits_per_raw_sample) || parseInt(stream.bits_per_sample) || 0;
  const bitrate = parseInt(stream.bit_rate) || parseInt(fmt.bit_rate) || 0;
  const duration = parseFloat(fmt.duration) || parseFloat(stream.duration) || 0;
  let codec = (stream.codec_name || "").toLowerCase();

  return { codec, channels, sampleRate, sampleRateKhz: +(sampleRate / 1000).toFixed(3), bitDepth, bitrate, bitrateKbps: Math.round(bitrate / 1000), duration, durationFmt: fmtDur(duration), fileSize: parseInt(fmt.size) || 0 };
}

// ── Loudness analysis with ffmpeg ebur128 (using spawn for full stderr capture) ──
async function measureLoudness(filePath) {
  const LOUDNESS_TIMEOUT = 60000; // 60 seconds max
  try {
    console.log(`[loudness] Starting analysis for ${path.basename(filePath)}`);
    const { spawn: sp } = require("child_process");
    const args = ["-i", filePath, "-af", "ebur128=peak=true", "-f", "null", "-"];
    const txt = await new Promise((resolve, reject) => {
      const proc = sp(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => {
        console.log("[loudness] Timeout reached, killing process");
        proc.kill("SIGKILL");
        resolve(stderr); // resolve with whatever we have
      }, LOUDNESS_TIMEOUT);
      proc.stderr.on("data", chunk => { stderr += chunk.toString(); });
      proc.on("close", () => { clearTimeout(timer); resolve(stderr); });
      proc.on("error", (err) => { clearTimeout(timer); console.error("[loudness] spawn error:", err.message); resolve(stderr); });
    });
    console.log(`[loudness] Analysis complete, stderr length: ${txt.length}`);
    // Only parse from the Summary block to avoid duplicate matches from progress lines
    const summaryIdx = txt.lastIndexOf("Summary:");
    const summary = summaryIdx >= 0 ? txt.slice(summaryIdx) : txt;
    const iMatch = summary.match(/I:\s+([-\d.]+)\s+LUFS/);
    const tpMatch = summary.match(/Peak:\s+([-\d.]+)\s+dBFS/);
    const lraMatch = summary.match(/LRA:\s+([-\d.]+)\s+LU/);
    console.log(`[loudness] Parsed: I=${iMatch?.[1]}, TP=${tpMatch?.[1]}, LRA=${lraMatch?.[1]}`);
    return {
      integrated: iMatch ? parseFloat(iMatch[1]) : null,
      truePeak: tpMatch ? parseFloat(tpMatch[1]) : null,
      lra: lraMatch ? parseFloat(lraMatch[1]) : null
    };
  } catch (err) {
    console.error("[loudness] Error:", err.message);
    return { integrated: null, truePeak: null, lra: null };
  }
}

// ── Validate ──
function validate(info, loudness, workflow) {
  const checks = [];
  const add = (cat, status, msg, fix) => checks.push({ category: cat, status, message: msg, fix: fix || null });
  const { codec, channels, sampleRate, sampleRateKhz, bitDepth, bitrateKbps } = info;
  const ext = info.ext || "";

  if (workflow === "connect") {
    // Format
    const ok = ["wav", "flac", "mp3"].includes(ext);
    if (!ok) add("Format", "fail", `Format .${ext} not accepted. Apple Podcasts Connect accepts WAV, FLAC, or MP3.`, "Convert to WAV, FLAC, or MP3.");
    else add("Format", "pass", `Format .${ext.toUpperCase()} is accepted.`);

    if (ext === "wav" || ext === "flac") {
      // Sample rate
      if (sampleRateKhz < 44.1) add("Sample Rate", "fail", `${sampleRateKhz} kHz is below the 44.1 kHz minimum.`, "Resample to 44.1 kHz or higher.");
      else add("Sample Rate", "pass", `${sampleRateKhz} kHz meets requirements.`);
      // Bit depth
      if (bitDepth > 0 && bitDepth < 16) add("Bit Depth", "fail", `${bitDepth}-bit is below the 16-bit minimum.`, "Convert to 16-bit or 24-bit.");
      else if (bitDepth === 16) add("Bit Depth", "pass", `16-bit meets minimum. 24-bit recommended.`);
      else if (bitDepth >= 24) add("Bit Depth", "pass", `${bitDepth}-bit is excellent.`);
      else add("Bit Depth", "warning", `Bit depth could not be determined.`, "Verify bit depth manually.");
      // Channels
      if (channels < 2) add("Channels", "fail", `Mono detected. Apple requires stereo WAV/FLAC.`, "Convert to stereo (dual-channel).");
      else if (channels === 2) add("Channels", "pass", `Stereo — meets requirements.`);
      else add("Channels", "warning", `${channels} channels detected. Stereo expected.`, "Mix down to stereo.");
    }

    if (ext === "mp3") {
      if (sampleRateKhz < 44.1) add("Sample Rate", "fail", `${sampleRateKhz} kHz below 44.1 kHz minimum.`, "Re-encode at 44.1+ kHz.");
      else add("Sample Rate", "pass", `${sampleRateKhz} kHz is good.`);
      if (channels === 1) {
        if (bitrateKbps < 32) add("Bitrate", "fail", `${bitrateKbps} kbps below 32 kbps minimum for mono.`, "Re-encode at 96–128 kbps.");
        else if (bitrateKbps < 96) add("Bitrate", "warning", `${bitrateKbps} kbps is low. 96–128 kbps recommended.`, "Re-encode at 96–128 kbps.");
        else add("Bitrate", "pass", `${bitrateKbps} kbps is good for mono MP3.`);
      } else {
        if (bitrateKbps < 64) add("Bitrate", "fail", `${bitrateKbps} kbps below 64 kbps minimum for stereo.`, "Re-encode at 128–256 kbps.");
        else if (bitrateKbps < 128) add("Bitrate", "warning", `${bitrateKbps} kbps is low. 128–256 kbps recommended.`, "Re-encode at 128–256 kbps.");
        else add("Bitrate", "pass", `${bitrateKbps} kbps is good for stereo MP3.`);
      }
    }
  } else {
    // RSS
    const isMp3 = codec.includes("mp3") || codec.includes("lame") || ext === "mp3";
    const isAac = codec.includes("aac") || ["m4a", "aac", "mp4"].includes(ext);
    if (!isMp3 && !isAac) add("Format", "fail", `Format not accepted for RSS. Use MP3 or AAC.`, "Convert to MP3 or AAC (M4A).");
    else {
      add("Format", "pass", `${isMp3 ? "MP3" : "AAC"} is accepted for RSS feeds.`);
      if (isMp3) add("Optimization", "warning", `AAC offers better quality at lower bitrates than MP3.`, "Consider AAC for more efficient streaming.");
    }
    // Bitrate
    if (isMp3 || isAac) {
      const lo = sampleRateKhz <= 24;
      const minBr = channels <= 1 ? (lo ? 40 : 64) : (lo ? 80 : 128);
      const maxBr = channels <= 1 ? (lo ? 80 : 128) : (lo ? 160 : 256);
      if (bitrateKbps < minBr) add("Bitrate", "fail", `${bitrateKbps} kbps below ${minBr} kbps minimum.`, `Re-encode at ${minBr}–${maxBr} kbps.`);
      else if (bitrateKbps <= maxBr) add("Bitrate", "pass", `${bitrateKbps} kbps is in the recommended range.`);
      else add("Bitrate", "warning", `${bitrateKbps} kbps higher than needed. ${minBr}–${maxBr} kbps is recommended.`, "Lower bitrate to save bandwidth.");
    }
  }

  // Loudness (both)
  if (loudness.integrated !== null) {
    if (loudness.integrated > -15) add("Loudness", "fail", `${loudness.integrated.toFixed(1)} LUFS — too loud. Target: -16 LUFS (±1 dB).`, "Normalize to -16 LUFS.");
    else if (loudness.integrated < -19) add("Loudness", "fail", `${loudness.integrated.toFixed(1)} LUFS — too quiet. Target: -16 LUFS (±1 dB).`, "Normalize to -16 LUFS.");
    else if (loudness.integrated < -17) add("Loudness", "warning", `${loudness.integrated.toFixed(1)} LUFS — slightly quiet. Target: -16 LUFS.`, "Consider normalizing to -16 LUFS.");
    else add("Loudness", "pass", `${loudness.integrated.toFixed(1)} LUFS — within target range.`);
  } else {
    add("Loudness", "warning", "Could not measure loudness.", "Check audio file integrity.");
  }

  if (loudness.truePeak !== null) {
    if (loudness.truePeak > -1) add("True Peak", "fail", `${loudness.truePeak.toFixed(1)} dBFS exceeds -1 dBFS limit. Risk of clipping.`, "Apply peak limiting to -1 dBFS.");
    else if (loudness.truePeak > -1.5) add("True Peak", "warning", `${loudness.truePeak.toFixed(1)} dBFS — close to limit. More headroom recommended.`, "Limit to -1.5 dBFS for safety.");
    else add("True Peak", "pass", `${loudness.truePeak.toFixed(1)} dBFS — safe headroom.`);
  }

  const fails = checks.filter(c => c.status === "fail").length;
  const warns = checks.filter(c => c.status === "warning").length;
  const passes = checks.filter(c => c.status === "pass").length;
  return { checks, summary: { pass: passes, warning: warns, fail: fails }, overall: fails > 0 ? "fail" : warns > 0 ? "warning" : "pass" };
}

// ── Convert (using spawn to avoid buffer issues with large files) ──
async function convert(inputPath, opts) {
  const id = crypto.randomUUID();
  const ext = opts.format === "aac" ? "m4a" : opts.format;
  const outName = `converted_${id}.${ext}`;
  const outPath = path.join(CONVERT_DIR, outName);
  const args = ["-y", "-i", inputPath, "-vn"];

  if (opts.format === "wav") {
    args.push("-acodec", opts.bitDepth === 16 ? "pcm_s16le" : "pcm_s24le");
    args.push("-ar", String(opts.sampleRate || 44100), "-ac", "2");
  } else if (opts.format === "flac") {
    args.push("-acodec", "flac");
    args.push("-ar", String(opts.sampleRate || 44100), "-ac", "2");
  } else if (opts.format === "mp3") {
    args.push("-acodec", "libmp3lame", "-b:a", `${opts.bitrate || 128}k`);
    args.push("-ar", String(opts.sampleRate || 44100));
    if (opts.channels) args.push("-ac", String(opts.channels));
  } else if (opts.format === "aac") {
    args.push("-acodec", "aac", "-b:a", `${opts.bitrate || 128}k`);
    args.push("-ar", String(opts.sampleRate || 44100));
    if (opts.channels) args.push("-ac", String(opts.channels));
    args.push("-movflags", "+faststart");
  }

  if (opts.normalize) {
    args.splice(args.indexOf("-vn") + 1, 0, "-af", "loudnorm=I=-16:TP=-1:LRA=11");
  }

  args.push(outPath);
  console.log(`[convert] Running: ffmpeg ${args.join(" ")}`);

  // Use spawn instead of execFile to avoid buffer overflow on large files
  const { spawn: sp } = require("child_process");
  await new Promise((resolve, reject) => {
    const proc = sp(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
    let lastErr = "";
    const CONVERT_TIMEOUT = 600000; // 10 minutes max
    const timer = setTimeout(() => {
      console.error("[convert] Timeout reached (10 min), killing");
      proc.kill("SIGKILL");
      reject(new Error("Conversion timed out. Try a shorter file."));
    }, CONVERT_TIMEOUT);
    proc.stderr.on("data", chunk => { lastErr = chunk.toString().slice(-500); }); // keep only last 500 chars
    proc.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${lastErr.trim()}`));
    });
    proc.on("error", err => { clearTimeout(timer); reject(err); });
  });

  const stat = fs.statSync(outPath);
  console.log(`[convert] Done: ${outName} (${fmtSize(stat.size)})`);
  return { outName, outPath, downloadUrl: `/files/${outName}`, fileSize: stat.size, fileSizeFmt: fmtSize(stat.size) };
}

function fmtDur(s) {
  if (!s || !isFinite(s)) return "--:--";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`;
}
function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

// ── Static ──
app.use(express.static(path.join(__dirname, "public")));
app.use("/files", express.static(CONVERT_DIR));

// ── API: Health / Debug ──
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", ffmpeg: FFMPEG, ffprobe: FFPROBE, uptime: process.uptime() });
});

// ── API: Analyze ──
app.post("/api/analyze", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    console.log(`[analyze] File received: ${req.file.originalname} (${(req.file.size / 1024).toFixed(0)} KB)`);
    const ext = path.extname(req.file.originalname).toLowerCase().replace(".", "");
    console.log("[analyze] Running ffprobe...");
    const info = await analyze(req.file.path);
    console.log(`[analyze] ffprobe done: codec=${info.codec}, sr=${info.sampleRate}, ch=${info.channels}`);
    info.ext = ext;
    info.originalName = req.file.originalname;
    info.storedName = req.file.filename;
    info.fileSizeFmt = fmtSize(info.fileSize || fs.statSync(req.file.path).size);
    console.log("[analyze] Running loudness measurement...");
    const loudness = await measureLoudness(req.file.path);
    console.log(`[analyze] Loudness done: ${JSON.stringify(loudness)}`);
    const connectVal = validate(info, loudness, "connect");
    const rssVal = validate(info, loudness, "rss");
    console.log("[analyze] Sending response");
    res.json({ info, loudness, validation: { connect: connectVal, rss: rssVal } });
  } catch (err) {
    console.error("[analyze] ERROR:", err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Convert ──
app.post("/api/convert", async (req, res) => {
  try {
    const { storedName, options } = req.body;
    console.log(`[convert] Request: storedName=${storedName}, format=${options.format}, normalize=${options.normalize}`);
    const inputPath = path.join(UPLOAD_DIR, storedName);
    if (!fs.existsSync(inputPath)) return res.status(404).json({ error: "File not found. Please re-upload." });
    console.log("[convert] Starting conversion...");
    const result = await convert(inputPath, options);
    console.log("[convert] Conversion complete, re-analyzing output...");
    // Re-analyze output
    const info = await analyze(result.outPath);
    info.ext = options.format === "aac" ? "m4a" : options.format;
    console.log("[convert] Running loudness on converted file...");
    const loudness = await measureLoudness(result.outPath);
    console.log(`[convert] Post-conversion loudness: ${JSON.stringify(loudness)}`);
    const wf = options.workflow || "connect";
    const val = validate(info, loudness, wf);
    console.log("[convert] Sending response");
    res.json({ ...result, info, loudness, validation: val });
  } catch (err) {
    console.error("[convert] ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Startup: check ffmpeg availability ──
const PORT = process.env.PORT || 3000;
try {
  require("child_process").execSync(`${FFMPEG} -version`, { stdio: "pipe" });
  require("child_process").execSync(`${FFPROBE} -version`, { stdio: "pipe" });
} catch {
  console.error("\n❌ ffmpeg and/or ffprobe not found!");
  console.error("Install ffmpeg on your Mac: brew install ffmpeg");
  console.error("Or download from: https://ffmpeg.org/download.html\n");
  process.exit(1);
}
app.listen(PORT, () => {
  console.log(`\n🎙️  Podcast Audio Validator running → http://localhost:${PORT}`);
  console.log(`   ffmpeg: ${FFMPEG}`);
  console.log(`   ffprobe: ${FFPROBE}`);
  console.log("   Open this URL in your browser to get started.\n");
});
