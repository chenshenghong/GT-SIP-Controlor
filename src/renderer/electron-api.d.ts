// ============================================
// SIP CMS — Renderer 全域型別宣告
// tsconfig.web.json 不 include src/preload/**，
// 故 preload 的 declare global 對 renderer 型別檢查無效，
// 這裡另外補上 window.electronAPI 的全域宣告。
// ============================================
import type { ElectronAPI } from '../preload'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
