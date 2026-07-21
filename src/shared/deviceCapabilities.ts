// ============================================
// SIP CMS — 設備能力表（依 deviceKind 靜態分派）
// renderer/main 共用；UI 條件渲染與請求 gating 的唯一依據，
// 避免散落 if (kind === ...) 判斷。
// ============================================
import type { DeviceKind } from './types'

export interface DeviceCapabilities {
  /** 可用 DBP UDP SET 改 IP（ipChanger） */
  canChangeIpViaDbp: boolean
  /** 可用 GT REST JSON（/get/device/status、/get/sip/config 等） */
  canGtRest: boolean
  /** 可納入 GT REST 批次同步（BatchSyncModal） */
  canBatchSyncRest: boolean
  /** 支援 GT 通話控制 REST */
  canCallControl: boolean
  /** 走 DAYU Rapid Logic Web 表單協定（nonce/MD5 登入） */
  hasDayuWebForm: boolean
  /** 音量 canonical 量程上限（GT: 0-100；DAYU: 0-9 原始等級） */
  volumeScaleMax: number
}

const CAPABILITIES: Record<DeviceKind, DeviceCapabilities> = {
  'gt-sip-gw': {
    canChangeIpViaDbp: true,
    canGtRest: true,
    canBatchSyncRest: true,
    canCallControl: true,
    hasDayuWebForm: false,
    volumeScaleMax: 100,
  },
  'dayu-ot300': {
    canChangeIpViaDbp: false,
    canGtRest: false,
    canBatchSyncRest: false,
    canCallControl: false,
    hasDayuWebForm: true,
    volumeScaleMax: 9,
  },
}

export function getDeviceCapabilities(kind: DeviceKind): DeviceCapabilities {
  return CAPABILITIES[kind]
}
