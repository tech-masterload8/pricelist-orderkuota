import type { Catalog, Product, ProductWatch } from "./types";

const MESSAGE_LIMIT = 3800;

function parsePrice(value: string) {
  const normalized = value.replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function remark(previous: string, next: string) {
  const oldValue = parsePrice(previous);
  const newValue = parsePrice(next);
  if (oldValue === null || newValue === null || oldValue === newValue) return "— harga tetap";
  return newValue > oldValue ? "↑ naik harga" : "↓ turun harga";
}

function productChanged(previous: Product, next: Product) {
  return previous.resellerPrice !== next.resellerPrice || previous.publicPrice !== next.publicPrice;
}

function productLines(product: Product, body: string[]) {
  return [`• ${product.code} ${product.name}`, ...body];
}

export function describePriceChanges(previous: Catalog | null, incoming: Catalog, watch?: ProductWatch) {
  const lines: string[] = ["Perubahan harga Orderkuota"];

  for (const category of incoming.categories) {
    const priorCategory = previous?.categories.find((item) => item.code === category.code);
    for (const provider of category.providers) {
      if (provider.error) continue;
      const rule = watch?.get(provider.code);
      if (watch && !rule) continue;
      const priorProvider = priorCategory?.providers.find((item) => item.code === provider.code);
      const priorProducts = new Map((priorProvider?.products ?? []).map((product) => [product.id, product]));
      const seen = new Set<number>();
      const providerLines: string[] = [];
      const include = (productId: number) => !rule || rule === "all" || rule.has(productId);

      for (const product of provider.products) {
        if (!include(product.id)) continue;
        seen.add(product.id);
        const prior = priorProducts.get(product.id);
        if (!prior) {
          if (watch && rule !== "all") continue;
          providerLines.push(
            ...productLines(product, [
              "  produk baru",
              `  Reseller ${product.resellerPrice}`,
              `  Umum ${product.publicPrice}`,
            ]),
          );
          continue;
        }
        if (!productChanged(prior, product)) continue;
        providerLines.push(
          ...productLines(product, [
            `  Reseller ${prior.resellerPrice} → ${product.resellerPrice} ${remark(prior.resellerPrice, product.resellerPrice)}`,
            `  Umum ${prior.publicPrice} → ${product.publicPrice} ${remark(prior.publicPrice, product.publicPrice)}`,
          ]),
        );
      }

      if (priorProvider && !priorProvider.error) {
        for (const product of priorProvider.products) {
          if (seen.has(product.id) || !include(product.id)) continue;
          providerLines.push(
            ...productLines(product, [
              "  produk hilang",
              `  Reseller ${product.resellerPrice}`,
              `  Umum ${product.publicPrice}`,
            ]),
          );
        }
      }

      if (providerLines.length > 0) {
        lines.push("", `${category.name} / ${provider.name}`, ...providerLines);
      }
    }
  }

  if (lines.length === 1) return [];
  return packMessages(lines);
}

function packMessages(lines: string[]) {
  const messages: string[] = [];
  let current = "";
  for (const line of lines) {
    const piece = line.length > MESSAGE_LIMIT ? `${line.slice(0, MESSAGE_LIMIT - 1)}…` : line;
    const next = current ? `${current}\n${piece}` : piece;
    if (next.length > MESSAGE_LIMIT && current) {
      messages.push(current);
      current = piece;
      continue;
    }
    current = next;
  }
  if (current) messages.push(current);
  return messages;
}
