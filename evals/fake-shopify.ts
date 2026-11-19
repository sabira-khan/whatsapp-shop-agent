import { FIXTURE_SHOPIFY, type FixtureProduct } from './fixture'

interface Line {
  id: string
  variantId: string
  quantity: number
}

export function installFakeShopify(products: FixtureProduct[]) {
  const variants = new Map(products.flatMap(p => p.variants.map(v => [v.id, { product: p, variant: v }] as const)))
  const carts = new Map<string, Line[]>()
  let nextId = 1
  const realFetch = globalThis.fetch

  function cartJson(id: string) {
    const lines = carts.get(id)
    if (!lines) return null
    const nodes = lines.map(line => {
      const { product, variant } = variants.get(line.variantId)!
      return { id: line.id, quantity: line.quantity, merchandise: { price: { amount: String(variant.price) }, product: { handle: product.handle, title: product.title } } }
    })
    const subtotal = lines.reduce((sum, line) => sum + variants.get(line.variantId)!.variant.price * line.quantity, 0)
    return {
      id,
      checkoutUrl: `https://${FIXTURE_SHOPIFY.storeDomain}/cart/c/${encodeURIComponent(id.split('/').pop()!)}`,
      totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
      cost: { subtotalAmount: { amount: String(subtotal), currencyCode: 'USD' } },
      lines: { nodes }
    }
  }

  function addLines(cartId: string, lines: { merchandiseId: string; quantity: number }[]) {
    const cart = carts.get(cartId)!
    for (const input of lines) {
      const found = variants.get(input.merchandiseId)
      if (!found) return [{ message: 'The merchandise does not exist.' }]
      if (!found.variant.available) return [{ message: 'The product is sold out.' }]
      const existing = cart.find(line => line.variantId === input.merchandiseId)
      if (existing) existing.quantity += input.quantity
      else cart.push({ id: `gid://shopify/CartLine/${nextId++}`, variantId: input.merchandiseId, quantity: input.quantity })
    }
    return []
  }

  function handle(query: string, variables: any) {
    if (query.includes('cartCreate')) {
      const id = `gid://shopify/Cart/fixture-${nextId++}`
      carts.set(id, [])
      const userErrors = addLines(id, variables.lines ?? [])
      return { cartCreate: { cart: userErrors.length ? null : cartJson(id), userErrors } }
    }
    if (query.includes('cartLinesAdd')) {
      if (!carts.has(variables.cartId)) return { cartLinesAdd: { cart: null, userErrors: [{ message: 'Cart not found.' }] } }
      const userErrors = addLines(variables.cartId, variables.lines)
      return { cartLinesAdd: { cart: cartJson(variables.cartId), userErrors } }
    }
    if (query.includes('cartLinesRemove')) {
      const cart = carts.get(variables.cartId)
      if (!cart) return { cartLinesRemove: { cart: null, userErrors: [{ message: 'Cart not found.' }] } }
      carts.set(variables.cartId, cart.filter(line => !variables.lineIds.includes(line.id)))
      return { cartLinesRemove: { cart: cartJson(variables.cartId), userErrors: [] } }
    }
    if (query.includes('cart(id')) return { cart: cartJson(variables.id) }
    if (query.includes('products(')) {
      const first = Number(/variants\(first:\s*(\d+)\)/.exec(query)?.[1] ?? 1)
      return {
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: products.map(p => ({
            handle: p.handle,
            featuredImage: { url: p.image },
            variants: { nodes: p.variants.slice(0, first).map(v => ({ id: v.id, availableForSale: v.available, price: { amount: String(v.price), currencyCode: p.currency } })) }
          }))
        }
      }
    }
    throw new Error(`Fake Shopify does not support this query: ${query.slice(0, 80)}`)
  }

  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(`https://${FIXTURE_SHOPIFY.storeDomain}/`)) return realFetch(input, init)
    const { query, variables } = JSON.parse(String(init?.body ?? '{}'))
    try {
      return Response.json({ data: handle(query, variables ?? {}) })
    } catch (err) {
      return Response.json({ errors: [{ message: (err as Error).message }] })
    }
  }

  return () => { globalThis.fetch = realFetch }
}
