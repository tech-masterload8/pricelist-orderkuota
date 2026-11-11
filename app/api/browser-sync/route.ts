import { readAutoSelection, readCatalog, readProductCodes, toProductWatch, writeUpdateReport } from "@/lib/catalog-store";
import { PriceFetchError, type BrowserProviderPayload } from "@/lib/fetch-prices";
import { describePriceChanges } from "@/lib/price-changes";
import { publishBrowserUpdate } from "@/lib/run-update";
import { sendTelegramMessages, telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const MAX_PROVIDERS = 600;
const MAX_PRODUCTS = 800;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function cleanText(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function payload(body: unknown): BrowserProviderPayload[] {
  if (!body || typeof body !== "object" || !("providers" in body) || !Array.isArray(body.providers)) {
    throw new Error("Hasil browser tidak valid.");
  }
  if (body.providers.length > MAX_PROVIDERS) throw new Error("Hasil browser terlalu besar.");

  return body.providers.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Hasil browser tidak valid.");
    const record = entry as Record<string, unknown>;
    const products = Array.isArray(record.products) ? record.products : [];
    if (products.length > MAX_PRODUCTS) throw new Error("Hasil browser terlalu besar.");
    return {
      categoryName: cleanText(record.categoryName, 120),
      providerName: cleanText(record.providerName, 160),
      error: cleanText(record.error, 180) || null,
      products: products.flatMap((product) => {
        if (!product || typeof product !== "object") return [];
        const row = product as Record<string, unknown>;
        const code = cleanText(row.code, 40);
        const name = cleanText(row.name, 180);
        if (!code || !name) return [];
        return [{
          code,
          name,
          resellerPrice: cleanText(row.resellerPrice, 32),
          publicPrice: cleanText(row.publicPrice, 32),
        }];
      }),
    };
  });
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Tidak diizinkan." }, { status: 401 });
  }

  const [catalog, selection] = await Promise.all([readCatalog(), readAutoSelection()]);
  const watch = toProductWatch(selection);
  const providers = catalog.categories.flatMap((category) =>
    category.providers.flatMap((provider) =>
      watch.has(provider.code) ? [{ categoryName: category.name, providerName: provider.name }] : [],
    ),
  );

  return Response.json(
    { providers },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Tidak diizinkan." }, { status: 401 });
  }

  try {
    const rows = payload(await request.json());
    const result = await publishBrowserUpdate(rows);
    const messages = describePriceChanges(result.previous, result.incoming, toProductWatch(await readAutoSelection()), await readProductCodes());
    let telegram: "sent" | "skipped" | "unconfigured" = "skipped";

    if (messages.length === 0) {
      telegram = "skipped";
    } else if (!telegramConfigured()) {
      telegram = "unconfigured";
      await writeUpdateReport({
        state: "warning",
        at: result.catalog.fetchedAt,
        message: "Ada perubahan harga, tetapi Telegram belum diatur.",
        details: result.failureDetails,
      });
    } else {
      try {
        await sendTelegramMessages(messages);
        telegram = "sent";
      } catch (error) {
        const message = error instanceof Error ? error.message : "Telegram gagal mengirim pesan.";
        await writeUpdateReport({
          state: "warning",
          at: result.catalog.fetchedAt,
          message,
          details: result.failureDetails,
        });
        telegram = "skipped";
      }
    }

    return Response.json({
      ok: true,
      fetchedAt: result.catalog.fetchedAt,
      products: result.catalog.productCount,
      changedMessages: messages.length,
      telegram,
      failedProviders: result.incoming.failedProviders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pembaruan dari browser gagal.";
    if (message.startsWith("Pembaruan sedang berjalan") || message.startsWith("Simpanan lain sedang ditulis")) {
      return Response.json({ ok: true, skipped: true, reason: message });
    }
    const details = error instanceof PriceFetchError ? error.details.slice(0, 8) : [];
    const status = message.startsWith("Hasil browser") ? 400 : 500;
    return Response.json({ ok: false, error: message, details }, { status });
  }
}
