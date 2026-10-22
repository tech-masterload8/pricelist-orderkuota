"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CatalogIndex } from "@/lib/types";
import { readUpdateSelection, writeUpdateSelection } from "@/lib/update-selection";

export default function CategoryPicker() {
  const router = useRouter();
  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [status, setStatus] = useState<"loading" | "empty" | "ready" | "error">("loading");
  const [pageError, setPageError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
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

        const saved = readUpdateSelection();
        const available = new Set(data.categories.map((category) => category.code));
        const initial = saved ? saved.filter((code) => available.has(code)) : data.categories.map((category) => category.code);
        setIndex(data);
        setChecked(new Set(initial.length > 0 ? initial : data.categories.map((category) => category.code)));
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

  function toggle(code: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    setSaveError(null);
  }

  function setAll(selected: boolean) {
    if (!index) return;
    setChecked(selected ? new Set(index.categories.map((category) => category.code)) : new Set());
    setSaveError(null);
  }

  function save() {
    if (!index) return;
    const codes = index.categories.map((category) => category.code).filter((code) => checked.has(code));
    if (codes.length === 0) {
      setSaveError("Pilih minimal satu kategori.");
      return;
    }

    writeUpdateSelection(codes.length === index.categories.length ? null : codes);
    router.push("/");
  }

  const selectedCount = index?.categories.filter((category) => checked.has(category.code)).length ?? 0;

  return (
    <main className="page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Pembaruan</p>
          <h1>Pilih Kategori Produk</h1>
          <p className="meta">
            {index
              ? `${selectedCount.toLocaleString("id-ID")} dari ${index.categories.length.toLocaleString("id-ID")} kategori akan diambil saat Update Harga diklik.`
              : "Pilih kategori yang ingin diperbarui."}
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
              const inputId = `category-${category.code}`;
              const providerCount = category.providers.length;
              return (
                <li key={category.code}>
                  <label className="choice" htmlFor={inputId}>
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={checked.has(category.code)}
                      onChange={() => toggle(category.code)}
                    />
                    <span>
                      <strong>{category.name}</strong>
                      <small>
                        {providerCount.toLocaleString("id-ID")} provider
                      </small>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
