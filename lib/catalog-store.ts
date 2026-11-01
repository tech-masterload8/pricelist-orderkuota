import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
import type { AutoSelection, Catalog, CategoryCatalog, CatalogIndex, ProductWatch, ProviderCatalog, UpdateReport } from "./types";

const CATALOG_PATH = path.join(process.cwd(), "data", "catalog.json");
const LOCK_PATH = path.join(process.cwd(), "data", "update-lock.json");
const REPORT_PATH = path.join(process.cwd(), "data", "update-report.json");
const AUTO_SELECTION_PATH = path.join(process.cwd(), "data", "auto-selection.json");
const PRODUCT_CODES_PATH = path.join(process.cwd(), "data", "product-codes.json");
const BLOB_PATH = "catalog/catalog.json";
const BLOB_LOCK_PATH = "catalog/update-lock.json";
const BLOB_REPORT_PATH = "catalog/update-report.json";
const BLOB_AUTO_SELECTION_PATH = "catalog/auto-selection.json";
const BLOB_PRODUCT_CODES_PATH = "catalog/product-codes.json";
const PROVIDER_CODE = /^prv_[a-z0-9]+$/i;
const STALE_RUNNING_MS = 7 * 60 * 1000;
const LOCK_TTL_MS = 20 * 60 * 1000;

let memoryCatalog: Catalog | null = null;
let memoryLock = false;

export function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

export function canPersistCatalog() {
  return blobConfigured() || !process.env.VERCEL;
}

export function toIndex(catalog: Catalog): CatalogIndex {
  return {
    fetchedAt: catalog.fetchedAt,
    productCount: catalog.productCount,
    providerCount: catalog.providerCount,
    failedProviders: catalog.failedProviders,
    report: null,
    categories: catalog.categories.map((category) => ({
      code: category.code,
      name: category.name,
      providers: category.providers.map((provider) => ({
        code: provider.code,
        name: provider.name,
        productCount: provider.products.length,
        error: provider.error,
      })),
    })),
  };
}

export function findProvider(catalog: Catalog, providerCode: string): (ProviderCatalog & { categoryCode: string; categoryName: string }) | null {
  for (const category of catalog.categories) {
    const provider = category.providers.find((item) => item.code === providerCode);
    if (provider) {
      return {
        ...provider,
        categoryCode: category.code,
        categoryName: category.name,
      };
    }
  }
  return null;
}

async function readBlobText(pathname: string) {
  const { get } = await import("@vercel/blob");
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return new Response(result.stream).text();
}

async function writeBlobText(pathname: string, body: string) {
  const { put } = await import("@vercel/blob");
  await put(pathname, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

export async function readCatalog(): Promise<Catalog> {
  if (memoryCatalog && !process.env.VERCEL) return memoryCatalog;

  if (blobConfigured()) {
    try {
      const text = await readBlobText(BLOB_PATH);
      if (text) {
        memoryCatalog = JSON.parse(text) as Catalog;
        return memoryCatalog;
      }
    } catch (error) {
      console.error("Gagal membaca katalog dari Blob, memakai salinan lokal.", error);
    }
  }

  const text = await readFile(CATALOG_PATH, "utf8");
  memoryCatalog = JSON.parse(text) as Catalog;
  return memoryCatalog;
}

export function mergeCatalog(
  existing: Catalog | null,
  incoming: Catalog,
  options?: { mergeProviders?: boolean; watch?: ProductWatch },
): Catalog {
  if (!existing) return recount(incoming);

  const incomingByCode = new Map(incoming.categories.map((category) => [category.code, category]));
  const replaced = new Set<string>();
  const categories = existing.categories.map((category) => {
    const replacement = incomingByCode.get(category.code);
    if (!replacement) return category;
    replaced.add(category.code);
    const merged = options?.mergeProviders ? mergeProviders(category, replacement, options.watch) : replacement;
    return preserveFailedProviders(category, merged);
  });

  for (const category of incoming.categories) {
    if (!replaced.has(category.code)) categories.push(category);
  }

  return recount({ ...incoming, categories });
}

function mergeProviders(existing: CategoryCatalog, incoming: CategoryCatalog, watch?: ProductWatch): CategoryCatalog {
  const incomingByCode = new Map(incoming.providers.map((provider) => [provider.code, provider]));
  const replaced = new Set<string>();
  const providers = existing.providers.map((provider) => {
    const replacement = incomingByCode.get(provider.code);
    if (!replacement) return provider;
    replaced.add(provider.code);
    const rule = watch?.get(provider.code);
    if (rule && rule !== "all") return applyProductWatch(provider, replacement, rule);
    return replacement;
  });

  for (const provider of incoming.providers) {
    if (!replaced.has(provider.code)) providers.push(provider);
  }

  return { ...incoming, providers };
}

function applyProductWatch(existing: ProviderCatalog, incoming: ProviderCatalog, ids: ReadonlySet<number>): ProviderCatalog {
  if (incoming.error) return { ...existing, name: incoming.name || existing.name, error: incoming.error };
  const incomingById = new Map(incoming.products.map((product) => [product.id, product]));
  const seen = new Set<number>();
  const products = existing.products.flatMap((product) => {
    if (!ids.has(product.id)) return [product];
    seen.add(product.id);
    const next = incomingById.get(product.id);
    return next ? [next] : [];
  });
  for (const id of ids) {
    if (seen.has(id)) continue;
    const next = incomingById.get(id);
    if (next) products.push(next);
  }
  return { ...existing, name: incoming.name || existing.name, error: null, products };
}

function preserveFailedProviders(existing: CategoryCatalog, incoming: CategoryCatalog): CategoryCatalog {
  const previous = new Map(existing.providers.map((provider) => [provider.code, provider]));
  return {
    ...incoming,
    providers: incoming.providers.map((provider) => {
      if (!provider.error) return provider;
      const prior = previous.get(provider.code);
      if (!prior) return provider;
      return { ...prior, name: provider.name || prior.name, error: provider.error };
    }),
  };
}

function recount(catalog: Catalog): Catalog {
  let productCount = 0;
  let providerCount = 0;
  let failedProviders = 0;

  for (const category of catalog.categories) {
    for (const provider of category.providers) {
      providerCount += 1;
      productCount += provider.products.length;
      if (provider.error) failedProviders += 1;
    }
  }

  return { ...catalog, productCount, providerCount, failedProviders };
}

export async function saveCatalog(catalog: Catalog) {
  const body = JSON.stringify(catalog);
  let persisted = false;

  if (blobConfigured()) {
    await writeBlobText(BLOB_PATH, body);
    persisted = true;
  }

  if (!process.env.VERCEL) {
    try {
      await mkdir(path.dirname(CATALOG_PATH), { recursive: true });
      const temporaryPath = `${CATALOG_PATH}.tmp`;
      await writeFile(temporaryPath, body);
      await rm(CATALOG_PATH, { force: true });
      await rename(temporaryPath, CATALOG_PATH);
      persisted = true;
    } catch (error) {
      if (!persisted) throw error;
      console.error("Katalog tersimpan di Blob. Salinan disk tidak bisa ditulis.", error);
    }
  }

  memoryCatalog = catalog;
}

type LockFile = { startedAt: string };

async function readLock(): Promise<LockFile | null> {
  if (blobConfigured()) {
    try {
      const text = await readBlobText(BLOB_LOCK_PATH);
      if (text) return JSON.parse(text) as LockFile;
    } catch {
      return null;
    }
  }

  try {
    return JSON.parse(await readFile(LOCK_PATH, "utf8")) as LockFile;
  } catch {
    return null;
  }
}

async function writeLock(lock: LockFile | null) {
  const body = lock ? JSON.stringify(lock) : "";
  if (blobConfigured() && lock) {
    await writeBlobText(BLOB_LOCK_PATH, body);
  }
  if (!lock) {
    if (blobConfigured()) {
      try {
        const { del } = await import("@vercel/blob");
        await del(BLOB_LOCK_PATH);
      } catch {
        // A missing lock is already unlocked.
      }
    }
  }

  if (process.env.VERCEL) return;

  try {
    if (!lock) {
      await rm(LOCK_PATH, { force: true });
      return;
    }
    await mkdir(path.dirname(LOCK_PATH), { recursive: true });
    await writeFile(LOCK_PATH, body);
  } catch (error) {
    if (!blobConfigured()) throw error;
  }
}

export async function acquireUpdateLock(): Promise<{ ok: true } | { ok: false; message: string }> {
  if (memoryLock) {
    return { ok: false, message: "Pembaruan sedang berjalan." };
  }

  const existing = await readLock();
  if (existing && Date.now() - Date.parse(existing.startedAt) < LOCK_TTL_MS) {
    return { ok: false, message: "Pembaruan sedang berjalan. Biarkan halaman tetap terbuka sampai selesai." };
  }

  memoryLock = true;
  try {
    await writeLock({ startedAt: new Date().toISOString() });
  } catch (error) {
    memoryLock = false;
    const message = error instanceof Error ? error.message : "Kunci pembaruan gagal ditulis.";
    return { ok: false, message };
  }

  return { ok: true };
}

function parseUpdateReport(text: string): UpdateReport | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return null;
    const report = value as Partial<UpdateReport>;
    if (report.state !== "running" && report.state !== "error" && report.state !== "warning") return null;
    if (typeof report.at !== "string" || typeof report.message !== "string") return null;
    const details = Array.isArray(report.details) ? report.details.filter((item): item is string => typeof item === "string") : [];
    return { state: report.state, at: report.at, message: report.message, details };
  } catch {
    return null;
  }
}

async function readStoredUpdateReport(): Promise<UpdateReport | null> {
  if (blobConfigured()) {
    try {
      const text = await readBlobText(BLOB_REPORT_PATH);
      if (text) return parseUpdateReport(text);
    } catch (error) {
      console.error("Gagal membaca laporan pembaruan.", error);
    }
  }

  try {
    return parseUpdateReport(await readFile(REPORT_PATH, "utf8"));
  } catch {
    return null;
  }
}

export async function readUpdateReport(): Promise<UpdateReport | null> {
  const report = await readStoredUpdateReport();
  if (!report) return null;
  if (report.state === "running" && Date.now() - Date.parse(report.at) > STALE_RUNNING_MS) {
    return {
      state: "error",
      at: report.at,
      message: "Pembaruan terputus sebelum selesai. Katalog lama tetap dipakai.",
      details: ["Server berhenti sebelum hasil pembaruan tersimpan."],
    };
  }
  return report;
}

export async function writeUpdateReport(report: UpdateReport | null) {
  if (!report) {
    if (blobConfigured()) {
      try {
        const { del } = await import("@vercel/blob");
        await del(BLOB_REPORT_PATH);
      } catch {
        // A missing report is already clear.
      }
    }
    if (!process.env.VERCEL) await rm(REPORT_PATH, { force: true });
    return;
  }

  const body = JSON.stringify(report);
  if (blobConfigured()) await writeBlobText(BLOB_REPORT_PATH, body);
  if (process.env.VERCEL) return;

  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, body);
}

export function limitReportDetails(details: string[], limit = 8) {
  if (details.length <= limit) return details;
  return [...details.slice(0, limit), `dan ${details.length - limit} operator lain gagal.`];
}

const EMPTY_AUTO_SELECTION: AutoSelection = { providers: [], products: [] };

function parseAutoSelection(text: string): AutoSelection {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return EMPTY_AUTO_SELECTION;
    const record = value as { providers?: unknown; products?: unknown };
    const providers = Array.isArray(record.providers)
      ? [...new Set(record.providers.filter((code): code is string => typeof code === "string" && PROVIDER_CODE.test(code)))]
      : [];
    const full = new Set(providers);
    const products = Array.isArray(record.products)
      ? record.products.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const product = item as { providerCode?: unknown; productId?: unknown };
          if (typeof product.providerCode !== "string" || !PROVIDER_CODE.test(product.providerCode)) return [];
          if (typeof product.productId !== "number" || !Number.isInteger(product.productId) || product.productId <= 0) return [];
          if (full.has(product.providerCode)) return [];
          return [{ providerCode: product.providerCode, productId: product.productId }];
        })
      : [];
    return { providers, products };
  } catch {
    return EMPTY_AUTO_SELECTION;
  }
}

export function countSelectedProducts(catalog: Catalog, selection: AutoSelection) {
  const full = new Set(selection.providers);
  const known = new Set<string>();
  let count = 0;
  for (const category of catalog.categories) {
    for (const provider of category.providers) {
      known.add(provider.code);
      if (full.has(provider.code)) count += provider.products.length;
    }
  }
  const seen = new Set<string>();
  for (const product of selection.products) {
    if (!known.has(product.providerCode)) continue;
    const key = `${product.providerCode}:${product.productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

export function toProductWatch(selection: AutoSelection): ProductWatch {
  const watch = new Map<string, "all" | Set<number>>();
  for (const code of selection.providers) watch.set(code, "all");
  for (const product of selection.products) {
    const current = watch.get(product.providerCode);
    if (current === "all") continue;
    const ids = current ?? new Set<number>();
    ids.add(product.productId);
    watch.set(product.providerCode, ids);
  }
  return watch;
}

export async function readAutoSelection(): Promise<AutoSelection> {
  let text: string | null = null;
  if (blobConfigured()) {
    try {
      text = await readBlobText(BLOB_AUTO_SELECTION_PATH);
    } catch (error) {
      console.error("Gagal membaca pilihan auto update.", error);
    }
  }

  if (!text) {
    try {
      text = await readFile(AUTO_SELECTION_PATH, "utf8");
    } catch {
      return EMPTY_AUTO_SELECTION;
    }
  }

  return parseAutoSelection(text);
}

export async function writeAutoSelection(selection: { providers?: unknown; products?: unknown }) {
  const normalized = parseAutoSelection(JSON.stringify({ providers: selection.providers ?? [], products: selection.products ?? [] }));
  const body = JSON.stringify(normalized);
  if (blobConfigured()) await writeBlobText(BLOB_AUTO_SELECTION_PATH, body);
  if (process.env.VERCEL) {
    if (!blobConfigured()) throw new Error("Penyimpanan belum terhubung, jadi pilihan auto update tidak disimpan.");
    return;
  }

  await mkdir(path.dirname(AUTO_SELECTION_PATH), { recursive: true });
  await writeFile(AUTO_SELECTION_PATH, body);
}

function sanitizeProductCodes(value: unknown) {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const codes = new Map<number, string>();
  for (const [key, raw] of Object.entries(source)) {
    if (!/^[1-9]\d*$/.test(key) || typeof raw !== "string") continue;
    const code = raw.trim().replace(/[\u0000-\u001F\u007F]/g, "");
    if (!code || code.length > 80) continue;
    codes.set(Number(key), code);
  }
  return codes;
}

async function readProductCodeText() {
  if (blobConfigured()) {
    try {
      const text = await readBlobText(BLOB_PRODUCT_CODES_PATH);
      if (text) return text;
    } catch (error) {
      console.error("Gagal membaca kode Masterload8.", error);
    }
  }

  try {
    return await readFile(PRODUCT_CODES_PATH, "utf8");
  } catch {
    return null;
  }
}

export async function readProductCodes() {
  const text = await readProductCodeText();
  if (!text) return new Map<number, string>();
  try {
    const value: unknown = JSON.parse(text);
    const record = value && typeof value === "object" && "codes" in value ? value.codes : {};
    return sanitizeProductCodes(record);
  } catch {
    return new Map<number, string>();
  }
}

export async function writeProductCodes(codes: unknown) {
  const normalized = sanitizeProductCodes(codes);
  const body = JSON.stringify({ codes: Object.fromEntries(normalized) });
  if (blobConfigured()) await writeBlobText(BLOB_PRODUCT_CODES_PATH, body);
  if (process.env.VERCEL) {
    if (!blobConfigured()) throw new Error("Penyimpanan belum terhubung, jadi kode Masterload8 tidak disimpan.");
    return;
  }

  await mkdir(path.dirname(PRODUCT_CODES_PATH), { recursive: true });
  await writeFile(PRODUCT_CODES_PATH, body);
}

export async function releaseUpdateLock() {
  memoryLock = false;
  try {
    await writeLock(null);
  } catch (error) {
    console.error("Gagal melepas kunci pembaruan.", error);
  }
}
