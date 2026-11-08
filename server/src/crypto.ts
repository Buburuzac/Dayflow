import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

/** Opaque random token, base64url, 32 bytes of entropy by default. */
export function randomToken(prefix = '', bytes = 32): string {
  return prefix + randomBytes(bytes).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** AES-256-GCM with a key derived from JWT_SECRET (HKDF-SHA256). Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export class SecretBox {
  private readonly key: Buffer
  constructor(secret: string, info = 'dayflow/odoo-api-key/v1') {
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('dayflow-sync'), Buffer.from(info), 32))
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
  }

  decrypt(box: string): string {
    const [v, iv, tag, ct] = box.split('.')
    if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad secret box')
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
  }
}
