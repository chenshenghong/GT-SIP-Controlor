// ============================================
// SIP CMS — DBP/1.0 IP Changer (Main Process)
// Implements "SET DBP/1.0" command per QueryTool analysis
// Now includes CSeq header matching original exe format
// ============================================
import * as net from 'net'
import { PORT_DETECT_TIMEOUT_MS } from '@shared/constants'
import { getActivePort } from './scanner'
import type { IpChangeRequest } from '@shared/types'

/**
 * Build the SET DBP/1.0 command body with CSeq header.
 *
 * Format (per exe analysis — symmetric with GET):
 *   SET DBP/1.0
 *   CSeq: 1
 *   IP: 192.168.1.200
 *   Mask: 255.255.255.0
 *   Gateway: 192.168.1.1
 *   AutoIP: 0
 *   DNS1: 8.8.8.8       (optional)
 *   DNS2: 8.8.4.4       (optional)
 */
function buildSetCommand(req: IpChangeRequest): string {
  let cmd = 'SET DBP/1.0\r\n'
  cmd += 'CSeq: 1\r\n'
  cmd += `IP: ${req.newIp}\r\n`
  cmd += `Mask: ${req.newMask}\r\n`
  cmd += `Gateway: ${req.newGateway}\r\n`
  cmd += `AutoIP: ${req.autoIp}\r\n`
  if (req.dns1) cmd += `DNS1: ${req.dns1}\r\n`
  if (req.dns2) cmd += `DNS2: ${req.dns2}\r\n`
  cmd += '\r\n'
  return cmd
}

/**
 * Send SET DBP/1.0 command to change a device's IP configuration.
 *
 * Uses the auto-detected port from scanner module.
 *
 * After success, the device will reboot and the old IP becomes unreachable.
 * The renderer should trigger ReconnectOverlay to poll the NEW IP.
 */
export function changeDeviceIp(
  request: IpChangeRequest
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let responseData = ''
    const timeout = PORT_DETECT_TIMEOUT_MS * 2 // 3 seconds for SET operations
    const port = getActivePort()

    socket.setTimeout(timeout)

    socket.once('connect', () => {
      const cmd = buildSetCommand(request)
      console.log(`[DBP SET] Sending to ${request.targetIp}:${port}`)
      socket.write(cmd)
    })

    socket.on('data', (chunk) => {
      responseData += chunk.toString('utf-8')
    })

    socket.once('end', () => {
      socket.destroy() // IRON RULE
      if (responseData.includes('200 OK') || responseData.includes('200')) {
        console.log(`[DBP SET] ✅ IP changed successfully`)
        resolve({ success: true })
      } else {
        resolve({ success: false, error: `Unexpected response: ${responseData.trim()}` })
      }
    })

    socket.once('timeout', () => {
      socket.destroy() // IRON RULE
      resolve({ success: false, error: 'Connection timeout' })
    })

    socket.once('error', (err) => {
      socket.destroy() // IRON RULE
      resolve({ success: false, error: `TCP error: ${err.message}` })
    })

    socket.connect(port, request.targetIp)
  })
}
