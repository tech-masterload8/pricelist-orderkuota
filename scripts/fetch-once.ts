import { saveCatalog } from "../lib/catalog-store";
import { fetchFullCatalog } from "../lib/fetch-prices";

async function main() {
  const catalog = await fetchFullCatalog({
    onProgress(progress) {
      if (progress.completed === progress.total || progress.completed % 25 === 0) {
        console.log(`${progress.completed}/${progress.total} ${progress.providerName}`);
      }
    },
  });

  await saveCatalog(catalog);

  const sample = catalog.categories
    .flatMap((category) => category.providers)
    .flatMap((provider) => provider.products)
    .find((product) => product.code === "A15");

  console.log(
    `Tersimpan ${catalog.productCount} produk dari ${catalog.providerCount} provider pada ${catalog.fetchedAt}.`,
  );
  console.log(`Provider gagal: ${catalog.failedProviders}`);
  console.log("Contoh A15:", sample ?? "tidak ada");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
