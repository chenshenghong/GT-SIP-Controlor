// ============================================
// SIP CMS — Pinia Auth Token Store
// Phase 1: Per-device token isolation dictionary
// ============================================
import { defineStore } from 'pinia'
import type { TokenDictionary } from '@shared/types'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    // Structure: { "192.168.1.200": "eyJhbGciOi...", "192.168.1.201": "..." }
    tokens: {} as TokenDictionary,
  }),

  actions: {
    setToken(ip: string, token: string): void {
      this.tokens[ip] = token
    },

    getToken(ip: string): string | null {
      return this.tokens[ip] || null
    },

    clearToken(ip: string): void {
      delete this.tokens[ip]
    },

    clearAll(): void {
      this.tokens = {}
    },
  },
})
