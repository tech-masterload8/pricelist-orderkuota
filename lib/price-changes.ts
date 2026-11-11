import type { Catalog, Product, ProductWatch } from "./types";

const MESSAGE_LIMIT = 3500;

export const OPERATOR_ORDER = ["XL", "Axis", "Smart", "Isat", "Tri", "Tsel", "Game & Digital"] as const;

type Change = {
  providerName: string;
  code: string;
  name: string;
  previous: number;
  current: number;
  delta: number;
  price: string;
  kind: "new" | "up" | "down";
};

export type PriceChange = Change & { operator: (typeof OPERATOR_ORDER)[number] };

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
  if (change.kind === "new") {
    return `‼️ <b>${escapeHtml(change.code)}</b> · ${escapeHtml(change.name)} · Rp ${escapeHtml(change.price)}`;
  }
  const arrow = change.delta > 0 ? "⬆️" : "⬇️";
  return `${arrow} ${escapeHtml(change.code)} / ${formatDelta(change.delta)} » Rp ${escapeHtml(change.price)}`;
}

export function collectPriceChanges(
  previous: Catalog | null,
  incoming: Catalog,
  watch?: ProductWatch,
  masterCodes?: ReadonlyMap<number, string>,
): PriceChange[] {
  const changes: PriceChange[] = [];

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
      const priorByCode = new Map((priorProvider?.products ?? []).map((product) => [product.code.trim(), product]));
      const include = (productId: number) => !rule || rule === "all" || rule.has(productId);

      for (const product of provider.products) {
        if (!include(product.id)) continue;
        const prior = priorProducts.get(product.id) ?? priorByCode.get(product.code.trim());
        const change = resellerChange(product, prior, provider.name, masterCodes?.get(product.id), Boolean(previous));
        if (!change) continue;
        changes.push({ ...change, operator: bucket });
      }
    }
  }

  return changes;
}

export function messagesForChanges(changes: PriceChange[], now = new Date()) {
  const grouped = new Map<string, { added: PriceChange[]; up: PriceChange[]; down: PriceChange[] }>();
  for (const change of changes) {
    const entry = grouped.get(change.operator) ?? { added: [], up: [], down: [] };
    if (change.kind === "new") entry.added.push(change);
    else if (change.delta > 0) entry.up.push(change);
    else entry.down.push(change);
    grouped.set(change.operator, entry);
  }

  const checkedAt = formatJakarta(now);
  return OPERATOR_ORDER.flatMap((operator) => {
    const entry = grouped.get(operator);
    if (!entry || (entry.added.length === 0 && entry.up.length === 0 && entry.down.length === 0)) return [];
    return renderOperator(operator, entry.added, entry.up, entry.down, checkedAt);
  });
}

export function describePriceChanges(
  previous: Catalog | null,
  incoming: Catalog,
  watch?: ProductWatch,
  masterCodes?: ReadonlyMap<number, string>,
) {
  return messagesForChanges(collectPriceChanges(previous, incoming, watch, masterCodes));
}

function resellerChange(
  product: Product,
  previous: Product | undefined,
  providerName: string,
  masterCode: string | undefined,
  catalogExists: boolean,
): Change | null {
  const code = masterCode?.trim() || product.code;
  const newAmount = parsePrice(product.resellerPrice);
  if (!previous) {
    if (!catalogExists || newAmount === null) return null;
    return {
      providerName,
      code,
      name: product.name,
      previous: 0,
      current: newAmount,
      delta: 0,
      price: product.resellerPrice,
      kind: "new",
    };
  }
  const oldAmount = parsePrice(previous.resellerPrice);
  if (oldAmount === null || newAmount === null || oldAmount === newAmount) return null;
  return {
    providerName,
    code,
    name: product.name,
    previous: oldAmount,
    current: newAmount,
    delta: newAmount - oldAmount,
    price: product.resellerPrice,
    kind: newAmount > oldAmount ? "up" : "down",
  };
}

function renderOperator(operator: string, added: Change[], up: Change[], down: Change[], checkedAt: string) {
  const parts = [
    ...sectionParts("‼️ <b>KODE PRODUK BARU</b> ‼️", added),
    ...(added.length > 0 && (up.length > 0 || down.length > 0) ? ["────────────"] : []),
    ...sectionParts("⬆️ <b>HARGA NAIK</b> ⬆️", up),
    ...(up.length > 0 && down.length > 0 ? ["────────────"] : []),
    ...sectionParts("⬇️ <b>HARGA TURUN</b> ⬇️", down),
  ];
  const messages: string[] = [];
  let body = "";
  let page = 0;

  for (const part of parts) {
    const next = body ? `${body}\n\n${part}` : `${title(operator, page, checkedAt)}\n\n${part}`;
    if (next.length > MESSAGE_LIMIT && body) {
      messages.push(body);
      page += 1;
      body = `${title(operator, page, checkedAt)}\n\n${part}`;
      continue;
    }
    body = next;
  }

  if (body) messages.push(body);
  return messages;
}

function formatJakarta(date: Date) {
  const formatted = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(date);
  return `${formatted} WIB`;
}

function title(operator: string, page: number, checkedAt: string) {
  const suffix = page > 0 ? " (lanjutan)" : "";
  return `<b>Daftar Perubahan Harga Produk ${escapeHtml(operator)}${suffix}:</b>\n${checkedAt}`;
}

function sectionParts(headingHtml: string, changes: Change[]) {
  if (changes.length === 0) return [];
  const byProvider = new Map<string, Change[]>();
  for (const change of changes) {
    const list = byProvider.get(change.providerName) ?? [];
    list.push(change);
    byProvider.set(change.providerName, list);
  }

  const parts: string[] = [];
  let headingUsed = false;
  for (const [providerName, providerChanges] of byProvider) {
    const lines = [...providerChanges]
      .sort((left, right) => left.code.localeCompare(right.code, "id"))
      .map(productLine);
    let chunk: string[] = [];
    const flush = () => {
      if (chunk.length === 0) return;
      const heading = headingUsed ? "" : `${headingHtml}\n`;
      headingUsed = true;
      parts.push(`${heading}<b>${escapeHtml(providerName)}</b>\n${chunk.join("\n")}`);
      chunk = [];
    };

    for (const line of lines) {
      const heading = `${headingHtml}\n<b>${escapeHtml(providerName)}</b>\n`;
      if (heading.length + [...chunk, line].join("\n").length > MESSAGE_LIMIT - 180 && chunk.length > 0) flush();
      chunk.push(line);
    }
    flush();
  }

  return parts;
}
