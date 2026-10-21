"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogIndex, Product } from "@/lib/types";

type Selection = {
  categoryCode: string;
  providerCode: string;
};

type Progress = {
  completed: number;
  total: number;
  providerName: string;
};

type ProviderResponse = {
  name: string;
  categoryName: string;
  error: string | null;
  products: Product[];
};

function formatFetchedAt(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  }).format(date);
}

export default function PriceBoard() {
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [status, setStatus] = useState<"loading" | "empty" | "ready" | "error">("loading");
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [products, setProducts] = useState<Product[]>([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [productsStatus, setProductsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadedProvider, setLoadedProvider] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const selectedRef = useRef<Selection | null>(null);
  selectedRef.current = selected;

  useEffect(() => {
    let cancelled = false;

    async function loadIndex() {
      setStatus("loading");
      setPageError(null);
      try {
        const response = await fetch("/api/catalog", { cache: "no-store" });
        if (response.status === 404) {
          if (!cancelled) {
            setIndex(null);
            setSelected(null);
            setStatus("empty");
          }
          return;
        }
        if (!response.ok) throw new Error("Katalog harga belum bisa dimuat.");
        const data = (await response.json()) as CatalogIndex;
        if (cancelled) return;

        setIndex(data);
        const current = selectedRef.current;
        const stillThere = current
          ? data.categories.some(
              (category) =>
                category.code === current.categoryCode &&
                category.providers.some((provider) => provider.code === current.providerCode),
            )
          : false;
        if (stillThere && current) {
          setSelected(current);
        } else {
          const firstCategory = data.categories.find((category) => category.providers.length > 0);
          const firstProvider = firstCategory?.providers[0];
          if (firstCategory && firstProvider) {
            setSelected({ categoryCode: firstCategory.code, providerCode: firstProvider.code });
            setExpanded(new Set([firstCategory.code]));
          } else {
            setSelected(null);
          }
        }
        setStatus("ready");
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setPageError(error instanceof Error ? error.message : "Katalog harga belum bisa dimuat.");
        }
      }
    }

    void loadIndex();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    if (!selected) return;
    const providerCode = selected.providerCode;
    let cancelled = false;

    async function loadProducts() {
      setProductsStatus("loading");
      setProviderError(null);
      try {
        const response = await fetch(`/api/catalog/providers/${encodeURIComponent(providerCode)}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Produk provider ini belum bisa dimuat.");
        const data = (await response.json()) as ProviderResponse;
        if (cancelled) return;
        setProducts(data.products);
        setProviderError(data.error);
        setLoadedProvider(providerCode);
        setProductsStatus("ready");
      } catch (error) {
        if (!cancelled) {
          setProducts([]);
          setLoadedProvider(providerCode);
          setProductsStatus("error");
          setProviderError(error instanceof Error ? error.message : "Produk provider ini belum bisa dimuat.");
        }
      }
    }

    void loadProducts();
    return () => {
      cancelled = true;
    };
  }, [selected, reloadToken]);

  useEffect(() => {
    setQuery("");
  }, [selected?.providerCode]);

  const productsReady = productsStatus === "ready" && loadedProvider === selected?.providerCode;
  const productsFailed = productsStatus === "error" && loadedProvider === selected?.providerCode;

  const visibleProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return products;
    return products.filter(
      (product) => product.code.toLowerCase().includes(needle) || product.name.toLowerCase().includes(needle),
    );
  }, [products, query]);

  function toggleCategory(categoryCode: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(categoryCode)) next.delete(categoryCode);
      else next.add(categoryCode);
      return next;
    });
  }

  function chooseProvider(categoryCode: string, providerCode: string) {
    setExpanded((current) => new Set(current).add(categoryCode));
    setSelected({ categoryCode, providerCode });
    setFilterOpen(false);
  }

  async function updatePrices() {
    setUpdating(true);
    setUpdateError(null);
    setProgress(null);

    try {
      const response = await fetch("/api/update", { method: "POST" });
      if (!response.ok || !response.body) {
        throw new Error("Pembaruan harga tidak bisa dimulai.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const line = chunk.split("\n").find((item) => item.startsWith("data:"));
          if (!line) continue;
          const event = JSON.parse(line.slice(5).trim()) as {
            type: string;
            message?: string;
            completed?: number;
            total?: number;
            providerName?: string;
          };

          if (event.type === "progress" && typeof event.completed === "number" && typeof event.total === "number") {
            setProgress({
              completed: event.completed,
              total: event.total,
              providerName: event.providerName ?? "",
            });
          }
          if (event.type === "error") {
            throw new Error(event.message || "Pembaruan harga gagal.");
          }
          if (event.type === "done") finished = true;
        }
      }

      if (!finished) {
        throw new Error("Pembaruan terputus sebelum selesai. Katalog lama tetap dipakai.");
      }

      setReloadToken((current) => current + 1);
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : "Pembaruan harga gagal.");
    } finally {
      setUpdating(false);
    }
  }

  const selectedCategory = index?.categories.find((category) => category.code === selected?.categoryCode);
  const selectedProvider = selectedCategory?.providers.find((provider) => provider.code === selected?.providerCode);

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Daftar harga</p>
          <h1>Harga Produk Orderkuota</h1>
          <p className="meta">
            {index
              ? `Diperbarui ${formatFetchedAt(index.fetchedAt)} WIB · ${index.productCount.toLocaleString("id-ID")} produk · ${index.providerCount.toLocaleString("id-ID")} provider`
              : "Harga tidak diambil otomatis."}
          </p>
        </div>
        <button className="update-button" type="button" onClick={() => void updatePrices()} disabled={updating} aria-busy={updating}>
          {updating ? "Memperbarui…" : "Update Harga"}
        </button>
      </header>

      {updateError ? <p className="notice" role="alert">{updateError}</p> : null}
      {updating ? (
        <p className="progress" aria-live="polite">
          {progress
            ? `Memperbarui provider ${progress.completed} dari ${progress.total}${progress.providerName ? ` · ${progress.providerName}` : ""}. Biarkan halaman ini terbuka.`
            : "Menyiapkan pembaruan harga. Biarkan halaman ini terbuka."}
        </p>
      ) : null}

      {status === "loading" ? <p className="empty">Memuat katalog tersimpan…</p> : null}
      {status === "error" ? <p className="notice" role="alert">{pageError}</p> : null}
      {status === "empty" ? (
        <section className="panel">
          <p className="empty">Katalog masih kosong. Klik Update Harga di kanan atas untuk mengambil seluruh daftar harga.</p>
        </section>
      ) : null}

      {status === "ready" && index ? (
        <>
          <button className="filter-toggle" type="button" onClick={() => setFilterOpen((open) => !open)} aria-expanded={filterOpen}>
            {filterOpen ? "Tutup filter" : "Filter kategori"}
          </button>
          <div className="layout">
            <aside className={filterOpen ? "sidebar open" : "sidebar"} aria-label="Filter produk">
              {index.categories.map((category) => {
                const open = expanded.has(category.code);
                return (
                  <section className="category" key={category.code}>
                    <button
                      className="category-button"
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggleCategory(category.code)}
                    >
                      {category.name}
                      <span>{category.providers.length}</span>
                    </button>
                    {open ? (
                      <div className="providers">
                        {category.providers.length === 0 ? <p className="empty">Provider belum tersedia.</p> : null}
                        {category.providers.map((provider) => (
                          <button
                            key={provider.code}
                            className="provider-button"
                            type="button"
                            aria-pressed={selected?.providerCode === provider.code}
                            onClick={() => chooseProvider(category.code, provider.code)}
                          >
                            {provider.name}
                            <span>{provider.productCount}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </aside>

            <section className="panel" aria-busy={!productsReady && !productsFailed}>
              <div className="panel-head">
                <div>
                  <h2>{selectedProvider?.name || "Produk"}</h2>
                  <p>
                    {selectedCategory?.name || "Pilih provider"}
                    {productsReady
                      ? ` · ${visibleProducts.length.toLocaleString("id-ID")} dari ${products.length.toLocaleString("id-ID")} produk`
                      : ""}
                  </p>
                </div>
                <label className="search">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Cari kode atau nama"
                    aria-label="Cari kode atau nama di provider ini"
                  />
                </label>
              </div>

              {!productsReady && !productsFailed ? <p className="empty">Memuat produk…</p> : null}
              {productsFailed ? <p className="notice" role="alert">{providerError}</p> : null}
              {productsReady && providerError ? <p className="notice" role="alert">{providerError}</p> : null}
              {productsReady && !providerError && visibleProducts.length === 0 ? (
                <p className="empty">{products.length === 0 ? "Produk belum tersedia." : "Tidak ada produk yang cocok dengan pencarian."}</p>
              ) : null}

              {productsReady && visibleProducts.length > 0 ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Kode Produk</th>
                        <th scope="col">Nama Produk</th>
                        <th scope="col">Harga Reseller</th>
                        <th scope="col">Harga Umum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleProducts.map((product) => (
                        <tr key={product.id}>
                          <td>{product.code}</td>
                          <td>{product.name}</td>
                          <td>{product.resellerPrice}</td>
                          <td>{product.publicPrice}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
          </div>
        </>
      ) : null}

      <p className="footer">
        Sumber data adalah daftar harga publik Orderkuota. Situs ini tidak berafiliasi dengan Orderkuota, dan tidak mengambil harga ulang sampai Update Harga diklik.
      </p>
    </main>
  );
}
