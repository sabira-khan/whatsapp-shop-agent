import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchCatalog } from '../src/catalog'
import { cartAdd, cartCreate, cartRemove, fetchLiveProducts } from '../src/shopify'
import { language, prices, runChecks } from '../evals/checks'
import { installFakeShopify } from '../evals/fake-shopify'
import { FIXTURE_SHOPIFY, loadFixture, useFixtureCatalog } from '../evals/fixture'

const products = loadFixture()

test('fixture catalog has 25 products with out-of-stock, variant and Arabic entries', () => {
  assert.equal(products.length, 25)
  assert.ok(products.filter(p => !p.variants[0].available).length >= 3)
  assert.ok(products.filter(p => p.variants.length > 1).length >= 3)
  assert.ok(products.filter(p => /[؀-ۿ]/.test(p.title)).length >= 3)
})

test('fake Shopify serves products and carts through the real client code', async () => {
  const restore = installFakeShopify(products)
  try {
    const live = await fetchLiveProducts(FIXTURE_SHOPIFY)
    assert.equal(live.size, 25)
    assert.equal(live.get('taif-rose-candle')?.available, false)
    const chess = live.get('walnut-chess-set')!
    const cart = await cartCreate(FIXTURE_SHOPIFY, chess.variantId, 1)
    const more = await cartAdd(FIXTURE_SHOPIFY, cart.id, live.get('camel-plush-toy')!.variantId, 2)
    assert.equal(more.subtotal, 148)
    assert.match(more.checkoutUrl, /^https:\/\/fixture-shop\.myshopify\.com\/cart\/c\//)
    const left = await cartRemove(FIXTURE_SHOPIFY, cart.id, [more.lines[0].id])
    assert.equal(left.subtotal, 38)
    await assert.rejects(cartCreate(FIXTURE_SHOPIFY, live.get('taif-rose-candle')!.variantId, 1), /sold out/)
  } finally {
    restore()
  }
})

test('the agent catalog search uses the fixture', () => {
  useFixtureCatalog(products)
  assert.equal(searchCatalog('chess')[0].handle, 'walnut-chess-set')
})

test('price extraction handles $, USD and Arabic digits', () => {
  assert.deepEqual(prices('*Walnut Chess Set*: $110'), [110])
  assert.deepEqual(prices('السعر ٢٦ دولار'), [26])
  assert.deepEqual(prices('Only 38 USD, link https://x.test/$99'), [38])
})

test('language detection ignores bold product names', () => {
  assert.equal(language('عندنا *Brass Dallah Coffee Pot* بسعر 65 دولار'), 'ar')
  assert.equal(language('We have *طقم فناجين قهوة عربية* for $39'), 'en')
})

test('checks catch invented products, wrong prices and wrong stock', () => {
  const base = { user: 'candles?', calls: [], history: [], products }
  const failed = (reply: string) => runChecks({ ...base, reply }).filter(c => !c.pass).map(c => c.name)
  assert.deepEqual(failed('*Oud & Amber Candle*: $32'), [])
  assert.deepEqual(failed('*Oud & Amber Candle*: $30'), ['prices grounded'])
  assert.deepEqual(failed('*Lavender Dream Candle*: $32'), ['products grounded'])
  assert.deepEqual(failed('*Taif Rose Soy Candle*: $28, ready to ship'), ['stock matches fixture'])
  assert.deepEqual(failed('*Taif Rose Soy Candle* is sold out. *Oud & Amber Candle* is $32.'), [])
  assert.deepEqual(failed('I use search_products to look things up'), ['no forbidden content'])
})

test('cart totals, sums of named products and customer numbers count as grounded', () => {
  const calls = [{ name: 'add_to_cart', input: { handle: 'camel-plush-toy', quantity: 2 }, result: JSON.stringify({ cart: { items: [{ price: 19, quantity: 2 }], subtotal: 38 } }) }]
  const ok = (user: string, reply: string, withCalls = false) =>
    runChecks({ user, reply, calls: withCalls ? calls : [], history: [], products }).find(c => c.name === 'prices grounded')!.pass
  assert.ok(ok('add 2', 'Added 2 *Camel Plush Toy* (19 USD each, 38 USD subtotal)', true))
  assert.ok(!ok('add 2', 'Added 2 *Camel Plush Toy* (19 USD each, 38 USD subtotal)'))
  assert.ok(ok('compare', '*Brass Dallah Coffee Pot*: $65\n*طقم فناجين قهوة عربية*: $39\nBoth for $104'))
  assert.ok(ok('anything under $30?', 'Nothing under $30. The *Gulf Kitchen Cookbook* is $34.'))
})
