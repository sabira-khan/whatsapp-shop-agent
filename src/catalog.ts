import catalogData from '../data/catalog.json'

export interface CatalogItem {
  handle: string
  title: string
  description: string
  category: string
  price: number
  keywords: string[]
}

export const catalog: CatalogItem[] = catalogData

const STOP = new Set(['a', 'an', 'and', 'for', 'the', 'with', 'gift', 'gifts', 'something', 'who', 'loves', 'likes', 'into', 'my', 'her', 'his', 'them', 'under', 'some', 'any'])

function stem(word: string) {
  return word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word
}

function words(text: string) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w)).map(stem)
}

export function searchCatalog(query: string, maxPrice?: number, limit = 5): CatalogItem[] {
  const terms = [...new Set(words(query))]
  if (!terms.length) return []
  const scored = catalog
    .filter(item => maxPrice === undefined || item.price <= maxPrice)
    .map(item => {
      const title = new Set(words(item.title))
      const category = new Set(words(item.category))
      const keywords = new Set(item.keywords.flatMap(words))
      const description = new Set(words(item.description))
      let score = 0
      for (const term of terms) {
        if (title.has(term)) score += 3
        if (category.has(term)) score += 2
        if (keywords.has(term)) score += 2
        if (description.has(term)) score += 1
      }
      return { item, score }
    })
    .filter(s => s.score > 0)
  scored.sort((a, b) => b.score - a.score || a.item.price - b.item.price)
  return scored.slice(0, limit).map(s => s.item)
}

export function findItem(handle: string): CatalogItem | undefined {
  return catalog.find(item => item.handle === handle)
}
