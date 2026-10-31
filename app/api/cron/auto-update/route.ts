import { readAutoSelection, writeUpdateReport } from "@/lib/catalog-store";
import { PriceFetchError } from "@/lib/fetch-prices";
import { describePriceChanges } from "@/lib/price-changes";
import { runPriceUpdate } from "@/lib/run-update";
import { sendTelegramMessages, telegramConfigured } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 300;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "Tidak diizinkan." }, { status: 401 });
  }

  const providers = await readAutoSelection();
  if (providers.length === 0) {
    return Response.json({
      ok: true,
      skipped: true,
      reason: "Tidak ada operator yang dipilih untuk auto update.",
    });
  }

  try {
    const result = await runPriceUpdate({ providerCodes: providers });
    const messages = describePriceChanges(result.previous, result.incoming);
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
      skipped: false,
      fetchedAt: result.catalog.fetchedAt,
      changedMessages: messages.length,
      telegram,
      failedProviders: result.incoming.failedProviders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pembaruan otomatis gagal.";
    if (message.startsWith("Pembaruan sedang berjalan")) {
      return Response.json({ ok: true, skipped: true, reason: message });
    }

    const details = error instanceof PriceFetchError ? error.details.slice(0, 8) : [];
    if (telegramConfigured()) {
      try {
        const notice = ["Pembaruan otomatis gagal.", message, ...details].join("\n");
        await sendTelegramMessages([notice]);
      } catch (notifyError) {
        console.error("Gagal memberi tahu Telegram.", notifyError);
      }
    }

    return Response.json({ ok: false, error: message, details }, { status: 500 });
  }
}
