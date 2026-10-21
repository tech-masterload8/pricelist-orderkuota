import { acquireUpdateLock, canPersistCatalog, releaseUpdateLock, saveCatalog } from "@/lib/catalog-store";
import { fetchFullCatalog } from "@/lib/fetch-prices";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

export async function POST() {
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
        const catalog = await fetchFullCatalog({
          onProgress(progress) {
            send({ type: "progress", ...progress });
          },
        });
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
