export type Product = {
  id: number;
  code: string;
  name: string;
  resellerPrice: string;
  publicPrice: string;
};

export type ProviderCatalog = {
  code: string;
  name: string;
  error: string | null;
  products: Product[];
};

export type CategoryCatalog = {
  code: string;
  name: string;
  providers: ProviderCatalog[];
};

export type Catalog = {
  fetchedAt: string;
  productCount: number;
  providerCount: number;
  failedProviders: number;
  categories: CategoryCatalog[];
};

export type ProviderSummary = {
  code: string;
  name: string;
  productCount: number;
  error: string | null;
};

export type CategorySummary = {
  code: string;
  name: string;
  providers: ProviderSummary[];
};

export type UpdateReport = {
  state: "running" | "error" | "warning";
  at: string;
  message: string;
  details: string[];
};

export type CatalogIndex = {
  fetchedAt: string;
  productCount: number;
  providerCount: number;
  failedProviders: number;
  categories: CategorySummary[];
  report: UpdateReport | null;
};

export type FetchProgress = {
  completed: number;
  total: number;
  providerName: string;
};
