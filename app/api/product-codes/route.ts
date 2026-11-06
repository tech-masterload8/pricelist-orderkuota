import { patchProductCodes, readProductCodes } from "@/lib/catalog-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const codes = Object.fromEntries(await readProductCodes());
  return Response.json({ codes }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Kode Masterload8 tidak valid." }, { status: 400 });
    }
    if ("codes" in body) {
      return Response.json(
        { error: "Halaman ini sudah kedaluwarsa. Muat ulang halaman sebelum menyimpan." },
        { status: 409 },
      );
    }
    const updates = "updates" in body ? body.updates : {};
    const deleted = "deleted" in body ? body.deleted : [];
    if (!updates || typeof updates !== "object" || Array.isArray(updates) || !Array.isArray(deleted)) {
      return Response.json({ error: "Kode Masterload8 tidak valid." }, { status: 400 });
    }
    await patchProductCodes(updates, deleted);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kode Masterload8 gagal disimpan.";
    const status = message.includes("sedang ditulis") ? 409 : 500;
    return Response.json({ error: message }, { status });
  }

  const codes = Object.fromEntries(await readProductCodes());
  return Response.json({ codes }, { headers: { "Cache-Control": "no-store" } });
}
