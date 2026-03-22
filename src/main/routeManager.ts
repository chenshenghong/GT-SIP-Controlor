// ============================================
// SIP CMS — Cross-Subnet Route Manager (Main Process)
//
// Problem: SIP devices may have factory IP 192.168.1.200 but
// the scanning host is on 192.168.0.x — TCP fails because
// the OS routes 192.168.1.x via gateway instead of direct L2.
//
// Solution: Temporarily add on-link routes before scanning,
// so the OS sends ARP directly on the LAN interface.
//
// Windows: route add 192.168.1.0 mask 255.255.255.0 <local_ip> metric 1
// macOS:   route add -net 192.168.1.0/24 -interface en0
// Linux:   ip route add 192.168.1.0/24 dev eth0
// ============================================
import { exec } from 'child_process'
import { promisify } from 'util'
import * as os from 'os'

const execAsync = promisify(exec)

/** Track which routes we've added so we can clean up */
const addedRoutes: string[] = []

/**
 * Detect the primary network interface and local IP.
 * Returns { iface, ip, subnet } or null.
 */
export function detectLocalNetwork(): { iface: string; ip: string; subnet: string } | null {
  const interfaces = os.networkInterfaces()
  for (const [iface, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.')
        return {
          iface,
          ip: addr.address,
          subnet: `${parts[0]}.${parts[1]}.${parts[2]}`,
        }
      }
    }
  }
  return null
}

/**
 * Get all subnets that need scanning.
 * Returns array of subnet prefixes like ['192.168.1', '192.168.0'].
 *
 * Always includes:
 * 1. The host's own subnet (already reachable)
 * 2. Common factory default subnets (need on-link routes)
 * 3. Any user-configured additional subnets
 */
export function getTargetSubnets(
  localSubnet: string,
  additionalSubnets: string[] = []
): string[] {
  const FACTORY_SUBNETS = [
    '192.168.1',   // Most common factory default
    '192.168.0',   // Alternative factory default
    '192.168.3',   // QueryTool config.ini default
  ]

  const all = new Set<string>()
  all.add(localSubnet) // User's own subnet (always first)

  for (const s of FACTORY_SUBNETS) {
    all.add(s)
  }
  for (const s of additionalSubnets) {
    all.add(s)
  }

  return Array.from(all)
}

/**
 * Add an on-link route for a target subnet so that TCP connections
 * can reach devices on a different IP subnet but same L2 segment.
 *
 * Cross-platform: Windows / macOS / Linux
 */
export async function addOnLinkRoute(
  targetSubnet: string,
  localIp: string,
  iface: string
): Promise<boolean> {
  const networkAddr = `${targetSubnet}.0`

  // Don't add route for our own subnet — it's already reachable
  const localParts = localIp.split('.')
  const localSubnet = `${localParts[0]}.${localParts[1]}.${localParts[2]}`
  if (targetSubnet === localSubnet) return true

  const platform = process.platform

  try {
    let cmd: string

    if (platform === 'win32') {
      // Windows: route add <network> mask 255.255.255.0 <local_ip> metric 1
      // Using local_ip as gateway tells Windows to send directly via this interface
      cmd = `route add ${networkAddr} mask 255.255.255.0 ${localIp} metric 1`
    } else if (platform === 'darwin') {
      // macOS: route add -net <network>/24 -interface <iface>
      // Requires sudo in production; in dev may need passwordless sudo
      cmd = `route add -net ${networkAddr}/24 -interface ${iface}`
    } else {
      // Linux: ip route add <network>/24 dev <iface>
      cmd = `ip route add ${networkAddr}/24 dev ${iface}`
    }

    console.log(`[Route] Adding on-link route: ${cmd}`)
    await execAsync(cmd)
    addedRoutes.push(targetSubnet)
    console.log(`[Route] ✅ Route added for ${networkAddr}/24`)
    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // Route may already exist — that's OK
    if (msg.includes('already exists') || msg.includes('File exists') || msg.includes('EEXIST')) {
      console.log(`[Route] Route for ${networkAddr}/24 already exists (OK)`)
      addedRoutes.push(targetSubnet)
      return true
    }
    console.log(`[Route] ⚠️ Failed to add route for ${networkAddr}/24: ${msg}`)
    // Don't fail the scan — the subnet just won't be reachable
    return false
  }
}

/**
 * Remove a previously added on-link route.
 */
export async function removeOnLinkRoute(targetSubnet: string): Promise<void> {
  const networkAddr = `${targetSubnet}.0`
  const platform = process.platform

  try {
    let cmd: string

    if (platform === 'win32') {
      cmd = `route delete ${networkAddr}`
    } else if (platform === 'darwin') {
      cmd = `route delete -net ${networkAddr}/24`
    } else {
      cmd = `ip route delete ${networkAddr}/24`
    }

    console.log(`[Route] Removing route: ${cmd}`)
    await execAsync(cmd)
    console.log(`[Route] ✅ Route removed for ${networkAddr}/24`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[Route] ⚠️ Failed to remove route for ${networkAddr}/24: ${msg}`)
  }
}

/**
 * Add on-link routes for all target subnets that differ from local.
 */
export async function addRoutesForScan(
  targetSubnets: string[],
  localIp: string,
  iface: string
): Promise<void> {
  for (const subnet of targetSubnets) {
    await addOnLinkRoute(subnet, localIp, iface)
  }
}

/**
 * Clean up all temporarily added routes.
 * Should be called after scanning completes AND on app shutdown.
 */
export async function cleanupAllRoutes(): Promise<void> {
  const routes = [...addedRoutes]
  addedRoutes.length = 0

  for (const subnet of routes) {
    await removeOnLinkRoute(subnet)
  }

  if (routes.length > 0) {
    console.log(`[Route] Cleaned up ${routes.length} temporary routes`)
  }
}
