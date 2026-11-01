import type { Catalog, Product, ProductWatch } from "./types";

const MESSAGE_LIMIT = 3500;

const OPERATOR_ORDER = ["XL", "Axis", "Smart", "Isat", "Tri", "Tsel", "Game & Digital"] as const;

type Change = {
  providerName: string;
  code: string;
  delta: number;
  price: string;
};

function parsePrice(value: string) {
  const normalized = value.replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function words(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function bucketFromName(value: string) {
  const tokens = words(value);
  if (tokens.includes("byu") || (tokens[0] === "by" && tokens[1] === "u")) return "Tsel";
  if (tokens.includes("telkomsel") || tokens.includes("tsel") || tokens.includes("digipost") || tokens.includes("digipos")) return "Tsel";
  if (tokens.includes("smartfren") || tokens.includes("smart")) return "Smart";
  if (tokens.includes("indosat") || tokens.includes("isat")) return "Isat";
  if (tokens.includes("three") || tokens.includes("tri")) return "Tri";
  if (tokens.includes("axis") && tokens[0] !== "xl") return "Axis";
  if (tokens.includes("xl")) return "XL";
  if (tokens.includes("axis")) return "Axis";
  return null;
}

function operatorBucket(categoryName: string, providerName: string) {
  if (words(categoryName)[0] === "game") return "Game & Digital";
  return bucketFromName(providerName) ?? bucketFromName(categoryName);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDelta(amount: number) {
  const digits = Math.abs(Math.round(amount))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${amount > 0 ? "+" : "-"}${digits}`;
}

function productLine(change: Change) {
  return `${escapeHtml(change.code)} / ${formatDelta(change.delta)} » Rp ${escapeHtml(change.price)}`;
}

export function describePriceChanges(previous: Catalog | null, incoming: Catalog, watch?: ProductWatch) {
  const grouped = new Map<string, { up: Change[]; down: Change[] }>();

  for (const category of incoming.categories) {
    const priorCategory = previous?.categories.find((item) => item.code === category.code);
    for (const provider of category.providers) {
      if (provider.error) continue;
      const rule = watch?.get(provider.code);
      if (watch && !rule) continue;
      const bucket = operatorBucket(category.name, provider.name);
      if (!bucket) continue;
      const priorProvider = priorCategory?.providers.find((item) => item.code === provider.code);
      const priorProducts = new Map((priorProvider?.products ?? []).map((product) => [product.id, product]));
      const include = (productId: number) => !rule || rule === "all" || rule.has(productId);

      for (const product of provider.products) {
        if (!include(product.id)) continue;
        const change = resellerChange(product, priorProducts.get(product.id), provider.name);
        if (!change) continue;
        const entry = grouped.get(bucket) ?? { up: [], down: [] };
        if (change.delta > 0) entry.up.push(change);
        else entry.down.push(change);
        grouped.set(bucket, entry);
      }
    }
  }

  return OPERATOR_ORDER.flatMap((operator) => {
    const entry = grouped.get(operator);
    if (!entry || (entry.up.length === 0 && entry.down.length === 0)) return [];
    return renderOperator(operator, entry.up, entry.down);
  });
}

function resellerChange(product: Product, previous: Product | undefined, providerName: string): Change | null {
  if (!previous) return null;
  const oldAmount = parsePrice(previous.resellerPrice);
  const newAmount = parsePrice(product.resellerPrice);
  if (oldAmount === null || newAmount === null || oldAmount === newAmount) return null;
  return {
    providerName,
    code: product.code,
    delta: newAmount - oldAmount,
    price: product.resellerPrice,
  };
}

function renderOperator(operator: string, up: Change[], down: Change[]) {
  const parts = [...sectionParts("Harga Naik:", up), ...sectionParts("Harga Turun:", down)];
  const messages: string[] = [];
  let body = "";
  let page = 0;

  for (const part of parts) {
    const next = body ? `${body}\n\n${part}` : `${title(operator, page)}\n\n${part}`;
    if (next.length > MESSAGE_LIMIT && body) {
      messages.push(body);
      page += 1;
      body = `${title(operator, page)}\n\n${part}`;
      continue;
    }
    body = next;
  }

  if (body) messages.push(body);
  return messages;
}

function title(operator: string, page: number) {
  const suffix = page > 0 ? " (lanjutan)" : "";
  return `<b>Daftar Perubahan Harga Produk ${escapeHtml(operator)}${suffix}:</b>`;
}

function sectionParts(label: string, changes: Change[]) {
  if (changes.length === 0) return [];
  const byProvider = new Map<string, Change[]>();
  for (const change of changes) {
    const list = byProvider.get(change.providerName) ?? [];
    list.push(change);
    byProvider.set(change.providerName, list);
  }

  const parts: string[] = [];
  let labelUsed = false;
  for (const [providerName, providerChanges] of byProvider) {
    const lines = [...providerChanges]
      .sort((left, right) => left.code.localeCompare(right.code, "id"))
      .map(productLine);
    let chunk: string[] = [];
    const flush = () => {
      if (chunk.length === 0) return;
      const heading = labelUsed ? "" : `<b>${label}</b>\n`;
      labelUsed = true;
      parts.push(`${heading}<b>${escapeHtml(providerName)}</b>\n${chunk.join("\n")}`);
      chunk = [];
    };

    for (const line of lines) {
      const heading = `<b>${label}</b>\n<b>${escapeHtml(providerName)}</b>\n`;
      if (heading.length + [...chunk, line].join("\n").length > MESSAGE_LIMIT - 180 && chunk.length > 0) flush();
      chunk.push(line);
    }
    flush();
  }

  return parts;
}
