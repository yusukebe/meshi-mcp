import { App } from '@modelcontextprotocol/ext-apps'

const photoInput = document.getElementById('photo') as HTMLInputElement
const captionInput = document.getElementById('caption') as HTMLInputElement
const uploadBtn = document.getElementById('upload-btn') as HTMLButtonElement
const previewImg = document.getElementById('preview') as HTMLImageElement
const statusDiv = document.getElementById('status') as HTMLDivElement

let restaurantId: number | null = null
let uploadBaseUrl: string | null = null

const app = new App({ name: 'Meshi Photo Upload', version: '1.0.0' })

photoInput.addEventListener('change', () => {
  const file = photoInput.files?.[0]
  if (file) {
    uploadBtn.disabled = false
    previewImg.src = URL.createObjectURL(file)
    previewImg.style.display = 'block'
  }
})

function setStatus(msg: string, type: string) {
  statusDiv.textContent = msg
  statusDiv.className = 'status ' + type
}

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
  if (sc?.upload_base_url) {
    uploadBaseUrl = sc.upload_base_url as string
  }
}

uploadBtn.addEventListener('click', async () => {
  const file = photoInput.files?.[0]
  if (!file || !restaurantId) {
    if (!restaurantId) setStatus('飯屋IDが取得できませんでした', 'error')
    return
  }

  uploadBtn.disabled = true
  setStatus('アップロード中...', 'loading')

  try {
    const formData = new FormData()
    formData.append('photo', file)
    const caption = captionInput.value.trim()
    if (caption) formData.append('caption', caption)

    const base = uploadBaseUrl || 'https://meshi-mcp.yusukebe.workers.dev'
    const res = await fetch(`${base}/restaurants/${restaurantId}/photos`, {
      method: 'POST',
      body: formData,
    })

    if (!res.ok) throw new Error(await res.text())
    const data = await res.json() as { id: number }
    setStatus(`アップロード完了！(photo_id: ${data.id})`, 'success')

    await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: `写真をアップロードしました (photo_id: ${data.id})` }],
    }).catch(() => {})
  } catch (e) {
    setStatus(`エラー: ${(e as Error).message}`, 'error')
    uploadBtn.disabled = false
  }
})

app.connect()
