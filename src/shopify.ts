export interface ShopifyConfig {
  storeDomain: string
  storefrontToken: string
  apiVersion: string
}

export interface LiveProduct {
  handle: string
  variantId: string
  price: number
  currency: string
  available: boolean
  image?: string
}

export interface CartLine {
  id: string
  handle: string
  title: string
  quantity: number
  price: number
}

export interface Cart {
  id: string
  checkoutUrl: string
  totalQuantity: number
  subtotal: number
  currency: string
  lines: CartLine[]
}

async function storefront<T>(config: ShopifyConfig, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${config.storeDomain}/api/${config.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': config.storefrontToken },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(5000)
  })
  if (!res.ok) throw new Error(`Shopify Storefront ${res.status}`)
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(`Shopify Storefront: ${body.errors.map(e => e.message).join('; ')}`)
  return body.data as T
}

const PRODUCTS_QUERY = `query Products($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      handle
      featuredImage { url(transform: { maxWidth: 800 }) }
      variants(first: 1) { nodes { id availableForSale price { amount currencyCode } } }
    }
  }
}`

export async function fetchLiveProducts(config: ShopifyConfig): Promise<Map<string, LiveProduct>> {
  const out = new Map<string, LiveProduct>()
  let cursor: string | null = null
  do {
    const data: any = await storefront(config, PRODUCTS_QUERY, { cursor })
    for (const node of data.products.nodes) {
      const variant = node.variants.nodes[0]
      if (!variant) continue
      out.set(node.handle, {
        handle: node.handle,
        variantId: variant.id,
        price: Number(variant.price.amount),
        currency: variant.price.currencyCode,
        available: variant.availableForSale,
        image: node.featuredImage?.url
      })
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null
  } while (cursor)
  return out
}

const CART_FIELDS = `
  id
  checkoutUrl
  totalQuantity
  cost { subtotalAmount { amount currencyCode } }
  lines(first: 50) {
    nodes {
      id
      quantity
      merchandise { ... on ProductVariant { price { amount } product { handle title } } }
    }
  }`

function toCart(cart: any): Cart {
  return {
    id: cart.id,
    checkoutUrl: cart.checkoutUrl,
    totalQuantity: cart.totalQuantity,
    subtotal: Number(cart.cost.subtotalAmount.amount),
    currency: cart.cost.subtotalAmount.currencyCode,
    lines: cart.lines.nodes.map((l: any) => ({
      id: l.id,
      handle: l.merchandise.product.handle,
      title: l.merchandise.product.title,
      quantity: l.quantity,
      price: Number(l.merchandise.price.amount)
    }))
  }
}

function userErrors(payload: any) {
  const errors = payload?.userErrors ?? []
  if (errors.length) throw new Error(`Shopify cart: ${errors.map((e: any) => e.message).join('; ')}`)
}

export async function cartCreate(config: ShopifyConfig, variantId: string, quantity: number): Promise<Cart> {
  const data: any = await storefront(config, `mutation($lines: [CartLineInput!]) { cartCreate(input: { lines: $lines }) { cart { ${CART_FIELDS} } userErrors { message } } }`, {
    lines: [{ merchandiseId: variantId, quantity }]
  })
  userErrors(data.cartCreate)
  return toCart(data.cartCreate.cart)
}

export async function cartAdd(config: ShopifyConfig, cartId: string, variantId: string, quantity: number): Promise<Cart> {
  const data: any = await storefront(config, `mutation($cartId: ID!, $lines: [CartLineInput!]!) { cartLinesAdd(cartId: $cartId, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } } }`, {
    cartId,
    lines: [{ merchandiseId: variantId, quantity }]
  })
  userErrors(data.cartLinesAdd)
  return toCart(data.cartLinesAdd.cart)
}

export async function cartRemove(config: ShopifyConfig, cartId: string, lineIds: string[]): Promise<Cart> {
  const data: any = await storefront(config, `mutation($cartId: ID!, $lineIds: [ID!]!) { cartLinesRemove(cartId: $cartId, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } } }`, { cartId, lineIds })
  userErrors(data.cartLinesRemove)
  return toCart(data.cartLinesRemove.cart)
}

export async function cartGet(config: ShopifyConfig, cartId: string): Promise<Cart | null> {
  const data: any = await storefront(config, `query($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`, { id: cartId })
  return data.cart ? toCart(data.cart) : null
}
