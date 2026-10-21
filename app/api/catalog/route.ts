import { readCatalog, toIndex } from "@/lib/catalog-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const catalog = await readCatalog();
    return Response.json(toIndex(catalog), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Katalog harga belum tersedia." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
}
