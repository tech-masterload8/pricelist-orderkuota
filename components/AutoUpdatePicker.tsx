"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AutoSelection, CatalogIndex, Product } from "@/lib/types";

type Checks = {
  full: Set<string>;
  partial: Map<string, Set<number>>;
};

type LoadedProducts = {
  status: "loading" | "ready" | "error";
  products: Product[];
  error: string | null;
};

function ChoiceBox({
  checked,
  indeterminate,
  onChange,
  id,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  id: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return <input ref={ref} id={id} type="checkbox" checked={checked} onChange={onChange} />;
}

function Chevron() {
  return (
    <svg className="chevron" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function selectedProductCount(checks: Checks, code: string, productCount: number) {
  if (checks.full.has(code)) return productCount;
  return checks.partial.get(code)?.size ?? 0;
}

function providerState(checks: Checks, code: string, productCount: number) {
  if (checks.full.has(code)) return "all" as const;
  const picked = checks.partial.get(code)?.size ?? 0;
  if (picked === 0) return "none" as const;
  if (productCount > 0 && picked >= productCount) return "all" as const;
  return "some" as const;
}

export default function AutoUpdatePicker() {
  const router = useRouter();
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [status, setStatus] = useState<"loading" | "empty" | "ready" | "error">("loading");
  const [pageError, setPageError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Checks>({ full: new Set(), partial: new Map() });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openProviders, setOpenProviders] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Map<string, LoadedProducts>>(new Map());
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadCategories() {
      try {
        const [catalogResponse, selectionResponse] = await Promise.all([
          fetch("/api/catalog", { cache: "no-store" }),
          fetch("/api/auto-selection", { cache: "no-store" }),
        ]);
        if (catalogResponse.status === 404) {
          if (!cancelled) setStatus("empty");
          return;
        }
        if (!catalogResponse.ok) throw new Error("Daftar kategori belum bisa dimuat.");
        if (!selectionResponse.ok) throw new Error("Pilihan auto update belum bisa dimuat.");
        const data = (await catalogResponse.json()) as CatalogIndex;
        const saved = (await selectionResponse.json()) as AutoSelection;
        if (cancelled) return;

        const available = new Set(data.categories.flatMap((category) => category.providers.map((provider) => provider.code)));
        const partial = new Map<string, Set<number>>();
        for (const product of saved.products ?? []) {
          if (!available.has(product.providerCode)) continue;
          const ids = partial.get(product.providerCode) ?? new Set<number>();
          ids.add(product.productId);
          partial.set(product.providerCode, ids);
        }
        setIndex(data);
        setChecks({
          full: new Set((saved.providers ?? []).filter((code) => available.has(code))),
          partial,
        });
        setStatus("ready");
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setPageError(error instanceof Error ? error.message : "Daftar kategori belum bisa dimuat.");
        }
      }
    }

    void loadCategories();
    return () => {
      cancelled = true;
    };
  }, []);

  function clearSaveError() {
    setSaveError(null);
  }

  function toggleCategory(codes: string[], selectAll: boolean) {
    setChecks((current) => {
      const full = new Set(current.full);
      const partial = new Map(current.partial);
      for (const code of codes) {
        partial.delete(code);
        if (selectAll) full.add(code);
        else full.delete(code);
      }
      return { full, partial };
    });
    clearSaveError();
  }

  function toggleProvider(code: string, productCount: number) {
    setChecks((current) => {
      const full = new Set(current.full);
      const partial = new Map(current.partial);
      const state = providerState(current, code, productCount);
      partial.delete(code);
      if (state === "all") full.delete(code);
      else full.add(code);
      return { full, partial };
    });
    clearSaveError();
  }

  function toggleProduct(code: string, productId: number, products: Product[]) {
    setChecks((current) => {
      const full = new Set(current.full);
      const partial = new Map(current.partial);
      const ids = new Set(full.has(code) ? products.map((product) => product.id) : (partial.get(code) ?? []));
      if (ids.has(productId)) ids.delete(productId);
      else ids.add(productId);
      full.delete(code);
      if (ids.size === 0) partial.delete(code);
      else if (products.length > 0 && ids.size === products.length) {
        partial.delete(code);
        full.add(code);
      } else partial.set(code, ids);
      return { full, partial };
    });
    clearSaveError();
  }

  function setAll(selected: boolean) {
    if (!index) return;
    const codes = index.categories.flatMap((category) => category.providers.map((provider) => provider.code));
    setChecks(selected ? { full: new Set(codes), partial: new Map() } : { full: new Set(), partial: new Map() });
    clearSaveError();
  }

  function toggleExpanded(code: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function toggleProviderOpen(code: string) {
    setOpenProviders((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    if (loaded.has(code)) return;

    setLoaded((current) => new Map(current).set(code, { status: "loading", products: [], error: null }));
    try {
      const response = await fetch(`/api/catalog/providers/${code}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Produk operator ini belum bisa dimuat.");
      const data = (await response.json()) as { products?: Product[] };
      setLoaded((current) =>
        new Map(current).set(code, { status: "ready", products: data.products ?? [], error: null }),
      );
    } catch (error) {
      setLoaded((current) =>
        new Map(current).set(code, {
          status: "error",
          products: [],
          error: error instanceof Error ? error.message : "Produk operator ini belum bisa dimuat.",
        }),
      );
    }
  }

  async function save() {
    if (!index) return;
    const providers = [...checks.full];
    const products = [...checks.partial.entries()].flatMap(([providerCode, ids]) =>
      checks.full.has(providerCode) ? [] : [...ids].map((productId) => ({ providerCode, productId })),
    );
    const response = await fetch("/api/auto-selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers, products }),
    });
    if (!response.ok) {
      setSaveError("Pilihan auto update gagal disimpan.");
      return;
    }
    router.push("/");
  }

  const selectedProducts = index
    ? index.categories.reduce(
        (sum, category) =>
          sum + category.providers.reduce((inner, provider) => inner + selectedProductCount(checks, provider.code, provider.productCount), 0),
        0,
      )
    : 0;
  const watchedOperators = index
    ? index.categories.reduce(
        (sum, category) =>
          sum + category.providers.filter((provider) => providerState(checks, provider.code, provider.productCount) !== "none").length,
        0,
      )
    : 0;

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Auto update</p>
          <h1>Pilih Produk Auto Update</h1>
          <p className="meta">
            {index
              ? `${selectedProducts.toLocaleString("id-ID")} produk dari ${watchedOperators.toLocaleString("id-ID")} operator diperiksa setiap 10 menit. Buka operator untuk memilih produk. Kosong berarti Orderkuota tidak dihubungi.`
              : "Pilih produk yang diperiksa setiap 10 menit."}
            {watchedOperators > 40 ? " Pilihan ini cukup banyak untuk dijalankan setiap 10 menit." : ""}
          </p>
        </div>
        <div className="top-actions">
          <Link className="pick-button" href="/">
            Kembali
          </Link>
          <button className="update-button" type="button" onClick={() => void save()} disabled={status !== "ready"}>
            Simpan pilihan
          </button>
        </div>
      </header>

      {saveError ? <p className="notice" role="alert">{saveError}</p> : null}
      {status === "loading" ? <p className="empty">Memuat kategori…</p> : null}
      {status === "error" ? <p className="notice" role="alert">{pageError}</p> : null}
      {status === "empty" ? (
        <section className="panel">
          <p className="empty">Katalog masih kosong. Jalankan Update Harga sekali untuk semua kategori sebelum memilih sebagian.</p>
        </section>
      ) : null}

      {status === "ready" && index ? (
        <section className="panel">
          <div className="picker-actions">
            <button className="pick-button" type="button" onClick={() => setAll(true)}>
              Pilih semua
            </button>
            <button className="pick-button" type="button" onClick={() => setAll(false)}>
              Kosongkan
            </button>
          </div>
          <ul className="choice-list">
            {index.categories.map((category) => {
              const providerCodes = category.providers.map((provider) => provider.code);
              const categoryProducts = category.providers.reduce((sum, provider) => sum + provider.productCount, 0);
              const categorySelected = category.providers.reduce(
                (sum, provider) => sum + selectedProductCount(checks, provider.code, provider.productCount),
                0,
              );
              const fullOperators = category.providers.filter((provider) => checks.full.has(provider.code)).length;
              const open = expanded.has(category.code);
              return (
                <li key={category.code} className={open ? "choice-item is-open" : "choice-item"}>
                  <div className="choice">
                    <ChoiceBox
                      id={`category-${category.code}`}
                      checked={fullOperators === providerCodes.length && providerCodes.length > 0}
                      indeterminate={categorySelected > 0 && fullOperators < providerCodes.length}
                      onChange={() => toggleCategory(providerCodes, fullOperators !== providerCodes.length)}
                    />
                    <button
                      className="choice-expand"
                      type="button"
                      aria-expanded={open}
                      aria-label={open ? `Tutup operator ${category.name}` : `Buka operator ${category.name}`}
                      onClick={() => toggleExpanded(category.code)}
                    >
                      <span>
                        <strong>{category.name}</strong>
                        <small>
                          {categorySelected.toLocaleString("id-ID")} dari {categoryProducts.toLocaleString("id-ID")} produk
                        </small>
                      </span>
                      <Chevron />
                    </button>
                  </div>
                  {open ? (
                    <ul className="operator-list">
                      {category.providers.length === 0 ? <li className="empty">Operator belum tersedia.</li> : null}
                      {category.providers.map((provider) => {
                        const providerOpen = openProviders.has(provider.code);
                        const providerProducts = loaded.get(provider.code);
                        const state = providerState(checks, provider.code, provider.productCount);
                        const picked = selectedProductCount(checks, provider.code, provider.productCount);
                        return (
                          <li key={provider.code} className={providerOpen ? "operator-item is-open" : "operator-item"}>
                            <div className="choice">
                              <ChoiceBox
                                id={`provider-${provider.code}`}
                                checked={state === "all"}
                                indeterminate={state === "some"}
                                onChange={() => toggleProvider(provider.code, provider.productCount)}
                              />
                              <button
                                className="choice-expand"
                                type="button"
                                aria-expanded={providerOpen}
                                aria-label={providerOpen ? `Tutup produk ${provider.name}` : `Buka produk ${provider.name}`}
                                onClick={() => void toggleProviderOpen(provider.code)}
                              >
                                <span>
                                  <strong>{provider.name}</strong>
                                  <small>
                                    {picked.toLocaleString("id-ID")} dari {provider.productCount.toLocaleString("id-ID")} produk
                                  </small>
                                </span>
                                <Chevron />
                              </button>
                            </div>
                            {providerOpen ? (
                              <ul className="product-list">
                                {providerProducts?.status === "loading" || !providerProducts ? <li className="empty">Memuat produk…</li> : null}
                                {providerProducts?.status === "error" ? <li className="empty">{providerProducts.error}</li> : null}
                                {providerProducts?.status === "ready" && providerProducts.products.length === 0 ? (
                                  <li className="empty">Produk belum tersedia.</li>
                                ) : null}
                                {providerProducts?.status === "ready"
                                  ? providerProducts.products.map((product) => {
                                      const productId = `product-${provider.code}-${product.id}`;
                                      const checked =
                                        checks.full.has(provider.code) || (checks.partial.get(provider.code)?.has(product.id) ?? false);
                                      return (
                                        <li key={product.id}>
                                          <label className="choice" htmlFor={productId}>
                                            <input
                                              id={productId}
                                              type="checkbox"
                                              checked={checked}
                                              onChange={() => toggleProduct(provider.code, product.id, providerProducts.products)}
                                            />
                                            <span>
                                              <strong>
                                                {product.code} · {product.name}
                                              </strong>
                                              <small>
                                                Reseller {product.resellerPrice} · Umum {product.publicPrice}
                                              </small>
                                            </span>
                                          </label>
                                        </li>
                                      );
                                    })
                                  : null}
                              </ul>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
