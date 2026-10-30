import { acquireUpdateLock, canPersistCatalog, limitReportDetails, mergeCatalog, readCatalog, releaseUpdateLock, saveCatalog, writeUpdateReport } from "@/lib/catalog-store";
import { fetchFullCatalog, PriceFetchError } from "@/lib/fetch-prices";
import type { Catalog, UpdateReport } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

function collectFailureDetails(catalog: Catalog) {
  return catalog.categories.flatMap((category) =>
    category.providers.flatMap((provider) =>
      provider.error ? [`${category.name} / ${provider.name}: ${provider.error}`] : [],
    ),
  );
}

const CATEGORY_CODE = /^[a-z0-9_]+$/i;
const PROVIDER_CODE = /^prv_[a-z0-9]+$/i;

export async function POST(request: Request) {
  let categoryCodes: string[] | undefined;
  let providerCodes: string[] | undefined;
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "providers" in body && Array.isArray(body.providers)) {
      providerCodes = body.providers.filter((code): code is string => typeof code === "string" && PROVIDER_CODE.test(code));
      if (providerCodes.length === 0) {
        return Response.json(
          { error: "Pilih minimal satu operator sebelum memperbarui harga." },
          { status: 400 },
        );
      }
    } else if (body && typeof body === "object" && "categories" in body && Array.isArray(body.categories)) {
      categoryCodes = body.categories.filter((code): code is string => typeof code === "string" && CATEGORY_CODE.test(code));
      if (categoryCodes.length === 0) {
        return Response.json(
          { error: "Pilih minimal satu kategori sebelum memperbarui harga." },
          { status: 400 },
        );
      }
    }
  } catch {
    categoryCodes = undefined;
    providerCodes = undefined;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      if (!canPersistCatalog()) {
        send({
          type: "error",
          message: "Penyimpanan belum terhubung, jadi pembaruan tidak dijalankan.",
        });
        controller.close();
        return;
      }

      const lock = await acquireUpdateLock();
      if (!lock.ok) {
        send({ type: "error", message: lock.message, details: [] });
        controller.close();
        return;
      }

      try {
        await writeUpdateReport({
          state: "running",
          at: new Date().toISOString(),
          message: "Pembaruan sedang berjalan.",
          details: [],
        });
        const partial = Boolean(categoryCodes || providerCodes);
        let existing: Catalog | null = null;
        if (partial) {
          try {
            existing = await readCatalog();
          } catch {
            throw new Error("Katalog lama tidak bisa dibaca, jadi pembaruan sebagian dibatalkan.");
          }
        }

        if (providerCodes) {
          const known = new Set(existing?.categories.flatMap((category) => category.providers.map((provider) => provider.code)) ?? []);
          providerCodes = providerCodes.filter((code) => known.has(code));
          if (providerCodes.length === 0) {
            throw new Error("Operator yang dipilih tidak ada di katalog.");
          }
          categoryCodes = existing?.categories
            .filter((category) => category.providers.some((provider) => providerCodes?.includes(provider.code)))
            .map((category) => category.code);
        }

        const incoming = await fetchFullCatalog({
          categoryCodes,
          providerCodes,
          onProgress(progress) {
            send({ type: "progress", ...progress });
          },
        });
        const catalog = partial ? mergeCatalog(existing, incoming, { mergeProviders: Boolean(providerCodes) }) : incoming;
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
        send({
          type: "done",
          fetchedAt: catalog.fetchedAt,
          productCount: catalog.productCount,
          providerCount: catalog.providerCount,
          failedProviders: catalog.failedProviders,
        });
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
        send({ type: "error", message, details });
      } finally {
        await releaseUpdateLock();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
