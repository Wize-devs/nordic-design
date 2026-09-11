#!/usr/bin/env node
/**
 * kie.ai image generator: calls the kie.ai GPT Image 2 text-to-image API
 * (gpt-image-2-text-to-image) for brand tiles.
 *
 * Usage:
 *   node scripts/kie_image_gen.mjs \
 *     --prompt "..." \
 *     --out posts/instagram/.../output.png \
 *     [--aspect-ratio 5:4] [--resolution 1K]
 *
 * Note: kie.ai does not support 2K/4K with aspect ratios 5:4, 4:5, 3:1, 1:3, or
 * 9:21 -- the task will fail to create. Use 1K with those ratios, or pick a
 * supported ratio (e.g. 4:3/3:4) for 2K/4K.
 *
 * Reads KIE_API_KEY from scripts/.env (or the environment, which takes
 * precedence). Edit scripts/.env and replace the placeholder with your real
 * key -- that file is gitignored so it won't get committed.
 *
 * Node port of kie_image_gen.py (same CLI, same behavior) for machines
 * without a working Python interpreter.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(SCRIPT_DIR, ".env");
const MODEL = "gpt-image-2-text-to-image";
const CREATE_URL = "https://api.kie.ai/api/v1/jobs/createTask";
const RECORD_URL = "https://api.kie.ai/api/v1/jobs/recordInfo";

const UNSUPPORTED_HIGH_RES_RATIOS = new Set(["5:4", "4:5", "3:1", "1:3", "9:21"]);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    // setdefault semantics: real env vars take precedence over .env
    if (!(k in process.env)) process.env[k] = v;
  }
}

function getApiKey() {
  loadEnvFile(ENV_PATH);
  const key = process.env.KIE_API_KEY || "";
  if (!key || key.startsWith("REPLACE_WITH_")) {
    die(
      "KIE_API_KEY is not set. Edit scripts/.env and put your real " +
      "kie.ai API key in place of the placeholder, then re-run."
    );
  }
  return key;
}

async function httpPostJson(url, apiKey, body) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    die(`kie.ai API request failed: ${e.message}`);
  }
  const text = await resp.text();
  if (!resp.ok) {
    die(`kie.ai API error ${resp.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function httpGetJson(url, apiKey, params) {
  const query = new URLSearchParams(params).toString();
  let resp;
  try {
    resp = await fetch(`${url}?${query}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    die(`kie.ai API request failed: ${e.message}`);
  }
  const text = await resp.text();
  if (!resp.ok) {
    die(`kie.ai API error ${resp.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function createTask(apiKey, prompt, aspectRatio, resolution) {
  if (["2K", "4K"].includes(resolution) && UNSUPPORTED_HIGH_RES_RATIOS.has(aspectRatio)) {
    die(
      `kie.ai does not support ${resolution} with aspect_ratio=${aspectRatio} ` +
      `(unsupported at 2K/4K: ${[...UNSUPPORTED_HIGH_RES_RATIOS].sort().join(", ")}). ` +
      "Use 1K, or switch to a supported ratio."
    );
  }
  const inputParams = { prompt, aspect_ratio: aspectRatio };
  if (resolution) inputParams.resolution = resolution;
  const body = { model: MODEL, input: inputParams };
  const resp = await httpPostJson(CREATE_URL, apiKey, body);
  if (resp.code !== 200) {
    die(`createTask failed: ${JSON.stringify(resp)}`);
  }
  return resp.data.taskId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollTask(apiKey, taskId, interval = 3, timeout = 300) {
  let elapsed = 0;
  while (elapsed < timeout) {
    const resp = await httpGetJson(RECORD_URL, apiKey, { taskId });
    const data = resp.data || {};
    const state = data.state;
    if (state === "success") return data;
    if (state === "fail") {
      die(`Task failed: ${data.failCode} ${data.failMsg}`);
    }
    console.error(`[state=${state}] waiting...`);
    await sleep(interval * 1000);
    elapsed += interval;
  }
  die(`Timed out after ${timeout}s waiting for task ${taskId}`);
}

async function downloadImage(url, outPath) {
  // tempfile.aiquickdraw.com (kie.ai's result CDN) returns 403 for requests
  // without a browser-like User-Agent.
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!resp.ok) {
    die(`Failed to download image: HTTP ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

function parseArgs(argv) {
  const args = { aspectRatio: "auto", resolution: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt") args.prompt = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--aspect-ratio") args.aspectRatio = argv[++i];
    else if (a === "--resolution") args.resolution = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else die(`Unknown argument: ${a}`);
  }
  return args;
}

const USAGE = `usage: kie_image_gen.mjs --prompt PROMPT --out OUT [--aspect-ratio RATIO] [--resolution {1K,2K,4K}]`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.prompt) die(`${USAGE}\nkie_image_gen.mjs: error: the following arguments are required: --prompt`);
  if (!args.out) die(`${USAGE}\nkie_image_gen.mjs: error: the following arguments are required: --out`);
  if (args.resolution && !["1K", "2K", "4K"].includes(args.resolution)) {
    die(`${USAGE}\nkie_image_gen.mjs: error: argument --resolution: invalid choice: '${args.resolution}' (choose from '1K', '2K', '4K')`);
  }

  const apiKey = getApiKey();
  const taskId = await createTask(apiKey, args.prompt, args.aspectRatio, args.resolution);
  console.error(`Task created: ${taskId}`);
  const data = await pollTask(apiKey, taskId);
  const result = JSON.parse(data.resultJson);
  const urls = result.resultUrls || [];
  if (!urls.length) {
    die(`No resultUrls in response: ${JSON.stringify(data).slice(0, 2000)}`);
  }
  await downloadImage(urls[0], args.out);
  console.log(`Saved: ${args.out}`);
}

main();
