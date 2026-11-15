import { createHmac, timingSafeEqual } from 'node:crypto'

export interface OutgoingMessage {
  body?: string
  media?: string
}

export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url)
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

export function validTwilioRequest(authToken: string, signature: string | null, url: string, params: Record<string, string>): boolean {
  if (!authToken || !signature) return false
  const expected = Buffer.from(twilioSignature(authToken, url, params))
  const actual = Buffer.from(signature)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function escapeXml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export function twiml(messages: OutgoingMessage[]): string {
  const parts = messages.map(m => {
    const body = m.body ? `<Body>${escapeXml(m.body.slice(0, 1500))}</Body>` : ''
    const media = m.media ? `<Media>${escapeXml(m.media)}</Media>` : ''
    return `<Message>${body}${media}</Message>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join('')}</Response>`
}
