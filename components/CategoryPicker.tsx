"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { CatalogIndex } from "@/lib/types";
import { readUpdateSelection, writeUpdateSelection } from "@/lib/update-selection";

function CategoryCheckbox({
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

export default function CategoryPicker() {
  const router = useRouter();
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [status, setStatus] = useState<"loading" | "empty" | "ready" | "error">("loading");
  const [pageError, setPageError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadCategories() {
      try {
        const response = await fetch("/api/catalog", { cache: "no-store" });
        if (response.status === 404) {
          if (!cancelled) setStatus("empty");
          return;
        }
        if (!response.ok) throw new Error("Daftar kategori belum bisa dimuat.");
        const data = (await response.json()) as CatalogIndex;
        if (cancelled) return;

        const allProviders = data.categories.flatMap((category) => category.providers.map((provider) => provider.code));
        const available = new Set(allProviders);
        const saved = readUpdateSelection();
        let initial = allProviders;
        if (saved && "providers" in saved) {
          const kept = saved.providers.filter((code) => available.has(code));
          initial = kept.length > 0 ? kept : allProviders;
        } else if (saved && "categories" in saved) {
          const categoryCodes = new Set(saved.categories);
          initial = data.categories
            .filter((category) => categoryCodes.has(category.code))
            .flatMap((category) => category.providers.map((provider) => provider.code));
          if (initial.length === 0) initial = allProviders;
        }

        setIndex(data);
        setChecked(new Set(initial));
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

  function toggleProvider(code: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    setSaveError(null);
  }

  function toggleCategory(codes: string[], selected: boolean) {
    setChecked((current) => {
      const next = new Set(current);
      for (const code of codes) {
        if (selected) next.add(code);
        else next.delete(code);
      }
      return next;
    });
    setSaveError(null);
  }

  function setAll(selected: boolean) {
    if (!index) return;
    const codes = index.categories.flatMap((category) => category.providers.map((provider) => provider.code));
    setChecked(selected ? new Set(codes) : new Set());
    setSaveError(null);
  }

  function toggleExpanded(code: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function save() {
    if (!index) return;
    const allProviders = index.categories.flatMap((category) => category.providers.map((provider) => provider.code));
    const selected = allProviders.filter((code) => checked.has(code));
    if (selected.length === 0) {
      setSaveError("Pilih minimal satu operator.");
      return;
    }

    writeUpdateSelection(selected.length === allProviders.length ? null : selected);
    router.push("/");
  }

  const totalProviders = index?.categories.reduce((sum, category) => sum + category.providers.length, 0) ?? 0;
  const selectedProviders = index
    ? index.categories.reduce(
        (sum, category) => sum + category.providers.filter((provider) => checked.has(provider.code)).length,
        0,
      )
    : 0;

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Pembaruan</p>
          <h1>Pilih Kategori Produk</h1>
          <p className="meta">
            {index
              ? `${selectedProviders.toLocaleString("id-ID")} dari ${totalProviders.toLocaleString("id-ID")} operator akan diambil saat Update Harga diklik.`
              : "Pilih kategori dan operator yang ingin diperbarui."}
          </p>
        </div>
        <div className="top-actions">
          <Link className="pick-button" href="/">
            Kembali
          </Link>
          <button className="update-button" type="button" onClick={save} disabled={status !== "ready"}>
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
              const selectedCount = providerCodes.filter((code) => checked.has(code)).length;
              const open = expanded.has(category.code);
              const inputId = `category-${category.code}`;
              return (
                <li key={category.code} className={open ? "choice-item is-open" : "choice-item"}>
                  <div className="choice">
                    <CategoryCheckbox
                      id={inputId}
                      checked={selectedCount === providerCodes.length && providerCodes.length > 0}
                      indeterminate={selectedCount > 0 && selectedCount < providerCodes.length}
                      onChange={() => toggleCategory(providerCodes, selectedCount !== providerCodes.length)}
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
                          {selectedCount.toLocaleString("id-ID")} dari {providerCodes.length.toLocaleString("id-ID")} operator
                        </small>
                      </span>
                      <svg className="chevron" viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                  {open ? (
                    <ul className="operator-list">
                      {category.providers.length === 0 ? <li className="empty">Operator belum tersedia.</li> : null}
                      {category.providers.map((provider) => {
                        const providerId = `provider-${provider.code}`;
                        return (
                          <li key={provider.code}>
                            <label className="choice" htmlFor={providerId}>
                              <input
                                id={providerId}
                                type="checkbox"
                                checked={checked.has(provider.code)}
                                onChange={() => toggleProvider(provider.code)}
                              />
                              <span>
                                <strong>{provider.name}</strong>
                                <small>{provider.productCount.toLocaleString("id-ID")} produk</small>
                              </span>
                            </label>
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
