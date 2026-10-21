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

export type CatalogIndex = {
  fetchedAt: string;
  productCount: number;
  providerCount: number;
  failedProviders: number;
  categories: CategorySummary[];
};

export type FetchProgress = {
  completed: number;
  total: number;
  providerName: string;
};
