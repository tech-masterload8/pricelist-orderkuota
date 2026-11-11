"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AutoSelection, CatalogIndex, Product } from "@/lib/types";

type Checks = {
  full: Set<string>;
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

function providerState(checks: Checks, code: string) {
  return checks.full.has(code) ? "all" as const : "none" as const;
}

export default function AutoUpdatePicker() {
  const router = useRouter();
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [status, setStatus] = useState<"loading" | "empty" | "ready" | "error">("loading");
  const [pageError, setPageError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Checks>({ full: new Set() });
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
        const full = new Set((saved.providers ?? []).filter((code) => available.has(code)));
        for (const product of saved.products ?? []) {
          if (available.has(product.providerCode)) full.add(product.providerCode);
        }
        setIndex(data);
        setChecks({ full });
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
      for (const code of codes) {
        if (selectAll) full.add(code);
        else full.delete(code);
      }
      return { full };
    });
    clearSaveError();
  }

  function toggleProvider(code: string) {
    setChecks((current) => {
      const full = new Set(current.full);
      if (full.has(code)) full.delete(code);
      else full.add(code);
      return { full };
    });
    clearSaveError();
  }

  function setAll(selected: boolean) {
    if (!index) return;
    const codes = index.categories.flatMap((category) => category.providers.map((provider) => provider.code));
    setChecks(selected ? { full: new Set(codes) } : { full: new Set() });
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
    const response = await fetch("/api/auto-selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: [...checks.full], products: [] }),
    });
    if (!response.ok) {
      setSaveError("Pilihan auto update gagal disimpan.");
      return;
    }
    router.push("/");
  }

  const watchedOperators = index
    ? index.categories.reduce(
        (sum, category) => sum + category.providers.filter((provider) => checks.full.has(provider.code)).length,
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
              ? `${watchedOperators.toLocaleString("id-ID")} operator dipilih. Kode baru pada operator itu ikut masuk otomatis. Buka operator untuk melihat daftar produk.`
              : "Pilih operator yang diperiksa setiap pembaruan."}
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
              const fullOperators = category.providers.filter((provider) => checks.full.has(provider.code)).length;
              const open = expanded.has(category.code);
              return (
                <li key={category.code} className={open ? "choice-item is-open" : "choice-item"}>
                  <div className="choice">
                    <ChoiceBox
                      id={`category-${category.code}`}
                      checked={fullOperators === providerCodes.length && providerCodes.length > 0}
                      indeterminate={fullOperators > 0 && fullOperators < providerCodes.length}
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
                          {fullOperators.toLocaleString("id-ID")} dari {providerCodes.length.toLocaleString("id-ID")} operator
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
                        const state = providerState(checks, provider.code);
                        return (
                          <li key={provider.code} className={providerOpen ? "operator-item is-open" : "operator-item"}>
                            <div className="choice">
                              <ChoiceBox
                                id={`provider-${provider.code}`}
                                checked={state === "all"}
                                indeterminate={false}
                                onChange={() => toggleProvider(provider.code)}
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
                                    {provider.productCount.toLocaleString("id-ID")} produk saat ini. Kode baru ikut masuk.
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
                                  ? providerProducts.products.map((product) => (
                                      <li key={product.id} className="product-info">
                                        <strong>
                                          {product.code} · {product.name}
                                        </strong>
                                        <small>
                                          Reseller {product.resellerPrice} · Umum {product.publicPrice}
                                        </small>
                                      </li>
                                    ))
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
