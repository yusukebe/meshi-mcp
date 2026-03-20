import { App } from '@modelcontextprotocol/ext-apps'

const titleEl = document.getElementById('title') as HTMLHeadingElement
const galleryEl = document.getElementById('gallery') as HTMLDivElement

let restaurantId: number | null = null
let baseUrl: string | null = null

const app = new App({ name: 'Meshi Photo Viewer', version: '1.0.0' })

app.ontoolinput = (params) => {
  const args = params.arguments as Record<string, unknown> | undefined
  if (args?.restaurant_id) {
    restaurantId = args.restaurant_id as number
  }
}

app.ontoolresult = (result) => {
  const sc = result.structuredContent as Record<string, unknown> | undefined
  if (sc?.restaurant_id) {
    restaurantId = sc.restaurant_id as number
  }
  if (sc?.base_url) {
    baseUrl = sc.base_url as string
  }
  if (sc?.restaurant_name) {
    titleEl.textContent = `${sc.restaurant_name} の写真`
  }
  loadPhotos()
}

async function loadPhotos() {
  if (!restaurantId) {
    galleryEl.innerHTML = '<div class="error">飯屋IDが取得できませんでした</div>'
    return
  }

  galleryEl.innerHTML = '<div class="loading">読み込み中...</div>'

  try {
    const base = baseUrl || 'https://meshi-mcp.yusukebe.workers.dev'
    const res = await fetch(`${base}/restaurants/${restaurantId}/photos`)
    if (!res.ok) throw new Error(await res.text())

    const photos = (await res.json()) as { id: number; caption: string | null }[]

    if (photos.length === 0) {
      galleryEl.innerHTML = '<div class="empty">まだ写真がありません</div>'
      return
    }

    galleryEl.innerHTML = ''
    for (const photo of photos) {
      const card = document.createElement('div')
      card.className = 'photo-card'

      const img = document.createElement('img')
      img.src = `${base}/photos/${photo.id}`
      img.alt = photo.caption || '写真'
      img.loading = 'lazy'
      card.appendChild(img)

      if (photo.caption) {
        const cap = document.createElement('div')
        cap.className = 'caption'
        cap.textContent = photo.caption
        card.appendChild(cap)
      }

      galleryEl.appendChild(card)
    }
  } catch (e) {
    galleryEl.innerHTML = `<div class="error">エラー: ${(e as Error).message}</div>`
  }
}

app.connect()
