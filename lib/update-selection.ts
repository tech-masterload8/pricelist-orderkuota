const STORAGE_KEY = "pricelist-update-categories";

export function readUpdateSelection(): string[] | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const codes = parsed.filter((code): code is string => typeof code === "string" && code.length > 0);
    return codes.length > 0 ? codes : null;
  } catch {
    return null;
  }
}

export function writeUpdateSelection(codes: string[] | null) {
  if (codes === null || codes.length === 0) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(codes));
}
