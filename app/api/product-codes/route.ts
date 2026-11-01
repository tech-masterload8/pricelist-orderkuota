import { readProductCodes, writeProductCodes } from "@/lib/catalog-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const codes = Object.fromEntries(await readProductCodes());
  return Response.json({ codes }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("codes" in body) || !body.codes || typeof body.codes !== "object" || Array.isArray(body.codes)) {
      return Response.json({ error: "Kode Masterload8 tidak valid." }, { status: 400 });
    }
    await writeProductCodes(body.codes);
  } catch {
    return Response.json({ error: "Kode Masterload8 gagal disimpan." }, { status: 500 });
  }

  const codes = Object.fromEntries(await readProductCodes());
  return Response.json({ codes }, { headers: { "Cache-Control": "no-store" } });
}
