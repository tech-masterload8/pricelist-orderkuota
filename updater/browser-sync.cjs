const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PRICE_HOME = "https://orderkuota.com/harga";
const DEBUG_PORT = 9244;
const MAX_PAGES = 40;

const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const configPath = path.join(baseDir, "config.json");
const profileDir = path.join(baseDir, "browser-profile");
const logPath = path.join(baseDir, "sync.log");

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(logPath, `${line}\n`);
  } catch {
    // The console line is enough when the log file cannot be written.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json tidak ada. Salin config.example.json menjadi ${configPath} lalu isi token.`);
  }
  const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const uploadUrl = String(value.uploadUrl || "").trim();
  const token = String(value.token || "").trim();
  const intervalMinutes = Number(value.intervalMinutes);
  if (!uploadUrl.startsWith("https://")) throw new Error("uploadUrl di config.json harus alamat https.");
  if (!token) throw new Error("token di config.json masih kosong. Isi dengan CRON_SECRET proyek Vercel.");
  return {
    uploadUrl,
    token,
    intervalMs: Math.min(180, Math.max(5, Number.isFinite(intervalMinutes) ? intervalMinutes : 10)) * 60 * 1000,
  };
}

function decodeText(value) {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, digits) => {
      const code = Number(digits);
      return code > 31 && code < 127 ? String.fromCharCode(code) : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value) {
  return decodeText(value).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

function parseIndex(html) {
  const sections = [];
  for (const panel of html.split('<div class="panel panel-default"').slice(1)) {
    const title = panel.match(/<h3 class="panel-title">\s*<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1];
    if (!title) continue;
    const providers = [];
    for (const match of panel.matchAll(/<a\b([^>]*\bclass="list-group-item[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = match[1].match(/\bhref="([^"]+)"/i)?.[1];
      const name = decodeText(match[2]);
      if (!href || !name) continue;
      try {
        const url = new URL(decodeText(href), "https://orderkuota.com");
        const parts = url.pathname.split("/").filter(Boolean);
        if (url.hostname !== "orderkuota.com" || parts[0] !== "harga" || parts.length < 3) continue;
        providers.push({ name, path: url.pathname });
      } catch {
        // Skip a menu link that is not an operator page.
      }
    }
    if (providers.length > 0) sections.push({ name: decodeText(title), providers });
  }
  return sections;
}

function parseProducts(html) {
  const table = html.match(/<table class="table table-bordered table-striped"[\s\S]*?<\/table>/i)?.[0] ?? "";
  const products = [];
  const seen = new Set();
  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decodeText(cell[1]));
    if (cells.length < 4) continue;
    const [code, name, resellerPrice, publicPrice] = cells;
    if (!code || !name || code.toLowerCase() === "kode" || seen.has(code)) continue;
    seen.add(code);
    products.push({
      code,
      name,
      resellerPrice: resellerPrice.replace(/^rp\s*/i, "").trim(),
      publicPrice: publicPrice.replace(/^rp\s*/i, "").trim(),
    });
  }
  return products;
}

function lastPage(html, pagePath) {
  const escaped = pagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let max = 1;
  for (const match of html.matchAll(new RegExp(`${escaped}\\?page=(\\d+)`, "g"))) {
    const page = Number(match[1]);
    if (page > max) max = page;
  }
  return Math.min(max, MAX_PAGES);
}

function findBrowser() {
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const relatives = [
    ["Microsoft", "Edge", "Application", "msedge.exe"],
    ["Google", "Chrome", "Application", "chrome.exe"],
  ];
  for (const root of roots) {
    for (const parts of relatives) {
      const candidate = path.join(root, ...parts);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function connectBrowser() {
  return new Promise((resolve, reject) => {
    const browserPath = findBrowser();
    if (!browserPath) {
      reject(new Error("Microsoft Edge atau Google Chrome tidak ditemukan di PC ini."));
      return;
    }
    fs.mkdirSync(profileDir, { recursive: true });
    log(`Membuka browser: ${browserPath}`);
    const child = spawn(browserPath, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      PRICE_HOME,
    ], { stdio: "ignore", windowsHide: false });

    child.on("error", reject);
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
        if (!response.ok) return;
        const pages = await response.json();
        const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (!page) return;
        clearInterval(timer);
        resolve({ child, websocketUrl: page.webSocketDebuggerUrl });
      } catch {
        if (Date.now() - started > 30_000) {
          clearInterval(timer);
          reject(new Error("Browser tidak membuka saluran lokal."));
        }
      }
    }, 500);
  });
}

function openSession(websocketUrl) {
  const ws = new WebSocket(websocketUrl);
  let nextId = 0;
  const pending = new Map();

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("Browser menolak sambungan lokal.")));
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "Perintah browser gagal."));
    else waiter.resolve(message.result || {});
  });

  function send(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return {
    ready,
    send,
    close() {
      ws.close();
    },
  };
}

async function pageHtml(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: "document.documentElement ? document.documentElement.outerHTML : ''",
    returnByValue: true,
  });
  return typeof result.result?.value === "string" ? result.result.value : "";
}

async function waitForHtml(session, ready, timeoutMs, waitingNote) {
  const started = Date.now();
  let noted = false;
  while (Date.now() - started < timeoutMs) {
    const html = await pageHtml(session);
    if (ready(html)) return html;
    if (!noted && waitingNote) {
      log(waitingNote);
      noted = true;
    }
    await sleep(1500);
  }
  return "";
}

async function readOperator(session, pageUrl, pagePath) {
  const products = [];
  const seen = new Set();
  let page = 1;
  let pages = 1;
  while (page <= pages) {
    const target = page === 1 ? pageUrl : `${pageUrl}?page=${page}`;
    await session.send("Page.navigate", { url: target });
    const html = await waitForHtml(session, (value) => value.includes("table-bordered"), 90_000, "");
    if (!html) throw new Error(`Tabel harga tidak terbuka pada ${pagePath}`);
    if (page === 1) pages = lastPage(html, pagePath);
    for (const product of parseProducts(html)) {
      if (seen.has(product.code)) continue;
      seen.add(product.code);
      products.push(product);
    }
    page += 1;
  }
  return products;
}

async function api(config, method, body) {
  const response = await fetch(config.uploadUrl, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { error: text.slice(0, 180) };
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Server menolak hasil (${response.status}).`);
  }
  return payload;
}

async function syncOnce(config, session) {
  await session.send("Page.navigate", { url: PRICE_HOME });
  const indexHtml = await waitForHtml(
    session,
    (html) => html.includes("list-group-item") && html.includes("panel-title"),
    5 * 60 * 1000,
    "Menunggu halaman harga. Jika Cloudflare meminta pemeriksaan, selesaikan di jendela browser.",
  );
  if (!indexHtml) throw new Error("Halaman harga belum terbuka di browser.");

  const plan = await api(config, "GET");
  const targets = Array.isArray(plan.providers) ? plan.providers : [];
  if (targets.length === 0) {
    log("Tidak ada operator pada Auto Update. Siklus ini dilewati.");
    return;
  }

  const menu = new Map();
  for (const section of parseIndex(indexHtml)) {
    for (const provider of section.providers) {
      menu.set(`${normalizeName(section.name)}\n${normalizeName(provider.name)}`, provider.path);
    }
  }

  const providers = [];
  for (const target of targets) {
    const categoryName = String(target.categoryName || "");
    const providerName = String(target.providerName || "");
    const pagePath = menu.get(`${normalizeName(categoryName)}\n${normalizeName(providerName)}`);
    if (!pagePath) {
      providers.push({ categoryName, providerName, products: [], error: "Operator tidak ada di halaman harga." });
      log(`Tidak ketemu: ${categoryName} / ${providerName}`);
      continue;
    }
    try {
      const products = await readOperator(session, `https://orderkuota.com${pagePath}`, pagePath);
      providers.push({ categoryName, providerName, products });
      log(`${providers.length}/${targets.length} ${providerName}: ${products.length} produk`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gagal membaca operator.";
      providers.push({ categoryName, providerName, products: [], error: message });
      log(`Gagal ${providerName}: ${message}`);
    }
  }

  await session.send("Page.navigate", { url: PRICE_HOME });
  const result = await api(config, "POST", { providers });
  if (result.skipped) {
    log(result.reason || "Server melewatkan siklus ini.");
    return;
  }
  log(`Terkirim. Produk katalog ${result.products ?? "-"}, Telegram ${result.telegram ?? "-"}, gagal ${result.failedProviders ?? 0}.`);
}

function stopBrowser(child) {
  if (!child?.pid) return;
  spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
}

async function main() {
  const config = loadConfig();
  log(`Pembaruan browser tiap ${Math.round(config.intervalMs / 60000)} menit.`);
  const browser = await connectBrowser();
  const session = openSession(browser.websocketUrl);
  await session.ready;
  await session.send("Page.enable");
  await session.send("Runtime.enable");

  const shutdown = () => {
    log("Program ditutup.");
    session.send("Browser.close").catch(() => stopBrowser(browser.child)).finally(() => {
      session.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (true) {
    const started = Date.now();
    try {
      await syncOnce(config, session);
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
    const pause = Math.max(15_000, config.intervalMs - (Date.now() - started));
    log(`Siklus berikut sekitar ${Math.round(pause / 60000)} menit lagi. Jendela browser tetap terbuka.`);
    await sleep(pause);
  }
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
