import { McpServer } from '@modelcontextprotocol/server'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { DynamicWorkerExecutor, resolveProvider, type ToolProvider } from '@cloudflare/codemode'
import { z } from 'zod'
import { MeshiApi } from './meshi-api'
import { PhotoApi } from './photo-api'
import uploadPhotoHtml from '../dist/index.html'
import viewPhotosHtml from '../dist-photos/photos.html'

export interface CreateServerOptions {
  db: D1Database
  images: R2Bucket
  loader: WorkerLoader
  baseUrl: string
  isAdmin: boolean
  authToken?: string
}

const UNAUTHORIZED = {
  content: [{ type: 'text' as const, text: 'この操作は管理者（yusukebe）のみ実行できます。閲覧・検索は誰でもできますが、登録・更新・削除は管理者専用です。' }],
}

const MESHI_TYPES_READ = `\
interface Restaurant {
  id: number
  name: string
  area: string | null
  genre: string | null
  memo: string | null
  rating: number | null
  google_maps_url: string | null
  created_at: string
  updated_at: string
}

declare const meshi: {
  search(input: { query?: string; area?: string; genre?: string }): Promise<Restaurant[]>
  get(input: { id: number }): Promise<Restaurant | null>
  list(input?: { limit?: number; offset?: number }): Promise<Restaurant[]>
}`

const MESHI_TYPES_WRITE = `\
interface Restaurant {
  id: number
  name: string
  area: string | null
  genre: string | null
  memo: string | null
  rating: number | null
  google_maps_url: string | null
  created_at: string
  updated_at: string
}

declare const meshi: {
  search(input: { query?: string; area?: string; genre?: string }): Promise<Restaurant[]>
  get(input: { id: number }): Promise<Restaurant | null>
  list(input?: { limit?: number; offset?: number }): Promise<Restaurant[]>
  add(input: { name: string; area?: string; genre?: string; memo?: string; rating?: number; google_maps_url?: string }): Promise<{ id: number }>
  update(input: { id: number; name?: string; area?: string; genre?: string; memo?: string; rating?: number; google_maps_url?: string }): Promise<void>
  delete(input: { id: number }): Promise<void>
}`

function buildMeshiProvider(meshi: MeshiApi, isAdmin: boolean): ToolProvider {
  const readTools: ToolProvider['tools'] = {
    search: { execute: async (args: unknown) => meshi.search(args as Parameters<MeshiApi['search']>[0]) },
    get: { execute: async (args: unknown) => meshi.get((args as { id: number }).id) },
    list: { execute: async (args: unknown) => meshi.list(args as Parameters<MeshiApi['list']>[0]) },
  }

  const writeTools: ToolProvider['tools'] = {
    add: { execute: async (args: unknown) => meshi.add(args as Parameters<MeshiApi['add']>[0]) },
    update: { execute: async (args: unknown) => {
      const { id, ...fields } = args as { id: number } & Parameters<MeshiApi['update']>[1]
      return meshi.update(id, fields)
    }},
    delete: { execute: async (args: unknown) => meshi.delete((args as { id: number }).id) },
  }

  return {
    name: 'meshi',
    tools: isAdmin ? { ...readTools, ...writeTools } : readTools,
    types: isAdmin ? MESHI_TYPES_WRITE : MESHI_TYPES_READ,
  }
}

export function createServer(options: CreateServerOptions) {
  const { db, images, loader, baseUrl, isAdmin, authToken } = options
  const meshi = new MeshiApi(db)
  const photo = new PhotoApi(db, images)

  const server = new McpServer({
    name: 'meshi-mcp',
    version: '0.1.0',
  })

  // --- code tool ---

  const meshiProvider = buildMeshiProvider(meshi, isAdmin)
  const resolved = resolveProvider(meshiProvider)
  const executor = new DynamicWorkerExecutor({ loader })
  const types = isAdmin ? MESHI_TYPES_WRITE : MESHI_TYPES_READ

  server.registerTool(
    'code',
    {
      title: 'コード実行',
      description: `飯屋データを操作するJavaScriptコードを実行する。yusukebe が登録した飯屋の検索・閲覧ができる。

【重要】飯屋を登録・更新する際は必ずデータを正規化すること:
- 店名はGoogle Mapsや公式情報から正式名称を使う（例: ×「あのラーメン屋」→ ○「麺屋 一燈」）
- エリアは最寄り駅や地名で統一（例: 「東京都新宿区」ではなく「新宿」）
- ジャンルは簡潔に（例: ラーメン、寿司、イタリアン、中華、カレー、焼肉）
- Google MapsのURLがわかる場合は必ず含める
- memoに入れるコメントは誤字・脱字を修正し、読みやすく整えてから登録する

利用可能なAPI:

${types}

コード例:
// 渋谷のラーメン屋を検索
const shops = await meshi.search({ genre: "ラーメン", area: "渋谷" })
return shops

// 全店舗を取得して評価順にソート
const all = await meshi.list({ limit: 100 })
return all.filter(r => r.rating).sort((a, b) => b.rating - a.rating)`,
      inputSchema: {
        code: z.string().describe('実行するJavaScriptコード（async関数のbody）'),
      },
    },
    async ({ code }) => {
      const result = await executor.execute(code, [resolved])

      if (result.error) {
        return { content: [{ type: 'text' as const, text: `エラー: ${result.error}` }] }
      }

      const output = typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result, null, 2)

      const parts: Array<{ type: 'text'; text: string }> = [{ type: 'text' as const, text: output }]
      if (result.logs?.length) {
        parts.push({ type: 'text' as const, text: `\n--- Logs ---\n${result.logs.join('\n')}` })
      }
      return { content: parts }
    }
  )

  // --- MCP Apps: upload_photo ---

  const uploadResourceUri = 'ui://meshi-mcp/upload-photo'

  registerAppTool(server as any,
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
        auth_token: z.string().optional(),
        message: z.string(),
      }),
      _meta: { ui: { resourceUri: uploadResourceUri } },
    },
    async ({ restaurant_id }) => {
      if (!isAdmin) return UNAUTHORIZED
      const r = await meshi.get(restaurant_id)
      if (!r) {
        return { content: [{ type: 'text' as const, text: `ID ${restaurant_id} の飯屋は見つかりませんでした` }] }
      }
      return {
        content: [{ type: 'text' as const, text: `${r.name} の写真アップロードUIを表示中` }],
        structuredContent: { restaurant_id, upload_base_url: baseUrl, auth_token: authToken, message: `${r.name} への写真アップロード` },
      }
    }
  )

  registerAppResource(server as any,
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

  // --- MCP Apps: view_photos ---

  const viewPhotosResourceUri = 'ui://meshi-mcp/view-photos'

  registerAppTool(server as any,
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
      const r = await meshi.get(restaurant_id)
      if (!r) {
        return { content: [{ type: 'text' as const, text: `ID ${restaurant_id} の飯屋は見つかりませんでした` }] }
      }

      const photos = await photo.list(restaurant_id)

      return {
        content: [{ type: 'text' as const, text: `${r.name} の写真を表示中（${photos.length}枚）` }],
        structuredContent: {
          restaurant_id,
          restaurant_name: r.name,
          base_url: baseUrl,
          photo_count: photos.length,
        },
      }
    }
  )

  registerAppResource(server as any,
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

  return server
}
