import { findProvider, readCatalog } from "@/lib/catalog-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PROVIDER_CODE = /^prv_[a-z0-9]+$/i;

export async function GET(_request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  if (!PROVIDER_CODE.test(code)) {
    return Response.json({ error: "Provider tidak dikenal." }, { status: 400 });
  }

  try {
    const catalog = await readCatalog();
    const provider = findProvider(catalog, code);
    if (!provider) {
      return Response.json({ error: "Provider tidak ada di katalog." }, { status: 404 });
    }

    return Response.json(
      {
        code: provider.code,
        name: provider.name,
        categoryCode: provider.categoryCode,
        categoryName: provider.categoryName,
        error: provider.error,
        products: provider.products,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Katalog harga belum tersedia." }, { status: 404 });
  }
}
