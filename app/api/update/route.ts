import { PriceFetchError } from "@/lib/fetch-prices";
import { limitReportDetails } from "@/lib/catalog-store";
import { runPriceUpdate } from "@/lib/run-update";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

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

      try {
        const result = await runPriceUpdate({
          categoryCodes,
          providerCodes,
          onProgress(progress) {
            send({ type: "progress", ...progress });
          },
        });
        send({
          type: "done",
          fetchedAt: result.catalog.fetchedAt,
          productCount: result.catalog.productCount,
          providerCount: result.catalog.providerCount,
          failedProviders: result.catalog.failedProviders,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pembaruan harga gagal.";
        const details = limitReportDetails(error instanceof PriceFetchError ? error.details : []);
        send({ type: "error", message, details });
      } finally {
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
