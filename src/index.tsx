import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import uploadPhotoHtml from '../dist/index.html'
import viewPhotosHtml from '../dist-photos/photos.html'

type Bindings = {
  DB: D1Database
  IMAGES: R2Bucket
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
    exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
  })
)

const createServer = (db: D1Database, images: R2Bucket, baseUrl: string) => {
  const server = new McpServer({
    name: 'meshi-mcp',
    version: '0.1.0',
  })

  server.registerTool(
    'add_restaurant',
    {
      title: '飯屋登録',
      description: `新しい飯屋を登録する。nameだけでOK、他は任意。
【重要】登録前にデータを正規化すること:
- 店名はGoogle Mapsや公式情報から正式名称を使う（例: ×「あのラーメン屋」→ ○「麺屋 一燈」）
- エリアは最寄り駅や地名で統一（例: 「東京都新宿区」ではなく「新宿」）
- ジャンルは簡潔に（例: ラーメン、寿司、イタリアン、中華、カレー、焼肉）
- Google MapsのURLがわかる場合は必ず含める`,
      inputSchema: {
        name: z.string().describe('正式な店名（Google Maps等で確認した正確な名前）'),
        area: z.string().optional().describe('エリア（最寄り駅や地名。例: 渋谷、新宿、恵比寿）'),
        genre: z.string().optional().describe('ジャンル（例: ラーメン、寿司、イタリアン、中華、カレー）'),
        memo: z.string().optional().describe('メモ（自由記述。おすすめメニューや感想など）'),
        rating: z.number().int().min(1).max(5).optional().describe('評価（1-5）'),
        google_maps_url: z.string().url().optional().describe('Google MapsのURL'),
      },
    },
    async ({ name, area, genre, memo, rating, google_maps_url }) => {
      const result = await db
        .prepare(
          'INSERT INTO restaurants (name, area, genre, memo, rating, google_maps_url) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(name, area ?? null, genre ?? null, memo ?? null, rating ?? null, google_maps_url ?? null)
        .run()

      return {
        content: [
          {
            type: 'text' as const,
            text: `登録しました: ${name} (id: ${result.meta.last_row_id})`,
          },
        ],
      }
    }
  )

  server.registerTool(
    'search_restaurants',
    {
      title: '飯屋検索',
      description: '飯屋をキーワード、エリア、ジャンルで検索する',
      inputSchema: {
        query: z.string().optional().describe('検索キーワード（店名・メモから検索）'),
        area: z.string().optional().describe('エリアで絞り込み'),
        genre: z.string().optional().describe('ジャンルで絞り込み'),
      },
    },
    async ({ query, area, genre }) => {
      const conditions: string[] = []
      const params: (string | number)[] = []

      if (query) {
        conditions.push('(name LIKE ? OR memo LIKE ?)')
        params.push(`%${query}%`, `%${query}%`)
      }
      if (area) {
        conditions.push('area LIKE ?')
        params.push(`%${area}%`)
      }
      if (genre) {
        conditions.push('genre LIKE ?')
        params.push(`%${genre}%`)
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const sql = `SELECT * FROM restaurants ${where} ORDER BY created_at DESC LIMIT 50`

      const { results } = await db.prepare(sql).bind(...params).all()

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: '見つかりませんでした' }] }
      }

      const text = results
        .map((r: Record<string, unknown>) => {
          const parts = [`[${r.id}] ${r.name}`]
          if (r.area) parts.push(`📍${r.area}`)
          if (r.genre) parts.push(`🍽️${r.genre}`)
          if (r.rating) parts.push(`${'⭐'.repeat(r.rating as number)}`)
          if (r.memo) parts.push(`💬${r.memo}`)
          return parts.join(' ')
        })
        .join('\n')

      return { content: [{ type: 'text' as const, text }] }
    }
  )

  server.registerTool(
    'get_restaurant',
    {
      title: '飯屋詳細',
      description: '飯屋の詳細情報を取得する',
      inputSchema: {
        id: z.number().int().describe('飯屋のID'),
      },
    },
    async ({ id }) => {
      const row = await db.prepare('SELECT * FROM restaurants WHERE id = ?').bind(id).first()

      if (!row) {
        return { content: [{ type: 'text' as const, text: `ID ${id} の飯屋は見つかりませんでした` }] }
      }

      const r = row as Record<string, unknown>

      const { results: photos } = await db
        .prepare('SELECT id, caption FROM photos WHERE restaurant_id = ?')
        .bind(id)
        .all()

      const lines = [
        `# ${r.name}`,
        r.area ? `エリア: ${r.area}` : null,
        r.genre ? `ジャンル: ${r.genre}` : null,
        r.rating ? `評価: ${'⭐'.repeat(r.rating as number)}` : null,
        r.memo ? `メモ: ${r.memo}` : null,
        r.google_maps_url ? `Google Maps: ${r.google_maps_url}` : null,
        photos.length > 0 ? `写真: ${photos.length}枚` : null,
        `登録日: ${r.created_at}`,
      ]
        .filter(Boolean)
        .join('\n')

      return { content: [{ type: 'text' as const, text: lines }] }
    }
  )

  server.registerTool(
    'update_restaurant',
    {
      title: '飯屋更新',
      description: `飯屋の情報を更新する。
【重要】add_restaurantと同様、更新データも正規化すること。店名はGoogle Maps等で確認した正式名称を使い、エリア・ジャンルは統一された形式で入力する。`,
      inputSchema: {
        id: z.number().int().describe('飯屋のID'),
        name: z.string().optional().describe('店名'),
        area: z.string().optional().describe('エリア'),
        genre: z.string().optional().describe('ジャンル'),
        memo: z.string().optional().describe('メモ'),
        rating: z.number().int().min(1).max(5).optional().describe('評価（1-5）'),
        google_maps_url: z.string().url().optional().describe('Google MapsのURL'),
      },
    },
    async ({ id, ...fields }) => {
      const sets: string[] = []
      const params: (string | number)[] = []

      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
          sets.push(`${key} = ?`)
          params.push(value as string | number)
        }
      }

      if (sets.length === 0) {
        return { content: [{ type: 'text' as const, text: '更新するフィールドがありません' }] }
      }

      sets.push("updated_at = datetime('now')")
      params.push(id)

      await db.prepare(`UPDATE restaurants SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run()

      return { content: [{ type: 'text' as const, text: `ID ${id} を更新しました` }] }
    }
  )

  server.registerTool(
    'delete_restaurant',
    {
      title: '飯屋削除',
      description: '飯屋を削除する',
      inputSchema: {
        id: z.number().int().describe('飯屋のID'),
      },
    },
    async ({ id }) => {
      await db.prepare('DELETE FROM restaurants WHERE id = ?').bind(id).run()
      return { content: [{ type: 'text' as const, text: `ID ${id} を削除しました` }] }
    }
  )

  server.registerTool(
    'list_restaurants',
    {
      title: '飯屋一覧',
      description: '登録済みの飯屋を一覧表示する',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('取得件数（デフォルト20）'),
        offset: z.number().int().min(0).optional().describe('オフセット'),
      },
    },
    async ({ limit, offset }) => {
      const l = limit ?? 20
      const o = offset ?? 0
      const { results } = await db
        .prepare('SELECT * FROM restaurants ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .bind(l, o)
        .all()

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'まだ飯屋が登録されていません' }] }
      }

      const text = results
        .map((r: Record<string, unknown>) => {
          const parts = [`[${r.id}] ${r.name}`]
          if (r.area) parts.push(`📍${r.area}`)
          if (r.genre) parts.push(`🍽️${r.genre}`)
          if (r.rating) parts.push(`${'⭐'.repeat(r.rating as number)}`)
          return parts.join(' ')
        })
        .join('\n')

      return { content: [{ type: 'text' as const, text }] }
    }
  )

  // MCP Apps: 写真アップロードUI
  const uploadResourceUri = 'ui://meshi-mcp/upload-photo'

  registerAppTool(server,
    'upload_photo',
    {
      title: '写真アップロード',
      description: '飯屋に写真をアップロードするUIを表示する。ユーザーがファイルを選んでアップロードできる。',
      inputSchema: {
        restaurant_id: z.number().int().describe('飯屋のID'),
      },
      outputSchema: z.object({
        restaurant_id: z.number(),
        upload_base_url: z.string(),
        message: z.string(),
      }),
      _meta: { ui: { resourceUri: uploadResourceUri } },
    },
    async ({ restaurant_id }) => {
      const restaurant = await db.prepare('SELECT id, name FROM restaurants WHERE id = ?').bind(restaurant_id).first()
      if (!restaurant) {
        return { content: [{ type: 'text' as const, text: `ID ${restaurant_id} の飯屋は見つかりませんでした` }] }
      }
      const r = restaurant as Record<string, unknown>
      return {
        content: [{ type: 'text' as const, text: `${r.name} の写真アップロードUIを表示中` }],
        structuredContent: { restaurant_id, upload_base_url: baseUrl, message: `${r.name} への写真アップロード` },
      }
    }
  )

  registerAppResource(server,
    uploadResourceUri,
    uploadResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{
        uri: uploadResourceUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: uploadPhotoHtml,
        _meta: {
          ui: {
            csp: {
              connectDomains: [baseUrl],
            },
          },
        },
      }],
    })
  )

  // MCP Apps: 写真表示UI
  const viewPhotosResourceUri = 'ui://meshi-mcp/view-photos'

  registerAppTool(server,
    'view_photos',
    {
      title: '写真表示',
      description: '飯屋の写真をギャラリー形式で表示する。写真一覧をUIで閲覧できる。',
      inputSchema: {
        restaurant_id: z.number().int().describe('飯屋のID'),
      },
      outputSchema: z.object({
        restaurant_id: z.number(),
        restaurant_name: z.string(),
        base_url: z.string(),
        photo_count: z.number(),
      }),
      _meta: { ui: { resourceUri: viewPhotosResourceUri } },
    },
    async ({ restaurant_id }) => {
      const restaurant = await db.prepare('SELECT id, name FROM restaurants WHERE id = ?').bind(restaurant_id).first()
      if (!restaurant) {
        return { content: [{ type: 'text' as const, text: `ID ${restaurant_id} の飯屋は見つかりませんでした` }] }
      }
      const r = restaurant as Record<string, unknown>

      const { results: photos } = await db
        .prepare('SELECT id FROM photos WHERE restaurant_id = ?')
        .bind(restaurant_id)
        .all()

      return {
        content: [{ type: 'text' as const, text: `${r.name} の写真を表示中（${photos.length}枚）` }],
        structuredContent: {
          restaurant_id,
          restaurant_name: r.name as string,
          base_url: baseUrl,
          photo_count: photos.length,
        },
      }
    }
  )

  registerAppResource(server,
    viewPhotosResourceUri,
    viewPhotosResourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{
        uri: viewPhotosResourceUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: viewPhotosHtml,
        _meta: {
          ui: {
            csp: {
              connectDomains: [baseUrl],
              resourceDomains: [baseUrl],
            },
          },
        },
      }],
    })
  )

  server.registerTool(
    'get_photos',
    {
      title: '写真一覧',
      description: '飯屋の写真一覧を取得する',
      inputSchema: {
        restaurant_id: z.number().int().describe('飯屋のID'),
      },
    },
    async ({ restaurant_id }) => {
      const { results } = await db
        .prepare('SELECT * FROM photos WHERE restaurant_id = ? ORDER BY created_at DESC')
        .bind(restaurant_id)
        .all()

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'この飯屋にはまだ写真がありません' }] }
      }

      const text = results
        .map((p: Record<string, unknown>) => {
          const parts = [`[photo:${p.id}]`]
          if (p.caption) parts.push(p.caption as string)
          parts.push(`→ /photos/${p.id}`)
          return parts.join(' ')
        })
        .join('\n')

      return { content: [{ type: 'text' as const, text }] }
    }
  )

  server.registerTool(
    'delete_photo',
    {
      title: '写真削除',
      description: '写真を削除する',
      inputSchema: {
        photo_id: z.number().int().describe('写真のID'),
      },
    },
    async ({ photo_id }) => {
      const photo = await db.prepare('SELECT r2_key FROM photos WHERE id = ?').bind(photo_id).first()
      if (!photo) {
        return { content: [{ type: 'text' as const, text: `ID ${photo_id} の写真は見つかりませんでした` }] }
      }

      await images.delete((photo as Record<string, unknown>).r2_key as string)
      await db.prepare('DELETE FROM photos WHERE id = ?').bind(photo_id).run()

      return { content: [{ type: 'text' as const, text: `写真 ${photo_id} を削除しました` }] }
    }
  )

  return server
}

// 写真一覧: GET /restaurants/:id/photos
app.get('/restaurants/:id/photos', async (c) => {
  const restaurantId = Number(c.req.param('id'))
  const { results } = await c.env.DB
    .prepare('SELECT id, caption, created_at FROM photos WHERE restaurant_id = ? ORDER BY created_at DESC')
    .bind(restaurantId)
    .all()
  return c.json(results)
})

// 写真アップロード: POST /restaurants/:id/photos (multipart/form-data)
app.post('/restaurants/:id/photos', async (c) => {
  const restaurantId = Number(c.req.param('id'))
  const restaurant = await c.env.DB.prepare('SELECT id, name FROM restaurants WHERE id = ?').bind(restaurantId).first()
  if (!restaurant) {
    return c.json({ error: '飯屋が見つかりません' }, 404)
  }

  const formData = await c.req.formData()
  const file = formData.get('photo')
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'photo フィールドが必要です' }, 400)
  }

  const caption = formData.get('caption')?.toString() ?? null
  const contentType = file.type || 'image/jpeg'
  const ext = contentType.split('/')[1] || 'jpg'
  const key = `restaurants/${restaurantId}/${crypto.randomUUID()}.${ext}`

  await c.env.IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType },
  })

  const result = await c.env.DB
    .prepare('INSERT INTO photos (restaurant_id, r2_key, caption) VALUES (?, ?, ?)')
    .bind(restaurantId, key, caption)
    .run()

  return c.json({
    id: result.meta.last_row_id,
    restaurant_id: restaurantId,
    caption,
    url: `/photos/${result.meta.last_row_id}`,
  }, 201)
})

// 写真配信: GET /photos/:id
app.get('/photos/:id', async (c) => {
  const photo = await c.env.DB.prepare('SELECT r2_key FROM photos WHERE id = ?').bind(Number(c.req.param('id'))).first()
  if (!photo) {
    return c.json({ error: '写真が見つかりません' }, 404)
  }

  const object = await c.env.IMAGES.get((photo as Record<string, unknown>).r2_key as string)
  if (!object) {
    return c.json({ error: '画像ファイルが見つかりません' }, 404)
  }

  c.header('Content-Type', object.httpMetadata?.contentType ?? 'image/jpeg')
  c.header('Content-Length', String(object.size))
  c.header('Cache-Control', 'public, max-age=31536000, immutable')
  return c.body(object.body as ReadableStream)
})

app.all('/mcp', async (c) => {
  const url = new URL(c.req.url)
  const baseUrl = `${url.protocol}//${url.host}`
  const server = createServer(c.env.DB, c.env.IMAGES, baseUrl)
  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

export default app
