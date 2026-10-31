import { readAutoSelection, writeAutoSelection } from "@/lib/catalog-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PROVIDER_CODE = /^prv_[a-z0-9]+$/i;

export async function GET() {
  const providers = await readAutoSelection();
  return Response.json({ providers }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  let providers: string[] = [];
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("providers" in body) || !Array.isArray(body.providers)) {
      return Response.json({ error: "Pilihan operator tidak valid." }, { status: 400 });
    }
    providers = body.providers.filter((code): code is string => typeof code === "string" && PROVIDER_CODE.test(code));
  } catch {
    return Response.json({ error: "Pilihan operator tidak valid." }, { status: 400 });
  }

  await writeAutoSelection(providers);
  return Response.json({ providers }, { headers: { "Cache-Control": "no-store" } });
}
