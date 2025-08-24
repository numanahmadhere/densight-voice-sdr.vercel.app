"use client"
import { useEffect, useRef, useState } from "react"

type Conn = {
  pc: RTCPeerConnection | null
  dc: RTCDataChannel | null
  mic: MediaStream | null
}

function waitForChannelOpen(dc: RTCDataChannel, timeoutMs = 8000) {
  if (dc.readyState === "open") return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("DC open timeout")), timeoutMs)
    const onOpen = () => {
      clearTimeout(t)
      dc.removeEventListener("open", onOpen)
      dc.removeEventListener("close", onClose)
      resolve()
    }
    const onClose = () => {
      clearTimeout(t)
      dc.removeEventListener("open", onOpen)
      dc.removeEventListener("close", onClose)
      reject(new Error("DC closed before open"))
    }
    dc.addEventListener("open", onOpen)
    dc.addEventListener("close", onClose)
  })
}

export default function Home() {
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">("idle")
  const [you, setYou] = useState("") // Your transcript
  const [agent, setAgent] = useState("") // Agent transcript
  const [errors, setErrors] = useState<string | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const conn = useRef<Conn>({ pc: null, dc: null, mic: null })

  const append = (setter: (v: string) => void, chunk: string) => setter((prev) => (prev ? prev + chunk : chunk))

  async function start() {
    try {
      setErrors(null)
      setStatus("connecting")

      const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? "https://<your-render-service>.onrender.com"

      // Optional warm-up
      fetch(`${BASE}/health`).catch(() => {})

      // 1) RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      })
      conn.current.pc = pc

      // Remote audio element
      if (!audioRef.current) {
        const el = document.createElement("audio")
        el.autoplay = true
        el.muted = false
        el.volume = 1.0
        el.playsInline = true
        document.body.appendChild(el)
        audioRef.current = el
      }
      pc.ontrack = (e) => {
        if (audioRef.current) audioRef.current.srcObject = e.streams[0]
      }

      const dc = pc.createDataChannel("oai-events", { ordered: true })
      conn.current.dc = dc

      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)

          // USER (your) transcript
          if (msg.type === "input_audio_transcription.delta" || msg.type === "transcript.delta") {
            append(setYou, msg.delta ?? "")
            return
          }
          if (msg.type === "input_audio_transcription.completed" || msg.type === "transcript.completed") {
            append(setYou, "\n")
            return
          }

          // AGENT transcript
          if (msg.type === "response.output_text.delta") {
            append(setAgent, msg.delta ?? "")
            return
          }
          if (msg.type === "response.output_text.done") {
            append(setAgent, "\n")
            return
          }

          // Tool call: logLead
          if (msg.type === "response.function_call" && msg.name === "logLead") {
            fetch(`${BASE}/tools/logLead`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(msg.arguments || {}),
            }).catch(() => {})
            return
          }

          // Debug: uncomment to inspect unknown events
          // console.log("EV", msg);
        } catch {
          // ignore non-JSON pings
        }
      }

      // 3) Mic
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      conn.current.mic = mic
      mic.getTracks().forEach((t) => pc.addTrack(t, mic))

      // 4) SDP offer
      const offer = await pc.createOffer({ offerToReceiveAudio: true })
      await pc.setLocalDescription(offer)

      const sdpResp = await fetch(`${BASE}/webrtc/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      }).catch((e) => {
        throw new Error(`Fetch /webrtc/offer network error: ${e.message}`)
      })

      if (!sdpResp.ok) {
        const t = await sdpResp.text()
        throw new Error(`/webrtc/offer ${sdpResp.status}: ${t.slice(0, 250)}`)
      }

      const answerSDP = await sdpResp.text()
      await pc.setRemoteDescription({ type: "answer", sdp: answerSDP })

      // 6) Wait for data channel to open before sending kickoff
      await waitForChannelOpen(dc)

      // Optional: also wait briefly for ICE to connect
      await new Promise<void>((resolve) => {
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          return resolve()
        }
        const handler = () => {
          if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            pc.removeEventListener("iceconnectionstatechange", handler)
            resolve()
          }
        }
        pc.addEventListener("iceconnectionstatechange", handler)
        setTimeout(() => {
          pc.removeEventListener("iceconnectionstatechange", handler)
          resolve()
        }, 2000)
      })

      // 7) Kickoff greeting (additional to server conversation_starters)
      dc.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: "Please greet the user and introduce yourself as Densight's SDR. Keep it short and friendly.",
            modalities: ["audio"],
          },
        }),
      )

      // Optional tiny user poke
      dc.send(JSON.stringify({ type: "input_text.append", text: "Hi there!" }))
      dc.send(JSON.stringify({ type: "response.create" }))

      // Helpful connection logs
      pc.addEventListener("connectionstatechange", () => console.log("pc", pc.connectionState))
      pc.addEventListener("iceconnectionstatechange", () => console.log("ice", pc.iceConnectionState))

      setStatus("connected")
    } catch (err: any) {
      console.error(err)
      setErrors(err?.message || String(err))
      setStatus("idle")
    }
  }

  function stop() {
    setStatus("idle")
    try {
      conn.current.dc?.close()
      conn.current.pc?.close()
      conn.current.mic?.getTracks().forEach((t) => t.stop())
    } catch {}
  }

  useEffect(() => {
    // if (status === "idle") { setYou(""); setAgent(""); } // optional reset
  }, [status])

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Densight — AI Voice SDR</h1>

      <div className="flex gap-3 mb-4">
        <button onClick={start} disabled={status !== "idle"} className="px-4 py-2 rounded bg-black text-white">
          Start
        </button>
        <button onClick={stop} disabled={status !== "connected"} className="px-4 py-2 rounded border">
          Stop
        </button>
        <span className="px-3 py-2 rounded border text-sm">{status}</span>
      </div>

      {errors && <div className="mb-3 text-sm text-red-600 border border-red-300 rounded p-2">{errors}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="border rounded p-3 h-64 overflow-auto whitespace-pre-wrap text-sm">
          <h3 className="font-medium mb-2">You (transcript)</h3>
          {you || "Say something… your words appear here."}
        </section>
        <section className="border rounded p-3 h-64 overflow-auto whitespace-pre-wrap text-sm">
          <h3 className="font-medium mb-2">Agent</h3>
          {agent || "Agent replies will appear here."}
        </section>
      </div>
    </main>
  )
}
