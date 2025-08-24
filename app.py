import os, json
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")  # set to your Vercel URL after deploy

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": ALLOWED_ORIGIN}})

@app.post("/session")
def create_session():
    """Mints a short-lived Realtime session. Keep your real API key server-side."""
    if not OPENAI_API_KEY:
        return jsonify({"error": "OPENAI_API_KEY missing"}), 500

    url = "https://api.openai.com/v1/realtime/sessions"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json"
    }
    body = {
        "model": "gpt-4o-realtime-preview",  # check docs for latest realtime model name
        "voice": "verse",
        "modalities": ["text","audio"],
        "instructions": (
            "You are Densight's SDR. Be concise, friendly and natural. "
            "Qualify: name, company, role, pains, timeline, budget. "
            "Handle objections (busy, 'send info', 'already using X'). "
            "If qualified, propose a 15-min intro and confirm email."
        ),
        "tools": [
            {
                "type": "function",
                "name": "logLead",
                "description": "Log a lead to CRM/backoffice.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "company": {"type": "string"},
                        "email": {"type": "string"},
                        "phone": {"type": "string"},
                        "interest": {"type": "string"},
                        "outcome": {
                            "type": "string",
                            "enum": ["meeting_set","callback","not_interested","info_requested"]
                        }
                    },
                    "required": ["name","company","outcome"]
                }
            }
        ]
    }
    r = requests.post(url, headers=headers, json=body, timeout=20)
    if not r.ok:
        return jsonify({"error": "session_create_failed", "detail": r.text}), 500
    return jsonify(r.json())

@app.post("/tools/logLead")
def log_lead():
    """Called when the model emits a function call named logLead."""
    data = request.json or {}
    os.makedirs("data", exist_ok=True)
    with open("data/leads.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({**data, "ts": os.getenv("RENDER_DATETIME", "")}) + "\n")
    return jsonify({"ok": True})

@app.get("/health")
def health():
    return "ok", 200

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port)
