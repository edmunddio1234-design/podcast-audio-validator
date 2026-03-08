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
  try { if (name === "ffmpeg") return require("ffmpeg-static"); } catch {}
  try { if (name === "ffprobe") return require("ffprobe-static").path; } catch {}
  return name;
}
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
console.log(`[init] FFMPEG path: ${FFMPEG}`);
console.log(`[init] FFPROBE path: ${FFPROBE}`);

// ── Run a command as promise ──
function run(cmd, args, opts = {}) {
  const timeout = opts.timeout || 120000;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, timeout, ...opts }, (err, stdout, stderr) => {
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

// ── Loudness analysis with spawn ──
async function measureLoudness(filePath) {
  const LOUDNESS_TIMEOUT = 120000; // 2 minutes for large files
  try {
    console.log(`[loudness] Starting for ${path.basename(filePath)}`);
    const { spawn: sp } = require("child_process");
    const args = ["-i", filePath, "-af", "ebur128=peak=true", "-f", "null", "-"];
    const txt = await new Promise((resolve, reject) => {
      const proc = sp(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => {
        console.log("[loudness] Timeout, killing");
        proc.kill("SIGKILL");
        resolve(stderr);
      }, LOUDNESS_TIMEOUT);
      proc.stderr.on("data", chunk => { stderr += chunk.toString(); });
      proc.on("close", () => { clearTimeout(timer); resolve(stderr); });
      proc.on("error", (err) => { clearTimeout(timer); resolve(stderr); });
    });
    console.log(`[loudness] Done, stderr length: ${txt.length}`);
    const summaryIdx = txt.lastIndexOf("Summary:");
    const summary = summaryIdx >= 0 ? txt.slice(summaryIdx) : txt;
    const iMatch = summary.match(/I:\s+([-\d.]+)\s+LUFS/);
    const tpMatch = summary.match(/Peak:\s+([-\d.]+)\s+dBFS/);
    const lraMatch = summary.match(/LRA:\s+([-\d.]+)\s+LU/);
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
    const ok = ["wav", "flac", "mp3"].includes(ext);
    if (!ok) add("Format", "fail", `Format .${ext} not accepted. Apple Podcasts Connect accepts WAV, FLAC, or MP3.`, "Convert to WAV, FLAC, or MP3.");
    else add("Format", "pass", `Format .${ext.toUpperCase()} is accepted.`);
    if (ext === "wav" || ext === "flac") {
      if (sampleRateKhz < 44.1) add("Sample Rate", "fail", `${sampleRateKhz} kHz is below the 44.1 kHz minimum.`, "Resample to 44.1 kHz or higher.");
      else add("Sample Rate", "pass", `${sampleRateKhz} kHz meets requirements.`);
      if (bitDepth > 0 && bitDepth < 16) add("Bit Depth", "fail", `${bitDepth}-bit is below the 16-bit minimum.`, "Convert to 16-bit or 24-bit.");
      else if (bitDepth === 16) add("Bit Depth", "pass", `16-bit meets minimum. 24-bit recommended.`);
      else if (bitDepth >= 24) add("Bit Depth", "pass", `${bitDepth}-bit is excellent.`);
      else add("Bit Depth", "warning", `Bit depth could not be determined.`, "Verify bit depth manually.");
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
    const isMp3 = codec.includes("mp3") || codec.includes("lame") || ext === "mp3";
    const isAac = codec.includes("aac") || ["m4a", "aac", "mp4"].includes(ext);
    if (!isMp3 && !isAac) add("Format", "fail", `Format not accepted for RSS. Use MP3 or AAC.`, "Convert to MP3 or AAC (M4A).");
    else {
      add("Format", "pass", `${isMp3 ? "MP3" : "AAC"} is accepted for RSS feeds.`);
      if (isMp3) add("Optimization", "warning", `AAC offers better quality at lower bitrates than MP3.`, "Consider AAC for more efficient streaming.");
    }
    if (isMp3 || isAac) {
      const lo = sampleRateKhz <= 24;
      const minBr = channels <= 1 ? (lo ? 40 : 64) : (lo ? 80 : 128);
      const maxBr = channels <= 1 ? (lo ? 80 : 128) : (lo ? 160 : 256);
      if (bitrateKbps < minBr) add("Bitrate", "fail", `${bitrateKbps} kbps below ${minBr} kbps minimum.`, `Re-encode at ${minBr}–${maxBr} kbps.`);
      else if (bitrateKbps <= maxBr) add("Bitrate", "pass", `${bitrateKbps} kbps is in the recommended range.`);
      else add("Bitrate", "warning", `${bitrateKbps} kbps higher than needed. ${minBr}–${maxBr} kbps is recommended.`, "Lower bitrate to save bandwidth.");
    }
  }

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

// ── Convert (spawn-based, streaming stderr) ──
async function convertFile(inputPath, opts) {
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

  const { spawn: sp } = require("child_process");
  await new Promise((resolve, reject) => {
    const proc = sp(FFMPEG, args, { stdio: ["pipe", "pipe", "pipe"] });
    let lastErr = "";
    const CONVERT_TIMEOUT = 600000; // 10 minutes
    const timer = setTimeout(() => {
      console.error("[convert] Timeout (10 min), killing");
      proc.kill("SIGKILL");
      reject(new Error("Conversion timed out. Try a shorter file."));
    }, CONVERT_TIMEOUT);
    proc.stderr.on("data", chunk => { lastErr = chunk.toString().slice(-500); });
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

// ══════════════════════════════════════════════════════════
// ── ASYNC JOB SYSTEM (avoids Render's 30s proxy timeout) ──
// ══════════════════════════════════════════════════════════
const jobs = new Map(); // jobId -> { status, progress, result, error }

function createJob() {
  const id = crypto.randomUUID();
  jobs.set(id, { status: "processing", progress: "Starting conversion…", result: null, error: null, created: Date.now() });
  return id;
}

// Clean up old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.created > 30 * 60 * 1000) jobs.delete(id); // 30 min expiry
  }
}, 600000);

// ── Static ──
app.use(express.static(path.join(__dirname, "public")));
app.use("/files", express.static(CONVERT_DIR));

// ── No-cache for HTML (prevent stale frontend) ──
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});

// ── API: Health ──
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", ffmpeg: FFMPEG, ffprobe: FFPROBE, uptime: process.uptime(), activeJobs: jobs.size });
});

// ── API: Debug — list all jobs ──
app.get("/api/debug/jobs", (req, res) => {
  const list = [];
  for (const [id, job] of jobs) {
    list.push({ id: id.slice(0, 8), status: job.status, progress: job.progress, error: job.error, age: Math.round((Date.now() - job.created) / 1000) + "s" });
  }
  res.json({ jobs: list, count: list.length });
});

// ── API: Analyze (unchanged — works within timeout for most files) ──
app.post("/api/analyze", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    console.log(`[analyze] File: ${req.file.originalname} (${(req.file.size / 1024).toFixed(0)} KB)`);
    const ext = path.extname(req.file.originalname).toLowerCase().replace(".", "");
    const info = await analyze(req.file.path);
    info.ext = ext;
    info.originalName = req.file.originalname;
    info.storedName = req.file.filename;
    info.fileSizeFmt = fmtSize(info.fileSize || fs.statSync(req.file.path).size);
    console.log(`[analyze] codec=${info.codec}, sr=${info.sampleRate}, ch=${info.channels}, dur=${info.durationFmt}`);
    console.log("[analyze] Measuring loudness...");
    const loudness = await measureLoudness(req.file.path);
    console.log(`[analyze] Loudness: ${JSON.stringify(loudness)}`);
    const connectVal = validate(info, loudness, "connect");
    const rssVal = validate(info, loudness, "rss");
    res.json({ info, loudness, validation: { connect: connectVal, rss: rssVal } });
  } catch (err) {
    console.error("[analyze] ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Start Convert (returns immediately with jobId) ──
app.post("/api/convert", async (req, res) => {
  try {
    const { storedName, options } = req.body;
    console.log(`[convert] Request: file=${storedName}, fmt=${options.format}, norm=${options.normalize}`);
    const inputPath = path.join(UPLOAD_DIR, storedName);
    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ error: "File not found. Please re-upload your audio file." });
    }

    // Create job and return immediately (avoid Render's 30s proxy timeout)
    const jobId = createJob();
    console.log(`[convert] Job ${jobId} created, starting background processing...`);
    res.json({ jobId });

    // Run conversion in the background (NOT awaited by the request)
    (async () => {
      try {
        const job = jobs.get(jobId);
        job.progress = "Converting audio…";
        console.log(`[job ${jobId}] Starting ffmpeg conversion...`);
        const result = await convertFile(inputPath, options);

        job.progress = "Analyzing converted file…";
        console.log(`[job ${jobId}] Conversion done, analyzing output...`);
        const info = await analyze(result.outPath);
        info.ext = options.format === "aac" ? "m4a" : options.format;

        job.progress = "Measuring loudness…";
        console.log(`[job ${jobId}] Measuring post-conversion loudness...`);
        const loudness = await measureLoudness(result.outPath);
        console.log(`[job ${jobId}] Loudness: ${JSON.stringify(loudness)}`);

        const wf = options.workflow || "connect";
        const val = validate(info, loudness, wf);

        job.status = "done";
        job.result = { ...result, info, loudness, validation: val };
        job.progress = "Complete!";
        console.log(`[job ${jobId}] COMPLETE — ${result.outName} (${result.fileSizeFmt})`);
      } catch (err) {
        console.error(`[job ${jobId}] ERROR:`, err.message);
        const job = jobs.get(jobId);
        if (job) {
          job.status = "error";
          job.error = err.message;
        }
      }
    })();

  } catch (err) {
    console.error("[convert] ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Poll job status ──
app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status === "done") {
    res.json({ status: "done", result: job.result });
  } else if (job.status === "error") {
    res.json({ status: "error", error: job.error });
  } else {
    res.json({ status: "processing", progress: job.progress });
  }
});

// ── Startup ──
const PORT = process.env.PORT || 3000;
try {
  require("child_process").execSync(`${FFMPEG} -version`, { stdio: "pipe" });
  require("child_process").execSync(`${FFPROBE} -version`, { stdio: "pipe" });
} catch {
  console.error("\n❌ ffmpeg and/or ffprobe not found!");
  process.exit(1);
}
app.listen(PORT, () => {
  console.log(`\n🎙️  Podcast Audio Validator running → http://localhost:${PORT}`);
  console.log(`   ffmpeg: ${FFMPEG}`);
  console.log(`   ffprobe: ${FFPROBE}\n`);
});
