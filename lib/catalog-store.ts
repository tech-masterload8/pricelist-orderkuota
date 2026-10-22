import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
import type { Catalog, CategoryCatalog, CatalogIndex, ProviderCatalog } from "./types";

const CATALOG_PATH = path.join(process.cwd(), "data", "catalog.json");
const LOCK_PATH = path.join(process.cwd(), "data", "update-lock.json");
const BLOB_PATH = "catalog/catalog.json";
const BLOB_LOCK_PATH = "catalog/update-lock.json";
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
  if (memoryCatalog) return memoryCatalog;

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

export function mergeCatalog(existing: Catalog | null, incoming: Catalog, options?: { mergeProviders?: boolean }): Catalog {
  if (!existing) return recount(incoming);

  const incomingByCode = new Map(incoming.categories.map((category) => [category.code, category]));
  const replaced = new Set<string>();
  const categories = existing.categories.map((category) => {
    const replacement = incomingByCode.get(category.code);
    if (!replacement) return category;
    replaced.add(category.code);
    return options?.mergeProviders ? mergeProviders(category, replacement) : replacement;
  });

  for (const category of incoming.categories) {
    if (!replaced.has(category.code)) categories.push(category);
  }

  return recount({ ...incoming, categories });
}

function mergeProviders(existing: CategoryCatalog, incoming: CategoryCatalog): CategoryCatalog {
  const incomingByCode = new Map(incoming.providers.map((provider) => [provider.code, provider]));
  const replaced = new Set<string>();
  const providers = existing.providers.map((provider) => {
    const replacement = incomingByCode.get(provider.code);
    if (!replacement) return provider;
    replaced.add(provider.code);
    return replacement;
  });

  for (const provider of incoming.providers) {
    if (!replaced.has(provider.code)) providers.push(provider);
  }

  return { ...incoming, providers };
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

export async function releaseUpdateLock() {
  memoryLock = false;
  try {
    await writeLock(null);
  } catch (error) {
    console.error("Gagal melepas kunci pembaruan.", error);
  }
}
