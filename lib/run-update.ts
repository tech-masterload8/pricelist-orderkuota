import {
  acquireUpdateLock,
  canPersistCatalog,
  limitReportDetails,
  mergeCatalog,
  readCatalog,
  releaseUpdateLock,
  saveCatalog,
  writeUpdateReport,
} from "./catalog-store";
import { fetchFullCatalog, PriceFetchError } from "./fetch-prices";
import type { Catalog, FetchProgress, UpdateReport } from "./types";

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
    if (partial) {
      try {
        previous = await readCatalog();
      } catch {
        throw new Error("Katalog lama tidak bisa dibaca, jadi pembaruan sebagian dibatalkan.");
      }
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
      onProgress: input.onProgress,
    });
    const catalog = partial ? mergeCatalog(previous, incoming, { mergeProviders: Boolean(providerCodes?.length) }) : incoming;
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
