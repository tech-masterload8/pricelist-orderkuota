import type { Catalog, FetchProgress, Product } from "./types";

const BASE_URL = "https://orderkuota.com";
const MAX_PAGES = 40;
const CONCURRENCY = 4;

const PAGE_HEADERS = {
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

type NamedCode = { code: string; name: string };

type ProviderLink = {
  name: string;
  path: string;
  slug: string;
};

type PriceSection = {
  name: string;
  slug: string;
  providers: ProviderLink[];
};

type Identity = {
  categories: Map<string, NamedCode>;
  providers: Map<string, NamedCode>;
  products: Map<string, number>;
  usedIds: Set<number>;
  usedProviderCodes: Set<string>;
  usedCategoryCodes: Set<string>;
};

type ProviderJob = {
  categoryCode: string;
  categoryName: string;
  providerCode: string;
  providerName: string;
  path: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PriceFetchError extends Error {
  details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "PriceFetchError";
    this.details = details;
  }
}

function failureCause(error: unknown) {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string") parts.push(record.code);
    if (typeof record.message === "string" && record.message !== "fetch failed") parts.push(record.message);
    current = Array.isArray(record.errors) ? record.errors[0] : record.cause;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function unreachable(pathname: string, error: unknown) {
  const cause = failureCause(error);
  const suffix = cause ? ` Penyebab: ${cause}.` : "";
  return new Error(`Orderkuota tidak bisa dihubungi pada ${pathname}.${suffix} Katalog lama tetap dipakai.`);
}

function decodeText(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, digits: string) => {
      const code = Number(digits);
      return code > 31 && code < 127 ? String.fromCharCode(code) : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value: string) {
  return decodeText(value).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

function priceText(value: string) {
  return decodeText(value).replace(/^rp\s*/i, "").trim();
}

function isChallenge(html: string) {
  const head = html.slice(0, 4000).toLowerCase();
  return head.includes("just a moment") || head.includes("cf-challenge") || head.includes("challenge-platform") || head.includes("cdn-cgi/challenge");
}

function identityFrom(previous: Catalog | null): Identity {
  const categories = new Map<string, NamedCode>();
  const providers = new Map<string, NamedCode>();
  const products = new Map<string, number>();
  const usedIds = new Set<number>();
  const usedProviderCodes = new Set<string>();
  const usedCategoryCodes = new Set<string>();
  if (!previous) return { categories, providers, products, usedIds, usedProviderCodes, usedCategoryCodes };

  for (const category of previous.categories) {
    categories.set(normalizeName(category.name), { code: category.code, name: category.name });
    usedCategoryCodes.add(category.code);
    for (const provider of category.providers) {
      providers.set(`${category.code}\n${normalizeName(provider.name)}`, { code: provider.code, name: provider.name });
      usedProviderCodes.add(provider.code);
      for (const product of provider.products) {
        products.set(`${provider.code}\n${product.code.trim()}`, product.id);
        usedIds.add(product.id);
      }
    }
  }

  return { categories, providers, products, usedIds, usedProviderCodes, usedCategoryCodes };
}

function takeCode(base: string, used: Set<string>) {
  const root = base || "item";
  let code = root;
  let suffix = 2;
  while (used.has(code)) {
    code = `${root}${suffix}`;
    suffix += 1;
  }
  used.add(code);
  return code;
}

function stableProductId(key: string, used: Set<number>) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let id = 1_000_000 + ((hash >>> 0) % 800_000_000);
  while (used.has(id)) id += 1;
  used.add(id);
  return id;
}

async function getHtml(path: string, attempt = 0): Promise<string> {
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: PAGE_HEADERS,
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    const html = await response.text();
    if (isChallenge(html) || response.status === 403) {
      throw new Error(`Orderkuota menolak permintaan otomatis pada ${path}. Katalog lama tetap dipakai.`);
    }
    if (!response.ok) {
      if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
        await sleep(500 * 2 ** attempt);
        return getHtml(path, attempt + 1);
      }
      throw new Error(`Permintaan ke Orderkuota gagal (${response.status}) pada ${path}`);
    }
    return html;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("Orderkuota menolak permintaan otomatis") || message.startsWith("Permintaan ke Orderkuota gagal")) {
      throw error;
    }
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (attempt < 2) {
      await sleep(500 * 2 ** attempt);
      return getHtml(path, attempt + 1);
    }
    if (timedOut) throw new Error(`Orderkuota tidak menjawab dalam 25 detik pada ${path}`);
    if (message === "fetch failed" || error instanceof TypeError) throw unreachable(path, error);
    throw error;
  }
}

function providerPath(href: string) {
  try {
    const url = new URL(decodeText(href), BASE_URL);
    if (url.hostname !== "orderkuota.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 3 || parts[0] !== "harga") return null;
    return { path: url.pathname, slug: parts[parts.length - 1] };
  } catch {
    return null;
  }
}

function parseIndex(html: string): PriceSection[] {
  const panels = html.split('<div class="panel panel-default"').slice(1);
  const sections: PriceSection[] = [];

  for (const panel of panels) {
    const title = panel.match(/<h3 class="panel-title">\s*<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1];
    const collapse = panel.match(/\b(?:href="#|id=")(collapse_[a-z0-9_]+)"/i)?.[1];
    if (!title || !collapse) continue;
    const providers: ProviderLink[] = [];
    for (const match of panel.matchAll(/<a\b([^>]*\bclass="list-group-item[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = match[1].match(/\bhref="([^"]+)"/i)?.[1];
      const located = href ? providerPath(href) : null;
      const name = decodeText(match[2]);
      if (!located || !name) continue;
      providers.push({ name, path: located.path, slug: located.slug });
    }
    if (providers.length === 0) continue;
    sections.push({ name: decodeText(title), slug: collapse.replace(/^collapse_/, ""), providers });
  }

  return sections;
}

function parseProducts(html: string, path: string) {
  const table = html.match(/<table class="table table-bordered table-striped"[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error(`Tabel harga tidak ditemukan pada ${path}`);

  const products: { code: string; name: string; resellerPrice: string; publicPrice: string }[] = [];
  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
    if (cells.length < 4) continue;
    const code = decodeText(cells[0]);
    const name = decodeText(cells[1]);
    if (!code || !name || code.toLowerCase() === "kode") continue;
    products.push({
      code,
      name,
      resellerPrice: priceText(cells[2]),
      publicPrice: priceText(cells[3]),
    });
  }
  return products;
}

function lastPage(html: string, path: string) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\?page=(\\d+)`, "g");
  let max = 1;
  for (const match of html.matchAll(pattern)) {
    const page = Number(match[1]);
    if (page > max) max = page;
  }
  return Math.min(max, MAX_PAGES);
}

type ParsedProduct = { code: string; name: string; resellerPrice: string; publicPrice: string };

async function fetchProviderRows(path: string): Promise<ParsedProduct[]> {
  const first = await getHtml(path);
  const rows = parseProducts(first, path);
  const pages = lastPage(first, path);
  for (let page = 2; page <= pages; page += 1) {
    const html = await getHtml(`${path}?page=${page}`);
    rows.push(...parseProducts(html, path));
  }

  const products: ParsedProduct[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.code)) continue;
    seen.add(row.code);
    products.push(row);
  }
  return products;
}

function assignProductIds(rows: ParsedProduct[], providerCode: string, identity: Identity): Product[] {
  return rows.map((row) => {
    const key = `${providerCode}\n${row.code}`;
    const existing = identity.products.get(key);
    const id = existing ?? stableProductId(key, identity.usedIds);
    if (existing === undefined) identity.products.set(key, id);
    return {
      id,
      code: row.code,
      name: row.name,
      resellerPrice: row.resellerPrice,
      publicPrice: row.publicPrice,
    };
  });
}

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current]);
    }
  }

  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

export async function fetchFullCatalog(options?: {
  onProgress?: (progress: FetchProgress) => void;
  categoryCodes?: string[];
  providerCodes?: string[];
  previous?: Catalog | null;
}): Promise<Catalog> {
  const indexHtml = await getHtml("/harga");
  const sections = parseIndex(indexHtml);
  if (sections.length === 0) {
    throw new PriceFetchError("Halaman harga Orderkuota tidak berisi daftar operator. Katalog lama tetap dipakai.");
  }

  const identity = identityFrom(options?.previous ?? null);
  const wantedCategories = options?.categoryCodes?.length ? new Set(options.categoryCodes) : null;
  const wantedProviders = options?.providerCodes?.length ? new Set(options.providerCodes) : null;
  const jobs: ProviderJob[] = [];
  const categoryOrder: { code: string; name: string }[] = [];

  for (const section of sections) {
    const matchedCategory = identity.categories.get(normalizeName(section.name));
    const categoryCode = matchedCategory?.code ?? takeCode(section.slug, identity.usedCategoryCodes);
    const categoryName = matchedCategory?.name ?? section.name;
    if (wantedCategories && !wantedCategories.has(categoryCode)) continue;

    const providers: ProviderJob[] = [];
    for (const link of section.providers) {
      const providerKey = `${categoryCode}\n${normalizeName(link.name)}`;
      const matchedProvider = identity.providers.get(providerKey);
      if (matchedProvider) identity.providers.delete(providerKey);
      const slugCode = link.slug.toLowerCase().replace(/[^a-z0-9]/g, "");
      const providerCode = matchedProvider?.code ?? takeCode(slugCode ? `prv_${slugCode}` : "prv_operator", identity.usedProviderCodes);
      if (wantedProviders && !wantedProviders.has(providerCode)) continue;
      providers.push({
        categoryCode,
        categoryName,
        providerCode,
        providerName: matchedProvider?.name ?? link.name,
        path: link.path,
      });
    }
    if (providers.length === 0) continue;
    categoryOrder.push({ code: categoryCode, name: categoryName });
    jobs.push(...providers);
  }

  if (jobs.length === 0) {
    throw new Error(
      wantedProviders
        ? "Operator yang dipilih tidak ditemukan di halaman harga Orderkuota."
        : "Tidak ada operator pada halaman harga Orderkuota.",
    );
  }

  let completed = 0;
  const loaded = await mapPool(jobs, CONCURRENCY, async (job) => {
    try {
      const rows = await fetchProviderRows(job.path);
      return { ...job, rows, error: null as string | null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gagal mengambil produk.";
      return { ...job, rows: [] as ParsedProduct[], error: message };
    } finally {
      completed += 1;
      options?.onProgress?.({
        completed,
        total: jobs.length,
        providerName: job.providerName,
      });
    }
  });

  const withIds = loaded.map((job) => ({
    ...job,
    products: job.error ? [] : assignProductIds(job.rows, job.providerCode, identity),
  }));
  const failureDetails = withIds.flatMap((job) => (job.error ? [`${job.categoryName} / ${job.providerName}: ${job.error}`] : []));
  if (failureDetails.length / jobs.length > 0.15) {
    throw new PriceFetchError(
      `${failureDetails.length} dari ${jobs.length} operator gagal diambil, jadi katalog lama tidak diganti.`,
      failureDetails,
    );
  }

  const categories = categoryOrder.map((category) => ({
    code: category.code,
    name: category.name,
    providers: withIds
      .filter((job) => job.categoryCode === category.code)
      .map((job) => ({
        code: job.providerCode,
        name: job.providerName,
        error: job.error,
        products: job.products,
      })),
  }));

  const productCount = categories.reduce(
    (sum, category) => sum + category.providers.reduce((inner, provider) => inner + provider.products.length, 0),
    0,
  );
  if (productCount === 0) {
    throw new Error("Tidak ada produk yang diterima. Katalog yang tersimpan tidak diganti.");
  }

  return {
    fetchedAt: new Date().toISOString(),
    productCount,
    providerCount: jobs.length,
    failedProviders: failureDetails.length,
    categories,
  };
}
