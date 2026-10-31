import { readAutoSelection, writeAutoSelection } from "@/lib/catalog-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const selection = await readAutoSelection();
  return Response.json(selection, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("providers" in body) || !Array.isArray(body.providers)) {
      return Response.json({ error: "Pilihan produk tidak valid." }, { status: 400 });
    }
    const products = "products" in body && Array.isArray(body.products) ? body.products : [];
    await writeAutoSelection({ providers: body.providers, products });
  } catch {
    return Response.json({ error: "Pilihan produk tidak valid." }, { status: 400 });
  }

  const saved = await readAutoSelection();
  return Response.json(saved, { headers: { "Cache-Control": "no-store" } });
}
