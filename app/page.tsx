"use client"
import { useEffect, useRef, useState } from "react"
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react"

type Conn = {
  pc: RTCPeerConnection | null
  dc: RTCDataChannel | null
  mic: MediaStream | null
}

export default function Home() {
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">("idle")
  const [you, setYou] = useState("") // Your transcript (STT)
  const [agent, setAgent] = useState("") // Agent transcript
  const [errors, setErrors] = useState<string | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const conn = useRef<Conn>({ pc: null, dc: null, mic: null })

  const append = (setter: (v: string) => void, chunk: string) => setter((prev) => (prev ? prev + chunk : chunk))

  async function start() {
    try {
      setErrors(null)
      setStatus("connecting")

      const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? "https://<your-render-url>"
      const sessionRes = await fetch(`${BASE}/session`, { method: "POST" })
      const session = await sessionRes.json()
      const clientSecret = session?.client_secret?.value
      if (!clientSecret) throw new Error("No client_secret returned from /session")

      // 2) Prepare WebRTC
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

      // 3) Data channel for events (create BEFORE offer)
      const dc = pc.createDataChannel("oai-events")
      conn.current.dc = dc

      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)

          // ——— USER STT (your speech) ———
          if (msg.type === "input_audio_transcription.delta" || msg.type === "transcript.delta") {
            append(setYou, msg.delta ?? "")
            return
          }
          if (msg.type === "input_audio_transcription.completed" || msg.type === "transcript.completed") {
            append(setYou, "\n") // new line after your turn
            return
          }

          // ——— AGENT TEXT (model reply) ———
          if (msg.type === "response.output_text.delta") {
            append(setAgent, msg.delta ?? "")
            return
          }
          if (msg.type === "response.output_text.done") {
            append(setAgent, "\n") // new line after agent turn
            return
          }

          // ——— TOOL CALL (logLead) ———
          if (msg.type === "response.function_call" && msg.name === "logLead") {
            fetch(`${BASE}/tools/logLead`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(msg.arguments || {}),
            }).catch(() => {})
            return
          }

          // Useful for debugging new/unknown event names
          // console.log("EV", msg);
        } catch {
          // Non-JSON pings can be ignored
        }
      }

      // 4) Mic capture
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
      conn.current.mic = mic
      mic.getTracks().forEach((t) => pc.addTrack(t, mic))

      // 5) Offer → SDP to OpenAI Realtime with ephemeral secret → set answer
      const offer = await pc.createOffer({ offerToReceiveAudio: true })
      await pc.setLocalDescription(offer)

      const sdpResp = await fetch("https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`, // IMPORTANT: ephemeral token, not your real key
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      })

      if (!sdpResp.ok) {
        const t = await sdpResp.text()
        throw new Error(`SDP error: ${sdpResp.status} ${t.slice(0, 200)}`)
      }

      const answerSDP = await sdpResp.text()
      await pc.setRemoteDescription({ type: "answer", sdp: answerSDP })

      dc.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions: "Please greet the user and introduce yourself as Densight's SDR. Keep it short and friendly.",
            modalities: ["audio"], // ensure spoken reply
          },
        }),
      )

      // Optional: also append a tiny user input to wake up NLP pipelines
      dc.send(JSON.stringify({ type: "input_text.append", text: "Hi there!" }))
      dc.send(JSON.stringify({ type: "response.create" }))

      pc.addEventListener("iceconnectionstatechange", () => console.log("ice", pc.iceConnectionState))
      pc.addEventListener("connectionstatechange", () => console.log("pc", pc.connectionState))

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
    if (status === "idle") {
      // setYou(""); setAgent("");
    }
  }, [status])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <main className="mx-auto max-w-4xl p-6">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">Densight</h1>
          <p className="text-lg text-slate-600">AI Voice Sales Development Representative</p>
          <div className="w-24 h-1 bg-blue-600 mx-auto mt-4 rounded-full"></div>
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-8 mb-6">
          <div className="flex items-center justify-center gap-4 mb-6">
            <button
              onClick={start}
              disabled={status !== "idle"}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-medium transition-colors"
            >
              <Phone className="w-5 h-5" />
              Start Call
            </button>
            <button
              onClick={stop}
              disabled={status !== "connected"}
              className="flex items-center gap-2 px-6 py-3 rounded-xl bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white font-medium transition-colors"
            >
              <PhoneOff className="w-5 h-5" />
              End Call
            </button>
          </div>

          <div className="flex items-center justify-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                status === "idle"
                  ? "bg-gray-400"
                  : status === "connecting"
                    ? "bg-yellow-500 animate-pulse"
                    : "bg-green-500"
              }`}
            ></div>
            <span className="text-sm font-medium text-slate-700 capitalize">
              {status === "idle" ? "Ready to connect" : status === "connecting" ? "Connecting..." : "Connected"}
            </span>
          </div>
        </div>

        {errors && (
          <div className="mb-6 text-sm text-red-600 border border-red-300 rounded-xl p-4 bg-red-50">
            <strong>Error:</strong> {errors}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl shadow-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex items-center gap-2">
                {status === "connected" ? (
                  <Mic className="w-5 h-5 text-green-600" />
                ) : (
                  <MicOff className="w-5 h-5 text-gray-400" />
                )}
                <h2 className="text-lg font-semibold text-slate-900">You (transcript)</h2>
              </div>
            </div>

            <div className="bg-slate-50 rounded-xl p-4 h-64 overflow-auto">
              <div className="whitespace-pre-wrap text-slate-700 leading-relaxed text-sm">
                {you || (
                  <div className="text-slate-400 italic text-center mt-20">Say something… your words appear here.</div>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-semibold text-slate-900">Agent</h2>
            </div>

            <div className="bg-slate-50 rounded-xl p-4 h-64 overflow-auto">
              <div className="whitespace-pre-wrap text-slate-700 leading-relaxed text-sm">
                {agent || (
                  <div className="text-slate-400 italic text-center mt-20">Agent replies will appear here.</div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="text-center mt-8 text-sm text-slate-500">
          <p>Click "Start Call" to begin your AI-powered sales conversation</p>
        </div>
      </main>
    </div>
  )
}
