import { acquireUpdateLock, canPersistCatalog, mergeCatalog, readCatalog, releaseUpdateLock, saveCatalog } from "@/lib/catalog-store";
import { fetchFullCatalog } from "@/lib/fetch-prices";
import type { Catalog } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

const CATEGORY_CODE = /^[a-z0-9_]+$/i;

export async function POST(request: Request) {
  let categoryCodes: string[] | undefined;
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "categories" in body && Array.isArray(body.categories)) {
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
        send({ type: "error", message: lock.message });
        controller.close();
        return;
      }

      try {
        let existing: Catalog | null = null;
        if (categoryCodes) {
          try {
            existing = await readCatalog();
          } catch {
            throw new Error("Katalog lama tidak bisa dibaca, jadi pembaruan sebagian dibatalkan.");
          }
        }

        const incoming = await fetchFullCatalog({
          categoryCodes,
          onProgress(progress) {
            send({ type: "progress", ...progress });
          },
        });
        const catalog = categoryCodes ? mergeCatalog(existing, incoming) : incoming;
        await saveCatalog(catalog);
        send({
          type: "done",
          fetchedAt: catalog.fetchedAt,
          productCount: catalog.productCount,
          providerCount: catalog.providerCount,
          failedProviders: catalog.failedProviders,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pembaruan harga gagal.";
        send({ type: "error", message });
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
