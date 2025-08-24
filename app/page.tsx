"use client"
import { useRef, useState } from "react"
import { Mic, MicOff, Phone, PhoneOff } from "lucide-react"

export default function Home() {
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">("idle")
  const [transcript, setTranscript] = useState("")
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  async function start() {
    try {
      setStatus("connecting")

      // 1) Ask backend (Render) to mint short-lived Realtime session
      const sessionRes = await fetch("https://<your-render-url>/session", { method: "POST" })
      const session = await sessionRes.json()
      const clientSecret = session?.client_secret?.value
      if (!clientSecret) throw new Error("No client_secret from backend")

      // 2) WebRTC PeerConnection + remote audio
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] })
      pcRef.current = pc

      if (!audioRef.current) {
        const el = document.createElement("audio")
        el.autoplay = true
        document.body.appendChild(el)
        audioRef.current = el
      }
      pc.ontrack = (e) => {
        if (audioRef.current) audioRef.current.srcObject = e.streams[0]
      }

      // 3) Data channel for events
      const dc = pc.createDataChannel("oai-events")
      dcRef.current = dc
      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === "response.output_text.delta") {
            setTranscript((p) => p + msg.delta)
          } else if (msg.type === "response.output_text.done") {
            setTranscript((p) => p + "\n")
          } else if (msg.type === "response.function_call" && msg.name === "logLead") {
            fetch("https://<your-render-url>/tools/logLead", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(msg.arguments || {}),
            })
          }
        } catch {
          /* ignore non-JSON pings */
        }
      }

      // 4) Mic capture
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      stream.getTracks().forEach((t) => pc.addTrack(t, stream))

      // 5) SDP offer → POST to OpenAI Realtime with ephemeral secret → set remote answer
      const offer = await pc.createOffer({ offerToReceiveAudio: true })
      await pc.setLocalDescription(offer)

      const sdpResp = await fetch("https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      })

      const answerSDP = await sdpResp.text()
      await pc.setRemoteDescription({ type: "answer", sdp: answerSDP })

      setStatus("connected")
    } catch (err) {
      console.error(err)
      alert("Failed to start session. Check console & backend logs.")
      setStatus("idle")
    }
  }

  function stop() {
    setStatus("idle")
    try {
      dcRef.current?.close()
      pcRef.current?.close()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    } catch {}
  }

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

        <div className="bg-white rounded-2xl shadow-lg p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-2">
              {status === "connected" ? (
                <Mic className="w-5 h-5 text-green-600" />
              ) : (
                <MicOff className="w-5 h-5 text-gray-400" />
              )}
              <h2 className="text-lg font-semibold text-slate-900">Live Transcript</h2>
            </div>
          </div>

          <div className="bg-slate-50 rounded-xl p-4 h-80 overflow-auto">
            <div className="whitespace-pre-wrap text-slate-700 leading-relaxed">
              {transcript || (
                <div className="text-slate-400 italic text-center mt-20">
                  Transcript will appear here when you start a call...
                </div>
              )}
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
