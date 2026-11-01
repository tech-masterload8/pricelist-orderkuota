"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CatalogIndex, Product } from "@/lib/types";

type LoadedProducts = {
  status: "loading" | "ready" | "error";
  products: Product[];
  error: string | null;
};

function Chevron() {
  return (
    <svg className="chevron" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ProductCodeEditor() {
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [status, setStatus] = useState<"loading" | "empty" | "ready" | "error">("loading");
  const [pageError, setPageError] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openProviders, setOpenProviders] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Map<string, LoadedProducts>>(new Map());
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadPage() {
      try {
        const [catalogResponse, codeResponse] = await Promise.all([
          fetch("/api/catalog", { cache: "no-store" }),
          fetch("/api/product-codes", { cache: "no-store" }),
        ]);
        if (catalogResponse.status === 404) {
          if (!cancelled) setStatus("empty");
          return;
        }
        if (!catalogResponse.ok) throw new Error("Daftar produk belum bisa dimuat.");
        if (!codeResponse.ok) throw new Error("Kode Masterload8 belum bisa dimuat.");
        const data = (await catalogResponse.json()) as CatalogIndex;
        const saved = (await codeResponse.json()) as { codes?: Record<string, string> };
        if (cancelled) return;
        setIndex(data);
        setCodes(saved.codes ?? {});
        setStatus("ready");
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setPageError(error instanceof Error ? error.message : "Daftar produk belum bisa dimuat.");
        }
      }
    }

    void loadPage();
    return () => {
      cancelled = true;
    };
  }, []);

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
      setLoaded((current) => new Map(current).set(code, { status: "ready", products: data.products ?? [], error: null }));
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

  function updateCode(productId: number, value: string) {
    setCodes((current) => {
      const next = { ...current };
      if (value.trim() === "") delete next[String(productId)];
      else next[String(productId)] = value;
      return next;
    });
    setSavedNote(null);
    setSaveError(null);
  }

  async function save() {
    const payload = Object.fromEntries(
      Object.entries(codes)
        .map(([id, code]) => [id, code.trim()] as const)
        .filter(([, code]) => code.length > 0),
    );
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/product-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: payload }),
      });
      if (!response.ok) throw new Error("Kode Masterload8 gagal disimpan.");
      const saved = (await response.json()) as { codes?: Record<string, string> };
      setCodes(saved.codes ?? {});
      setSavedNote("Kode Masterload8 tersimpan.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Kode Masterload8 gagal disimpan.");
    } finally {
      setSaving(false);
    }
  }

  const filledCount = Object.values(codes).filter((code) => code.trim()).length;

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Telegram</p>
          <h1>Kode Produk ML8</h1>
          <p className="meta">
            {index
              ? `${filledCount.toLocaleString("id-ID")} kode Masterload8 terisi. Field kosong memakai kode Orderkuota pada pesan Telegram.`
              : "Isi kode Masterload8 untuk mengganti kode produk di pesan Telegram."}
          </p>
        </div>
        <div className="top-actions">
          <Link className="pick-button" href="/">
            Kembali
          </Link>
          <button className="update-button" type="button" onClick={() => void save()} disabled={status !== "ready" || saving}>
            {saving ? "Menyimpan…" : "Simpan kode"}
          </button>
        </div>
      </header>

      {saveError ? <p className="notice" role="alert">{saveError}</p> : null}
      {savedNote ? <p className="notice running" role="status">{savedNote}</p> : null}
      {status === "loading" ? <p className="empty">Memuat produk…</p> : null}
      {status === "error" ? <p className="notice" role="alert">{pageError}</p> : null}
      {status === "empty" ? (
        <section className="panel">
          <p className="empty">Katalog masih kosong. Jalankan Update Harga sekali sebelum mengisi kode.</p>
        </section>
      ) : null}

      {status === "ready" && index ? (
        <section className="panel">
          <ul className="choice-list">
            {index.categories.map((category) => {
              const open = expanded.has(category.code);
              return (
                <li key={category.code} className={open ? "choice-item is-open" : "choice-item"}>
                  <div className="choice">
                    <button
                      className="choice-expand"
                      type="button"
                      aria-expanded={open}
                      aria-label={open ? `Tutup operator ${category.name}` : `Buka operator ${category.name}`}
                      onClick={() => toggleExpanded(category.code)}
                    >
                      <span>
                        <strong>{category.name}</strong>
                        <small>{category.providers.length.toLocaleString("id-ID")} operator</small>
                      </span>
                      <Chevron />
                    </button>
                  </div>
                  {open ? (
                    <ul className="operator-list">
                      {category.providers.map((provider) => {
                        const providerOpen = openProviders.has(provider.code);
                        const providerProducts = loaded.get(provider.code);
                        const query = (queries[provider.code] ?? "").trim().toLowerCase();
                        const visible = (providerProducts?.products ?? []).filter((product) => {
                          if (!query) return true;
                          return `${product.code} ${product.name}`.toLowerCase().includes(query);
                        });
                        const filledHere = (providerProducts?.products ?? []).filter((product) => codes[String(product.id)]?.trim()).length;
                        return (
                          <li key={provider.code} className={providerOpen ? "operator-item is-open" : "operator-item"}>
                            <div className="choice">
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
                                    {provider.productCount.toLocaleString("id-ID")} produk
                                    {providerProducts?.status === "ready" ? ` · ${filledHere.toLocaleString("id-ID")} kode Masterload8` : ""}
                                  </small>
                                </span>
                                <Chevron />
                              </button>
                            </div>
                            {providerOpen ? (
                              <div>
                                {providerProducts?.status === "loading" || !providerProducts ? <p className="empty">Memuat produk…</p> : null}
                                {providerProducts?.status === "error" ? <p className="empty">{providerProducts.error}</p> : null}
                                {providerProducts?.status === "ready" ? (
                                  <>
                                    <div className="code-search">
                                      <input
                                        type="search"
                                        aria-label={`Cari produk ${provider.name}`}
                                        value={queries[provider.code] ?? ""}
                                        placeholder="Cari kode atau nama"
                                        onChange={(event) =>
                                          setQueries((current) => ({ ...current, [provider.code]: event.target.value }))
                                        }
                                      />
                                    </div>
                                    {visible.length === 0 ? <p className="empty">Produk tidak ditemukan.</p> : null}
                                    <ul className="product-list">
                                      {visible.map((product) => {
                                        const fieldId = `ml8-${provider.code}-${product.id}`;
                                        return (
                                          <li key={product.id} className="code-row">
                                            <span>
                                              <strong>
                                                {product.code} · {product.name}
                                              </strong>
                                              <small>
                                                Kode Orderkuota {product.code} · Reseller {product.resellerPrice}
                                              </small>
                                            </span>
                                            <label htmlFor={fieldId}>
                                              Kode Masterload8
                                              <input
                                                id={fieldId}
                                                type="text"
                                                maxLength={80}
                                                value={codes[String(product.id)] ?? ""}
                                                placeholder={product.code}
                                                onChange={(event) => updateCode(product.id, event.target.value)}
                                              />
                                            </label>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </>
                                ) : null}
                              </div>
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
