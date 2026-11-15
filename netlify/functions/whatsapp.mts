import { getStore } from '@netlify/blobs'
import type { Config } from '@netlify/functions'
import { handleWhatsApp } from '../../src/handler'

export default async (req: Request) => {
  const blobs = getStore({ name: 'whatsapp', consistency: 'strong' })
  return handleWhatsApp(req, process.env, {
    get: key => blobs.get(key),
    set: async (key, value) => {
      await blobs.set(key, value)
    }
  })
}

export const config: Config = { path: '/api/whatsapp' }
