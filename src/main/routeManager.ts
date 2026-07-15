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
import * as net from 'net'

const execAsync = promisify(exec)

/** Track which routes we've added so we can clean up */
const addedRoutes: string[] = []

/** Track secondary IP aliases we've added: targetSubnet -> { aliasIp, iface } */
const addedAliases = new Map<string, { aliasIp: string; iface: string }>()

/**
 * Detect the primary network interface and local IP.
 * Returns { iface, ip, subnet } or null.
 *
 * Skips any secondary IP WE added (see addSubnetAlias) so detection always
 * reflects the host's real primary network, never an alias of our own making.
 */
export function detectLocalNetwork(): { iface: string; ip: string; subnet: string } | null {
  const ourAliasIps = new Set(Array.from(addedAliases.values()).map((a) => a.aliasIp))
  const interfaces = os.networkInterfaces()
  for (const [iface, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal && !ourAliasIps.has(addr.address)) {
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
 * Every (iface, ip, subnet) the host natively holds (excludes our own aliases).
 * Unlike detectLocalNetwork() (first match only), this returns ALL of them —
 * needed on multi-homed hosts where two NICs coincidentally sit on the same
 * /24 range but lead to different physical LANs (see probeReachable below).
 */
function allLocalIfaces(): Array<{ iface: string; ip: string; subnet: string }> {
  const ourAliasIps = new Set(Array.from(addedAliases.values()).map((a) => a.aliasIp))
  const result: Array<{ iface: string; ip: string; subnet: string }> = []
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !ourAliasIps.has(addr.address)) {
        const p = addr.address.split('.')
        result.push({ iface, ip: addr.address, subnet: `${p[0]}.${p[1]}.${p[2]}` })
      }
    }
  }
  return result
}

/**
 * Quick TCP probe (device REST port 80) — used to tell whether a device is
 * ACTUALLY reachable, not just whether its /24 happens to number-match some
 * local interface (which can be a false positive on multi-homed hosts).
 */
function probeReachable(ip: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(80, ip)
  })
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
      // Modifying the routing table needs root — requires passwordless sudo.
      cmd = `sudo -n route add -net ${networkAddr}/24 -interface ${iface}`
    } else {
      // Linux: ip route add <network>/24 dev <iface>
      // Needs CAP_NET_ADMIN — requires passwordless sudo.
      cmd = `sudo -n ip route add ${networkAddr}/24 dev ${iface}`
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
      cmd = `sudo -n route delete -net ${networkAddr}/24`
    } else {
      cmd = `sudo -n ip route delete ${networkAddr}/24`
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

// ============================================
// Secondary IP aliases — the real cross-subnet fix
//
// On-link routes (above) only help when the device's gateway routes replies
// back to the host subnet. On networks where it does NOT, the device's TCP
// reply goes to its own gateway and never returns — so REST/control still fail
// even though UDP-broadcast discovery finds the device.
//
// Adding a secondary host IP IN the device's subnet makes the path on-link in
// BOTH directions (verified on real hardware: REST went from 0% to working).
// ============================================

/**
 * Add a same-subnet secondary IP (alias) on the host NIC so a cross-subnet
 * device becomes directly reachable over TCP/REST. No-op if the host is already
 * on that subnet or we've already added an alias for it.
 *
 *   Windows: netsh interface ipv4 add address name="<iface>" <ip> 255.255.255.0 store=active
 *   macOS:   sudo ifconfig <iface> alias <ip> 255.255.255.0
 *   Linux:   sudo ip addr add <ip>/24 dev <iface>
 *
 * darwin/linux need root (passwordless sudo) — Windows elevation is handled by
 * requestedExecutionLevel: requireAdministrator instead (see electron-builder.yml).
 *
 * `force` skips the "already on this subnet" shortcut — needed when a subnet
 * number coincidentally already exists on a DIFFERENT physical interface (see
 * ensureReachableForIps) and we deliberately alias it onto `iface` anyway.
 */
export async function addSubnetAlias(
  targetSubnet: string,
  hostIp: string,
  iface: string,
  force = false
): Promise<boolean> {
  const hostParts = hostIp.split('.')
  const hostSubnet = `${hostParts[0]}.${hostParts[1]}.${hostParts[2]}`
  if (!force && targetSubnet === hostSubnet) return true  // already on this subnet
  if (addedAliases.has(targetSubnet)) return true          // already aliased

  // Mirror the host's last octet — collision-unlikely vs factory defaults (.10/.200)
  const aliasIp = `${targetSubnet}.${hostParts[3]}`
  const platform = process.platform

  try {
    let cmd: string
    if (platform === 'win32') {
      cmd = `netsh interface ipv4 add address name="${iface}" ${aliasIp} 255.255.255.0 store=active`
    } else if (platform === 'darwin') {
      cmd = `sudo -n ifconfig ${iface} alias ${aliasIp} 255.255.255.0`
    } else {
      cmd = `sudo -n ip addr add ${aliasIp}/24 dev ${iface}`
    }

    console.log(`[Alias] Adding secondary IP: ${cmd}`)
    await execAsync(cmd)
    addedAliases.set(targetSubnet, { aliasIp, iface })
    console.log(`[Alias] ✅ ${aliasIp}/24 on ${iface}`)
    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/already|exists|EEXIST/i.test(msg)) {
      addedAliases.set(targetSubnet, { aliasIp, iface })
      console.log(`[Alias] ${aliasIp}/24 already present (OK)`)
      return true
    }
    console.log(`[Alias] ⚠️ Failed to add ${aliasIp}/24: ${msg}`)
    return false
  }
}

/** Remove a previously added secondary IP alias. */
async function removeSubnetAlias(info: { aliasIp: string; iface: string }): Promise<void> {
  const platform = process.platform
  try {
    let cmd: string
    if (platform === 'win32') {
      cmd = `netsh interface ipv4 delete address name="${info.iface}" address=${info.aliasIp}`
    } else if (platform === 'darwin') {
      cmd = `sudo -n ifconfig ${info.iface} -alias ${info.aliasIp}`
    } else {
      cmd = `sudo -n ip addr del ${info.aliasIp}/24 dev ${info.iface}`
    }
    console.log(`[Alias] Removing: ${cmd}`)
    await execAsync(cmd)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[Alias] ⚠️ Failed to remove ${info.aliasIp}: ${msg}`)
  }
}

/**
 * For each device IP that isn't actually reachable, add a same-subnet secondary
 * IP so the device list can read/control it. Best-effort; needs admin. Returns
 * the subnets that got an alias.
 *
 * Reachability is decided by PROBING the device, not by whether its /24 number
 * happens to match a local interface. On a multi-homed host, the same /24 range
 * can exist on two different physical NICs (e.g. two independent lab networks
 * that both number themselves 192.168.1.0/24) — trusting the number alone would
 * wrongly conclude the device is already reachable when it's actually sitting on
 * the OTHER NIC. When that happens, alias the subnet onto a different local
 * interface than the one that already natively owns it.
 */
export async function ensureReachableForIps(deviceIps: string[]): Promise<string[]> {
  const local = detectLocalNetwork()
  if (!local) return []
  const ifaces = allLocalIfaces()
  const nativeSubnets = new Map<string, string>() // subnet -> iface that owns it natively
  for (const { iface, subnet } of ifaces) {
    if (!nativeSubnets.has(subnet)) nativeSubnets.set(subnet, iface)
  }

  const added: string[] = []
  for (const ip of deviceIps) {
    const p = ip.split('.')
    if (p.length !== 4) continue
    const subnet = `${p[0]}.${p[1]}.${p[2]}`
    if (addedAliases.has(subnet)) continue

    const nativeIface = nativeSubnets.get(subnet)
    if (nativeIface && (await probeReachable(ip))) continue // genuinely reachable already

    if (nativeIface) {
      // Subnet number collides with a local NIC that can't actually reach this
      // device — alias it onto a different interface instead.
      const altIface = ifaces.find((f) => f.iface !== nativeIface)?.iface
      if (!altIface) continue // no other NIC to try
      if (await addSubnetAlias(subnet, local.ip, altIface, true)) added.push(subnet)
    } else {
      if (await addSubnetAlias(subnet, local.ip, local.iface)) added.push(subnet)
    }
  }
  return added
}

/** Clean up all secondary IP aliases we added. Call on app shutdown. */
export async function cleanupAllAliases(): Promise<void> {
  const entries = Array.from(addedAliases.values())
  addedAliases.clear()
  for (const info of entries) {
    await removeSubnetAlias(info)
  }
  if (entries.length > 0) {
    console.log(`[Alias] Cleaned up ${entries.length} secondary IPs`)
  }
}

// ============================================
// Multi-NIC broadcast targets
//
// A limited broadcast (255.255.255.255) is sent out only ONE interface on a
// multi-homed host (the default-route NIC), so devices on other NICs' segments
// are missed. Sending each NIC's subnet-directed broadcast (e.g. 192.168.1.255)
// instead lets the routing table deliver to the correct NIC per subnet — thus
// covering every NIC with no interface binding and no user configuration.
// ============================================

/** Subnet-directed broadcast for an IPv4 addr + netmask (or null if malformed). */
function directedBroadcast(ip: string, netmask: string): string | null {
  const ipParts = ip.split('.').map(Number)
  const maskParts = netmask.split('.').map(Number)
  if (ipParts.length !== 4 || maskParts.length !== 4) return null
  if (ipParts.some(Number.isNaN) || maskParts.some(Number.isNaN)) return null
  return ipParts.map((o, i) => o | (~maskParts[i] & 0xff)).join('.')
}

/**
 * Pure: build the DBP broadcast target list from an interface list. Always
 * includes 255.255.255.255; adds each non-internal IPv4 interface's directed
 * broadcast. Excludes our own alias IPs. Deduped.
 *
 * Known limitation: two NICs on the IDENTICAL subnet share one directed
 * broadcast, and Node dgram can't pin a broadcast to an egress interface, so
 * only the routed NIC is reached. Vanishingly rare in production.
 */
export function broadcastTargetsFrom(
  addrs: Array<{ address: string; netmask: string; family: string; internal: boolean }>,
  aliasIps: Set<string> = new Set()
): string[] {
  const targets = new Set<string>(['255.255.255.255'])
  for (const a of addrs) {
    if (a.family !== 'IPv4' || a.internal) continue
    if (aliasIps.has(a.address)) continue
    if (!a.netmask) continue
    const b = directedBroadcast(a.address, a.netmask)
    if (b) targets.add(b)
  }
  return Array.from(targets)
}

/** DBP broadcast targets for THIS host (limited + per-NIC directed broadcast). */
export function getBroadcastTargets(): string[] {
  const aliasIps = new Set(Array.from(addedAliases.values()).map((a) => a.aliasIp))
  const addrs: Array<{ address: string; netmask: string; family: string; internal: boolean }> = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      addrs.push({ address: a.address, netmask: a.netmask, family: a.family as string, internal: a.internal })
    }
  }
  return broadcastTargetsFrom(addrs, aliasIps)
}
