import { z } from 'zod'

// --- Schemas ---

export const photoSchema = z.object({
  id: z.number().int(),
  restaurant_id: z.number().int(),
  r2_key: z.string(),
  caption: z.string().nullable(),
  created_at: z.string(),
})

// --- Types ---

export type Photo = z.infer<typeof photoSchema>

// --- API ---

export class PhotoApi {
  constructor(private db: D1Database, private images: R2Bucket) {}

  async list(restaurantId: number): Promise<Photo[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM photos WHERE restaurant_id = ? ORDER BY created_at DESC')
      .bind(restaurantId)
      .all()
    return results as unknown as Photo[]
  }

  async upload(
    restaurantId: number,
    file: File,
    caption?: string
  ): Promise<{ id: number; key: string }> {
    const contentType = file.type || 'image/jpeg'
    const ext = contentType.split('/')[1] || 'jpg'
    const key = `restaurants/${restaurantId}/${crypto.randomUUID()}.${ext}`

    await this.images.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType },
    })

    const result = await this.db
      .prepare('INSERT INTO photos (restaurant_id, r2_key, caption) VALUES (?, ?, ?)')
      .bind(restaurantId, key, caption ?? null)
      .run()

    return { id: result.meta.last_row_id as number, key }
  }

  async getObject(
    photoId: number
  ): Promise<{ body: ReadableStream; contentType: string; size: number } | null> {
    const photo = await this.db
      .prepare('SELECT r2_key FROM photos WHERE id = ?')
      .bind(photoId)
      .first()
    if (!photo) return null

    const object = await this.images.get((photo as unknown as { r2_key: string }).r2_key)
    if (!object) return null

    return {
      body: object.body as ReadableStream,
      contentType: object.httpMetadata?.contentType ?? 'image/jpeg',
      size: object.size,
    }
  }

  async delete(photoId: number): Promise<void> {
    const photo = await this.db
      .prepare('SELECT r2_key FROM photos WHERE id = ?')
      .bind(photoId)
      .first()
    if (!photo) return

    await this.images.delete((photo as unknown as { r2_key: string }).r2_key)
    await this.db.prepare('DELETE FROM photos WHERE id = ?').bind(photoId).run()
  }
}
