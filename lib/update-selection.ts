import type { CatalogIndex } from "./types";

const STORAGE_KEY = "pricelist-update-categories";

export type UpdateSelection = { categories: string[] } | { providers: string[] };

function isProviderCode(code: string) {
  return code.startsWith("prv_");
}

export function readUpdateSelection(): UpdateSelection | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "providers" in parsed && Array.isArray(parsed.providers)) {
      const providers = parsed.providers.filter((code): code is string => typeof code === "string" && isProviderCode(code));
      return providers.length > 0 ? { providers } : null;
    }
    if (!Array.isArray(parsed)) return null;
    const codes = parsed.filter((code): code is string => typeof code === "string" && code.length > 0);
    if (codes.length === 0) return null;
    if (codes.every(isProviderCode)) return { providers: codes };
    return { categories: codes.filter((code) => !isProviderCode(code)) };
  } catch {
    return null;
  }
}

export function writeUpdateSelection(providers: string[] | null) {
  if (providers === null || providers.length === 0) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ providers }));
}

export function describeUpdateSelection(index: CatalogIndex | null, selection: UpdateSelection | null) {
  if (!selection || !index) return "semua kategori";

  if ("categories" in selection) {
    const names = index.categories
      .filter((category) => selection.categories.includes(category.code))
      .map((category) => category.name);
    return names.length > 0 ? names.join(", ") : "semua kategori";
  }

  const parts: string[] = [];
  for (const category of index.categories) {
    const picked = category.providers.filter((provider) => selection.providers.includes(provider.code));
    if (picked.length === 0) continue;
    if (picked.length === category.providers.length) {
      parts.push(category.name);
    } else if (picked.length <= 3) {
      parts.push(`${category.name} (${picked.map((provider) => provider.name).join(", ")})`);
    } else {
      parts.push(`${category.name} (${picked.length} operator)`);
    }
  }

  return parts.length > 0 ? parts.join(", ") : "semua kategori";
}
