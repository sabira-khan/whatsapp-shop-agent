import { readFileSync } from 'node:fs'
import { catalog, type CatalogItem } from '../src/catalog'
import type { ShopifyConfig } from '../src/shopify'

export interface FixtureVariant {
  id: string
  title: string
  price: number
  available: boolean
}

export interface FixtureProduct {
  handle: string
  title: string
  description: string
  category: string
  keywords: string[]
  image: string
  currency: string
  variants: FixtureVariant[]
}

export const FIXTURE_SHOPIFY: ShopifyConfig = {
  storeDomain: 'fixture-shop.myshopify.com',
  storefrontToken: 'fixture-token',
  apiVersion: '2025-07'
}

export function loadFixture(): FixtureProduct[] {
  return JSON.parse(readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8'))
}

export function useFixtureCatalog(products: FixtureProduct[]) {
  const items: CatalogItem[] = products.map(p => ({
    handle: p.handle,
    title: p.title,
    description: p.description,
    category: p.category,
    price: p.variants[0].price,
    keywords: p.keywords
  }))
  catalog.splice(0, catalog.length, ...items)
}
