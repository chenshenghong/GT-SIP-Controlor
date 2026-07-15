// ============================================
// SIP CMS — DBP/1.0 IP Changer (Main Process)
//
// Verified by capturing the factory QueryTool re-IP'ing a real GT-SIP-GW
// (2026-07-15, tcpdump on the shared L2 segment). The SET is NOT TCP — it is a
// UDP BROADCAST to 255.255.255.255:58001, the SAME channel as discovery. The
// device is addressed by MAC in the request line, so the command reaches it
// regardless of IP subnet (broadcast needs no routing). THAT is why the factory
// tool can re-IP a device sitting on a foreign subnet, and why the old TCP
// unicast implementation could never work — the device has no DBP TCP listener
// at all (verified: full 1-65535 port sweep found only 80/443/ssh).
//
// Captured SET (device 20:23:5A:A1:FD:F9, its current IP is irrelevant):
//   -> 255.255.255.255:58001  (src <ephemeral>)
//      "1005 UNKOWN 20:23:5A:A1:FD:F9 DBP/1.0\r\n"   <- <ID> <Type> <MAC> DBP/1.0
//      "CSeq: 12\r\nType: UNKOWN\r\nID: 1005\r\n"
//      "IP: 192.168.1.151\r\nMask: ...\r\nGateway: ...\r\n"  <- the change
//      "Server: ...\r\nServer2: ...\r\nIsBroadcast: 1\r\nUseDNS: 0\r\n"
//      "AutoIP: 0\r\nTreble: 0\r\nBass: 0\r\nEncrypt: 1\r\nName: SipTerm\r\n"
//      "GROUP: 9999\r\nAGC: 4\r\nVOL: 50\r\nCAP: 50\r\n"
//      "IFCFG-APP: <b64 of {PTT,COR,ROLE}>\r\nReboot: 1\r\n\r\n"
//   <- <device_ip>:58001 -> broadcast:<src_port>  "DBP/1.0 200 OK\r\nCSeq: 12\r\n\r\n"
//
// Every non-IP field is echoed from the device's discovered config so the SET
// changes ONLY the address — matching the factory tool exactly. Reboot: 1 tells
// the device to restart and apply.
// ============================================
import * as dgram from 'dgram'
import type { DeviceNode, IpChangeRequest } from '@shared/types'

const DBP_PORT = 58001

/** Monotonic CSeq so a reply can be matched to the request that caused it. */
let cseqCounter = 100

/**
 * Rebuild the factory tool's IFCFG-APP: base64 of {COR,PTT,ROLE,key_name}.
 * Echoes the device's current PTT/COR/ROLE (captured in discovery) so the SET
 * doesn't wipe them; defaults to "0" (firmware default) when unknown.
 */
function buildIfcfgApp(d: DeviceNode): string {
  const payload = {
    COR: d.cor ?? '0',
    PTT: d.ptt ?? '0',
    ROLE: d.role ?? '0',
    key_name: ['PTT', 'COR', 'ROLE'],
  }
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')
}

/** Build the raw DBP SET packet (pure ASCII text, no binary prefix). */
function buildSetPacket(req: IpChangeRequest, cseq: number): Buffer {
  const d = req.device
  const type = d.type || 'UNKOWN'
  const lines = [
    `${d.id} ${type} ${d.mac} DBP/1.0`, // request line: addressed by MAC
    `CSeq: ${cseq}`,
    `Type: ${type}`,
    `ID: ${d.id}`,
    `IP: ${req.newIp}`, // \
    `Mask: ${req.newMask}`, //  > the only fields we change
    `Gateway: ${req.newGateway}`, // /
    `Server: ${d.server}`,
    `Server2: ${d.server2}`,
    `IsBroadcast: 1`,
    `UseDNS: ${d.useDns}`,
    `AutoIP: ${req.autoIp}`, // 0=static, 1=DHCP
    // Discovery does NOT report Treble/Bass/Encrypt (verified against the reply
    // schema), so these come from the tool, not the device. We reproduce the
    // exact literals the factory QueryTool sends — notably Encrypt: 1, which the
    // device firmware expects on a SET and which our discovered d.encrypt (always
    // 0, since the field is never in the reply) would otherwise get wrong.
    `Treble: 0`,
    `Bass: 0`,
    `Encrypt: 1`,
    `Name: ${d.name}`,
    `GROUP: ${d.group}`,
    `AGC: ${d.tbAgc}`,
    `VOL: ${d.playVol}`,
    `CAP: ${d.captureVol}`,
    `IFCFG-APP: ${buildIfcfgApp(d)}`,
    `Reboot: 1`, // restart & apply
  ]
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'ascii')
}

/**
 * Change a device's IP via DBP SET (UDP broadcast, addressed by MAC).
 *
 * Works cross-subnet — no route/alias needed — because the request is broadcast
 * and the device self-selects by MAC. After a 200 OK the device reboots and the
 * old IP goes offline; the renderer polls the NEW IP to confirm recovery.
 */
export function changeDeviceIp(
  request: IpChangeRequest
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!request.device?.mac) {
      resolve({ success: false, error: 'Missing device MAC (cannot address SET)' })
      return
    }

    const cseq = ++cseqCounter
    const targetMac = request.device.mac.toUpperCase()
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false

    const finish = (result: { success: boolean; error?: string }) => {
      if (settled) return
      settled = true
      try { sock.close() } catch { /* ignore */ }
      resolve(result)
    }

    sock.on('message', (msg) => {
      const text = msg.toString('utf-8')
      // The addressed device answers "DBP/1.0 200 OK" carrying OUR CSeq. Devices
      // not targeted by this MAC ignore the SET, so a matching CSeq is ours.
      if (text.includes('200 OK') && text.includes(`CSeq: ${cseq}`)) {
        console.log(`[DBP SET] ✅ ${targetMac} accepted IP ${request.newIp}`)
        finish({ success: true })
      }
    })
    sock.on('error', (err) => finish({ success: false, error: `UDP error: ${err.message}` }))

    sock.bind(() => {
      try { sock.setBroadcast(true) } catch { /* ignore */ }
      const packet = buildSetPacket(request, cseq)
      const blast = () => {
        if (!settled) sock.send(packet, DBP_PORT, '255.255.255.255', () => { /* ignore */ })
      }
      console.log(`[DBP SET] Broadcasting → ${targetMac} new IP ${request.newIp} (CSeq ${cseq})`)
      blast()
      setTimeout(blast, 300)  // UDP can drop; resend once
      setTimeout(() => finish({ success: false, error: '設備未在時限內回應 200 OK' }), 3000)
    })
  })
}
