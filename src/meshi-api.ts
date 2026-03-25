import { z } from 'zod'

// --- Schemas ---

export const restaurantSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  area: z.string().nullable(),
  genre: z.string().nullable(),
  memo: z.string().nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
  google_maps_url: z.string().url().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const addRestaurantSchema = z.object({
  name: z.string().describe('正式な店名'),
  area: z.string().optional().describe('エリア（例: 渋谷、新宿）'),
  genre: z.string().optional().describe('ジャンル（例: ラーメン、寿司）'),
  memo: z.string().optional().describe('メモ'),
  rating: z.number().int().min(1).max(5).optional().describe('評価（1-5）'),
  google_maps_url: z.string().url().optional().describe('Google MapsのURL'),
})

export const searchRestaurantSchema = z.object({
  query: z.string().optional().describe('検索キーワード（店名・メモから検索）'),
  area: z.string().optional().describe('エリアで絞り込み'),
  genre: z.string().optional().describe('ジャンルで絞り込み'),
})

export const updateRestaurantSchema = z.object({
  name: z.string().optional(),
  area: z.string().optional(),
  genre: z.string().optional(),
  memo: z.string().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  google_maps_url: z.string().url().optional(),
})

export const listRestaurantSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('取得件数（デフォルト20）'),
  offset: z.number().int().min(0).optional().describe('オフセット'),
})

// --- Types ---

export type Restaurant = z.infer<typeof restaurantSchema>
export type AddRestaurantInput = z.infer<typeof addRestaurantSchema>
export type SearchRestaurantInput = z.infer<typeof searchRestaurantSchema>
export type UpdateRestaurantInput = z.infer<typeof updateRestaurantSchema>
export type ListRestaurantInput = z.infer<typeof listRestaurantSchema>

// --- API ---

export class MeshiApi {
  constructor(private db: D1Database) {}

  async add(input: AddRestaurantInput): Promise<{ id: number }> {
    const parsed = addRestaurantSchema.parse(input)
    const result = await this.db
      .prepare('INSERT INTO restaurants (name, area, genre, memo, rating, google_maps_url) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(
        parsed.name,
        parsed.area ?? null,
        parsed.genre ?? null,
        parsed.memo ?? null,
        parsed.rating ?? null,
        parsed.google_maps_url ?? null
      )
      .run()
    return { id: result.meta.last_row_id as number }
  }

  async search(input: SearchRestaurantInput): Promise<Restaurant[]> {
    const parsed = searchRestaurantSchema.parse(input)
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (parsed.query) {
      conditions.push('(name LIKE ? OR memo LIKE ?)')
      params.push(`%${parsed.query}%`, `%${parsed.query}%`)
    }
    if (parsed.area) {
      conditions.push('area LIKE ?')
      params.push(`%${parsed.area}%`)
    }
    if (parsed.genre) {
      conditions.push('genre LIKE ?')
      params.push(`%${parsed.genre}%`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `SELECT * FROM restaurants ${where} ORDER BY created_at DESC LIMIT 50`
    const { results } = await this.db.prepare(sql).bind(...params).all()
    return results as unknown as Restaurant[]
  }

  async get(id: number): Promise<Restaurant | null> {
    const row = await this.db.prepare('SELECT * FROM restaurants WHERE id = ?').bind(id).first()
    return (row as unknown as Restaurant) ?? null
  }

  async update(id: number, fields: UpdateRestaurantInput): Promise<void> {
    const parsed = updateRestaurantSchema.parse(fields)
    const sets: string[] = []
    const params: (string | number)[] = []

    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`)
        params.push(value as string | number)
      }
    }

    if (sets.length === 0) return

    sets.push("updated_at = datetime('now')")
    params.push(id)

    await this.db.prepare(`UPDATE restaurants SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run()
  }

  async delete(id: number): Promise<void> {
    await this.db.prepare('DELETE FROM restaurants WHERE id = ?').bind(id).run()
  }

  async list(input?: ListRestaurantInput): Promise<Restaurant[]> {
    const parsed = listRestaurantSchema.parse(input ?? {})
    const limit = parsed.limit ?? 20
    const offset = parsed.offset ?? 0
    const { results } = await this.db
      .prepare('SELECT * FROM restaurants ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(limit, offset)
      .all()
    return results as unknown as Restaurant[]
  }
}
