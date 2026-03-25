import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { createServer } from './mcp'
import { MeshiApi } from './meshi-api'
import { PhotoApi } from './photo-api'

type Bindings = {
  DB: D1Database
  IMAGES: R2Bucket
  AUTH_TOKEN: string
  LOADER: WorkerLoader
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

// --- Auth helper ---

function resolveAuth(c: { env: Bindings; req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }) {
  const token = c.req.query('token') || c.req.header('Authorization')?.replace('Bearer ', '')
  const isAdmin = !!c.env.AUTH_TOKEN && token === c.env.AUTH_TOKEN
  return { token, isAdmin }
}

// --- Photo HTTP API ---

app.get('/restaurants/:id/photos', async (c) => {
  const photo = new PhotoApi(c.env.DB, c.env.IMAGES)
  const photos = await photo.list(Number(c.req.param('id')))
  return c.json(photos)
})

app.post('/restaurants/:id/photos', async (c) => {
  const { isAdmin } = resolveAuth(c)
  if (!isAdmin) {
    return c.json({ error: '認証が必要です' }, 401)
  }

  const restaurantId = Number(c.req.param('id'))
  const meshi = new MeshiApi(c.env.DB)
  const restaurant = await meshi.get(restaurantId)
  if (!restaurant) {
    return c.json({ error: '飯屋が見つかりません' }, 404)
  }

  const formData = await c.req.formData()
  const file = formData.get('photo')
  if (!file || !(file instanceof File)) {
    return c.json({ error: 'photo フィールドが必要です' }, 400)
  }

  const caption = formData.get('caption')?.toString() ?? undefined
  const photo = new PhotoApi(c.env.DB, c.env.IMAGES)
  const result = await photo.upload(restaurantId, file, caption)

  return c.json({
    id: result.id,
    restaurant_id: restaurantId,
    caption: caption ?? null,
    url: `/photos/${result.id}`,
  }, 201)
})

app.get('/photos/:id', async (c) => {
  const photo = new PhotoApi(c.env.DB, c.env.IMAGES)
  const obj = await photo.getObject(Number(c.req.param('id')))
  if (!obj) {
    return c.json({ error: '写真が見つかりません' }, 404)
  }

  c.header('Content-Type', obj.contentType)
  c.header('Content-Length', String(obj.size))
  c.header('Cache-Control', 'public, max-age=31536000, immutable')
  return c.body(obj.body)
})

// --- MCP endpoint ---

app.all('/mcp', async (c) => {
  const url = new URL(c.req.url)
  const baseUrl = `${url.protocol}//${url.host}`
  const { token, isAdmin } = resolveAuth(c)

  const server = createServer({
    db: c.env.DB,
    images: c.env.IMAGES,
    loader: c.env.LOADER,
    baseUrl,
    isAdmin,
    authToken: isAdmin ? token : undefined,
  })

  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

export default app
