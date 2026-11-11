import {
  acquireUpdateLock,
  canPersistCatalog,
  limitReportDetails,
  mergeCatalog,
  readAutoSelection,
  readCatalog,
  releaseUpdateLock,
  saveCatalog,
  toProductWatch,
  writeUpdateReport,
} from "./catalog-store";
import { catalogFromBrowser, fetchFullCatalog, PriceFetchError, type BrowserProviderPayload } from "./fetch-prices";
import type { Catalog, FetchProgress, ProductWatch, UpdateReport } from "./types";

const PROVIDER_CODE = /^prv_[a-z0-9]+$/i;

export type PriceUpdateResult = {
  catalog: Catalog;
  previous: Catalog | null;
  incoming: Catalog;
  failureDetails: string[];
};

function collectFailureDetails(catalog: Catalog) {
  return catalog.categories.flatMap((category) =>
    category.providers.flatMap((provider) =>
      provider.error ? [`${category.name} / ${provider.name}: ${provider.error}`] : [],
    ),
  );
}

export async function runPriceUpdate(input: {
  providerCodes?: string[];
  categoryCodes?: string[];
  watch?: ProductWatch;
  onProgress?: (progress: FetchProgress) => void;
}): Promise<PriceUpdateResult> {
  if (!canPersistCatalog()) {
    throw new Error("Penyimpanan belum terhubung, jadi pembaruan tidak dijalankan.");
  }

  const lock = await acquireUpdateLock();
  if (!lock.ok) throw new Error(lock.message);

  let providerCodes = input.providerCodes?.filter((code) => PROVIDER_CODE.test(code));
  let categoryCodes = input.categoryCodes;

  try {
    await writeUpdateReport({
      state: "running",
      at: new Date().toISOString(),
      message: "Pembaruan sedang berjalan.",
      details: [],
    });

    const partial = Boolean(categoryCodes?.length || providerCodes?.length);
    let previous: Catalog | null = null;
    try {
      previous = await readCatalog();
    } catch {
      if (partial) throw new Error("Katalog lama tidak bisa dibaca, jadi pembaruan sebagian dibatalkan.");
    }

    if (providerCodes) {
      const known = new Set(previous?.categories.flatMap((category) => category.providers.map((provider) => provider.code)) ?? []);
      providerCodes = providerCodes.filter((code) => known.has(code));
      if (providerCodes.length === 0) {
        throw new Error("Operator yang dipilih tidak ada di katalog.");
      }
      categoryCodes = previous?.categories
        .filter((category) => category.providers.some((provider) => providerCodes?.includes(provider.code)))
        .map((category) => category.code);
    }

    const incoming = await fetchFullCatalog({
      categoryCodes,
      providerCodes,
      previous,
      onProgress: input.onProgress,
    });
    const catalog = partial
      ? mergeCatalog(previous, incoming, { mergeProviders: Boolean(providerCodes?.length), watch: input.watch })
      : incoming;
    await saveCatalog(catalog);
    const failureDetails = limitReportDetails(collectFailureDetails(incoming));
    if (failureDetails.length > 0) {
      await writeUpdateReport({
        state: "warning",
        at: catalog.fetchedAt,
        message: `${incoming.failedProviders} operator gagal diambil. Harga operator itu tidak diganti.`,
        details: failureDetails,
      });
    } else {
      await writeUpdateReport(null);
    }

    return { catalog, previous, incoming, failureDetails };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pembaruan harga gagal.";
    const details = limitReportDetails(error instanceof PriceFetchError ? error.details : []);
    const report: UpdateReport = {
      state: "error",
      at: new Date().toISOString(),
      message,
      details,
    };
    try {
      await writeUpdateReport(report);
    } catch (persistError) {
      console.error("Gagal menyimpan laporan pembaruan.", persistError);
    }
    throw error;
  } finally {
    await releaseUpdateLock();
  }
}

export async function publishBrowserUpdate(rows: BrowserProviderPayload[]): Promise<PriceUpdateResult> {
  if (!canPersistCatalog()) {
    throw new Error("Penyimpanan belum terhubung, jadi pembaruan tidak dijalankan.");
  }

  const lock = await acquireUpdateLock();
  if (!lock.ok) throw new Error(lock.message);

  try {
    await writeUpdateReport({
      state: "running",
      at: new Date().toISOString(),
      message: "Pembaruan dari browser sedang berjalan.",
      details: [],
    });

    const previous = await readCatalog();
    const watch = toProductWatch(await readAutoSelection());
    if (watch.size === 0) {
      throw new Error("Tidak ada produk yang dipilih untuk auto update.");
    }

    const built = catalogFromBrowser(previous, rows);
    const categories = built.catalog.categories.map((category) => ({
      ...category,
      providers: category.providers.filter((provider) => watch.has(provider.code)),
    })).filter((category) => category.providers.length > 0);
    const matched = categories.reduce((sum, category) => sum + category.providers.length, 0);
    const failedProviders = categories.reduce(
      (sum, category) => sum + category.providers.filter((provider) => provider.error).length,
      0,
    );
    const missing = [...watch.keys()].filter((code) => !built.matchedCodes.has(code));
    const failureDetails = limitReportDetails([
      ...built.skipped,
      ...missing.map((code) => `${code}: tidak ada di hasil browser`),
    ]);
    const failed = failedProviders + missing.length;
    if (matched === 0 || failed / watch.size > 0.15) {
      throw new PriceFetchError(
        `${failed} dari ${watch.size} operator gagal dibaca dari browser, jadi katalog lama tidak diganti.`,
        failureDetails,
      );
    }

    const incoming: Catalog = {
      ...built.catalog,
      providerCount: matched,
      failedProviders,
      categories,
    };
    const catalog = mergeCatalog(previous, incoming, { mergeProviders: true, watch });
    await saveCatalog(catalog);
    if (failureDetails.length > 0) {
      await writeUpdateReport({
        state: "warning",
        at: catalog.fetchedAt,
        message: `${failedProviders + missing.length} operator gagal dibaca dari browser. Harga operator itu tidak diganti.`,
        details: failureDetails,
      });
    } else {
      await writeUpdateReport(null);
    }

    return { catalog, previous, incoming, failureDetails };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pembaruan harga gagal.";
    const details = limitReportDetails(error instanceof PriceFetchError ? error.details : []);
    try {
      await writeUpdateReport({
        state: "error",
        at: new Date().toISOString(),
        message,
        details,
      });
    } catch (persistError) {
      console.error("Gagal menyimpan laporan pembaruan.", persistError);
    }
    throw error;
  } finally {
    await releaseUpdateLock();
  }
}
