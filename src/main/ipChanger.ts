// ============================================
// SIP CMS — DBP/1.0 IP Changer (Main Process)
// Implements "SET DBP/1.0" command per protocol spec
// ============================================
import * as net from 'net'
import { DBP_PORT, SCAN_TIMEOUT_MS } from '@shared/constants'
import type { IpChangeRequest } from '@shared/types'

/**
 * Build the SET DBP/1.0 command body
 *
 * Format (per spec — symmetric with GET response):
 *   SET DBP/1.0
 *   IP: 192.168.1.200
 *   Mask: 255.255.255.0
 *   Gateway: 192.168.1.1
 *   AutoIP: 0
 *   DNS1: 8.8.8.8       (optional)
 *   DNS2: 8.8.4.4       (optional)
 */
function buildSetCommand(req: IpChangeRequest): string {
  let cmd = 'SET DBP/1.0\r\n'
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
 * Flow:
 *   1. TCP connect to targetIp:DBP_PORT
 *   2. Send "SET DBP/1.0" + parameters
 *   3. Wait for "DBP/1.0 200 OK" confirmation
 *   4. socket.destroy() — IRON RULE
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
    const timeout = SCAN_TIMEOUT_MS * 10 // 3 seconds for SET operations

    socket.setTimeout(timeout)

    socket.once('connect', () => {
      const cmd = buildSetCommand(request)
      socket.write(cmd)
    })

    socket.on('data', (chunk) => {
      responseData += chunk.toString('utf-8')
    })

    socket.once('end', () => {
      socket.destroy() // IRON RULE
      // Check for success response
      if (responseData.includes('200 OK')) {
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

    socket.connect(DBP_PORT, request.targetIp)
  })
}
