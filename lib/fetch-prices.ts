import type { Catalog, FetchProgress, Product } from "./types";

const BASE_URL = "https://id.orderkuota.com";
const MAX_PAGES = 50;
const CONCURRENCY = 4;

type PricePayload = {
  amount?: number;
  formatted?: string;
};

type ProductRow = {
  id?: number;
  code?: string;
  name?: string;
  reseller_price?: PricePayload;
  public_price?: PricePayload;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class PriceFetchError extends Error {
  details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "PriceFetchError";
    this.details = details;
  }
}

function remoteMessage(body: Record<string, unknown>) {
  const remote = [body.message, body.error].find((item) => typeof item === "string" && item.trim());
  return typeof remote === "string" ? ` Pesan server: ${remote.trim().slice(0, 180)}.` : "";
}

function unexpectedResponse(pathname: string, body: Record<string, unknown>, expected: string): never {
  throw new PriceFetchError(`Endpoint Orderkuota berubah (${pathname}): ${expected}.${remoteMessage(body)}`);
}

function formatPrice(price: PricePayload | undefined) {
  if (typeof price?.formatted === "string" && price.formatted.trim()) {
    return price.formatted.trim();
  }
  if (typeof price?.amount === "number" && Number.isFinite(price.amount)) {
    return new Intl.NumberFormat("id-ID").format(price.amount);
  }
  return "";
}

async function getJson(pathname: string, attempt = 0): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });

    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      await sleep(wait);
      return getJson(pathname, attempt + 1);
    }

    if (!response.ok) {
      const kind = response.status === 404 ? "Endpoint Orderkuota tidak ditemukan" : "Permintaan ke Orderkuota gagal";
      throw new Error(`${kind} (${response.status}) pada ${pathname}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Endpoint Orderkuota berubah (${pathname}): respons bukan JSON.`);
    }
    if (!isRecord(body)) {
      throw new Error(`Endpoint Orderkuota berubah (${pathname}): respons bukan objek JSON.`);
    }
    return body;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut && attempt < 3) {
      await sleep(500 * 2 ** attempt);
      return getJson(pathname, attempt + 1);
    }
    if (timedOut) {
      throw new Error(`Orderkuota tidak menjawab dalam 25 detik pada ${pathname}`);
    }
    if (attempt < 3 && !message.startsWith("Permintaan ke Orderkuota") && !message.startsWith("Endpoint Orderkuota")) {
      await sleep(500 * 2 ** attempt);
      return getJson(pathname, attempt + 1);
    }
    throw error;
  }
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

async function fetchProviderProducts(providerCode: string) {
  const products: Product[] = [];
  const seen = new Set<number>();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= MAX_PAGES) {
    const body = await getJson(`/api/v1/prices/providers/${encodeURIComponent(providerCode)}?page=${page}`);
    if (body.success !== true) {
      unexpectedResponse(`/api/v1/prices/providers/${providerCode}?page=${page}`, body, "permintaan produk ditolak");
    }

    const pagination = isRecord(body.pagination) ? body.pagination : {};
    const reportedPages = Number(pagination.total_pages);
    totalPages = Number.isFinite(reportedPages) && reportedPages >= 1 ? reportedPages : 1;

    const rows = Array.isArray(body.data) ? (body.data as ProductRow[]) : [];
    if (!Array.isArray(body.data)) {
      unexpectedResponse(`/api/v1/prices/providers/${providerCode}?page=${page}`, body, "daftar produk tidak ditemukan");
    }
    if (rows.length > 0 && rows.every((row) => !row || typeof row.id !== "number")) {
      unexpectedResponse(
        `/api/v1/prices/providers/${providerCode}?page=${page}`,
        body,
        "field id produk tidak ada",
      );
    }
    if (rows.length === 0) break;

    let added = 0;
    for (const row of rows) {
      if (!row || typeof row.id !== "number" || seen.has(row.id)) continue;
      seen.add(row.id);
      added += 1;
      products.push({
        id: row.id,
        code: String(row.code ?? ""),
        name: String(row.name ?? ""),
        resellerPrice: formatPrice(row.reseller_price),
        publicPrice: formatPrice(row.public_price),
      });
    }

    if (added === 0) break;
    page += 1;
  }

  return products;
}

export async function fetchFullCatalog(options?: {
  onProgress?: (progress: FetchProgress) => void;
  categoryCodes?: string[];
  providerCodes?: string[];
}): Promise<Catalog> {
  const categoryBody = await getJson("/api/v1/prices/categories");
  if (categoryBody.success !== true || !Array.isArray(categoryBody.data)) {
    unexpectedResponse("/api/v1/prices/categories", categoryBody, "daftar kategori tidak ditemukan");
  }

  const categories = categoryBody.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.code !== "string" || typeof entry.name !== "string") return [];
    return [{ code: entry.code, name: entry.name }];
  });

  if (categories.length === 0) {
    unexpectedResponse("/api/v1/prices/categories", categoryBody, "kategori tidak punya kode dan nama");
  }

  const requested = options?.categoryCodes;
  const selectedCategories = requested
    ? categories.filter((category) => requested.includes(category.code))
    : categories;

  if (requested) {
    const missing = requested.filter((code) => !categories.some((category) => category.code === code));
    if (missing.length > 0) {
      throw new Error(`Kategori tidak ditemukan: ${missing.join(", ")}.`);
    }
  }

  if (selectedCategories.length === 0) {
    throw new Error("Tidak ada kategori yang dipilih.");
  }

  const grouped = await mapPool(selectedCategories, CONCURRENCY, async (category) => {
    const body = await getJson(`/api/v1/prices/categories/${encodeURIComponent(category.code)}/providers`);
    if (body.success !== true || !Array.isArray(body.data)) {
      unexpectedResponse(
        `/api/v1/prices/categories/${category.code}/providers`,
        body,
        `daftar operator untuk ${category.name} tidak ditemukan`,
      );
    }
    const parsed = body.data.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.code !== "string" || typeof entry.name !== "string") return [];
      return [{ code: entry.code, name: entry.name }];
    });
    if (body.data.length > 0 && parsed.length === 0) {
      unexpectedResponse(
        `/api/v1/prices/categories/${category.code}/providers`,
        body,
        `operator ${category.name} tidak punya kode dan nama`,
      );
    }
    const providers = parsed.filter((provider) => !options?.providerCodes || options.providerCodes.includes(provider.code));
    return { category, providers };
  });

  const jobs = grouped.flatMap((group) =>
    group.providers.map((provider) => ({ categoryCode: group.category.code, provider })),
  );

  if (jobs.length === 0) {
    throw new Error(options?.providerCodes ? "Operator yang dipilih tidak ditemukan." : "Tidak ada provider pada daftar harga.");
  }

  let completed = 0;
  const loaded = await mapPool(jobs, CONCURRENCY, async (job) => {
    try {
      const products = await fetchProviderProducts(job.provider.code);
      return { ...job, products, error: null as string | null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gagal mengambil produk.";
      return { ...job, products: [] as Product[], error: message };
    } finally {
      completed += 1;
      options?.onProgress?.({
        completed,
        total: jobs.length,
        providerName: job.provider.name,
      });
    }
  });

  const categoryNames = new Map(grouped.map((group) => [group.category.code, group.category.name]));
  const failureDetails = loaded.flatMap((job) =>
    job.error ? [`${categoryNames.get(job.categoryCode) ?? job.categoryCode} / ${job.provider.name}: ${job.error}`] : [],
  );
  const failedProviders = failureDetails.length;
  if (failedProviders / jobs.length > 0.15) {
    throw new PriceFetchError(
      `${failedProviders} dari ${jobs.length} operator gagal diambil, jadi katalog lama tidak diganti.`,
      failureDetails,
    );
  }

  const categoriesWithProducts = grouped.map((group) => ({
    code: group.category.code,
    name: group.category.name,
    providers: loaded
      .filter((job) => job.categoryCode === group.category.code)
      .map((job) => ({
        code: job.provider.code,
        name: job.provider.name,
        error: job.error,
        products: job.products,
      })),
  }));

  const productCount = categoriesWithProducts.reduce(
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
    failedProviders,
    categories: categoriesWithProducts,
  };
}
