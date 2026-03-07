import os
import base64
import asyncio

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from google import genai
from google.genai import types

# ─── Load Environment Variables ──────────────────────────────────────────────
load_dotenv()

# ─── App Setup ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="Arix Gemini Live Agent API",
    description="Backend for Arix AI Tutor — Real-time voice + vision via Gemini Live",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Gemini Client Setup ──────────────────────────────────────────────────────
# Use Vertex AI for everything (no Google AI Studio required)
PROJECT_ID     = os.getenv("GOOGLE_CLOUD_PROJECT", "arix-ai-489306")
LOCATION       = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

# Initialize Vertex AI client for both text chat and live API
text_client = None
live_client = None
MODEL = None

try:
    import vertexai
    vertexai.init(project=PROJECT_ID, location=LOCATION)

    # Use Vertex AI for both text chat and live API
    text_client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    live_client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    MODEL = "gemini-live-2.5-flash-native-audio"  # Model for Live API

    print(f"[INIT] ✅ Vertex AI ready for both text chat and Live API")
    print(f"[INIT] 📁 Using service account: {os.getenv('GOOGLE_APPLICATION_CREDENTIALS', 'arix-ai-489306-01869072469f.json')}")
    print(f"[INIT] 🚀 No Google AI Studio API key required!")

except Exception as e:
    print(f"[INIT] ❌ Vertex AI setup failed: {str(e)[:100]}...")
    print(f"[INIT] 💡 Make sure GOOGLE_APPLICATION_CREDENTIALS points to valid service account JSON")
    print(f"[INIT] 💡 Download from: https://console.cloud.google.com/iam-admin/serviceaccounts")

# ─── System Prompt ────────────────────────────────────────────────────────────
SYSTEM_PROMPT = (
    "You are Arix, a smart, friendly, and enthusiastic educational AI voice tutor. "
    "Always give short, clear and helpful answers. When the user speaks Sinhala, reply in Sinhala. "
    "If the user asks you to look at their screen or whiteboard, use the 'capture_screen' tool. "
    "You receive real-time audio from the user. Respond conversationally with voice."
)

# ─── Gemini Live Session Config ───────────────────────────────────────────────
def build_config() -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],  # gemini-2.0-flash-lite-001 only supports AUDIO in Live API
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Puck"
                )
            )
        ),
        system_instruction=types.Content(
            parts=[types.Part.from_text(text=SYSTEM_PROMPT)]
        ),
        tools=[
            types.Tool(
                function_declarations=[
                    types.FunctionDeclaration(
                        name="capture_screen",
                        description=(
                            "Captures the user's current screen so you can see "
                            "what they are looking at or working on."
                        ),
                    )
                ]
            )
        ],
    )


# ─── Root Health Check ────────────────────────────────────────────────────────
@app.get("/")
async def root():
    status = {
        "status": "ok",
        "text_chat": "available" if text_client else "unavailable",
        "live_api": "available" if live_client and MODEL else "unavailable",
        "provider": "Vertex AI (No Google AI Studio required)",
        "message": "Arix Backend Active with Vertex AI."
    }
    if MODEL:
        status["live_model"] = MODEL
    return status


# ─── WebSocket Live Session ───────────────────────────────────────────────────
@app.websocket("/ws/live")
async def live_voice_session(websocket: WebSocket):
    await websocket.accept()
    print("[WS] React Client Connected to Arix Live Engine!")

    # Check if Live API is available
    if not live_client or not MODEL:
        await websocket.send_json({
            "type": "error",
            "message": "Live API requires Vertex AI setup. Use text chat instead, or set up GCP credentials."
        })
        await websocket.close()
        return

    try:
        config = build_config()

        async with live_client.aio.live.connect(model=MODEL, config=config) as session:
            print(f"[GEMINI] Connected to Gemini Live [{MODEL}]")

            # ── Task 1: Receive responses from Gemini → Send to Frontend ──────
            async def receive_from_gemini():
                try:
                    async for response in session.receive():
                        # DEBUG: dump raw response object for troubleshooting
                        print("[GEMINI] raw response:", response)

                        # ── Handle audio / text parts ────────────────────────
                        if response.server_content:
                            sc = response.server_content

                            if sc.model_turn:
                                for part in sc.model_turn.parts:

                                    # AUDIO response from Gemini (24kHz PCM)
                                    if part.inline_data and part.inline_data.data:
                                        audio_b64 = base64.b64encode(
                                            part.inline_data.data
                                        ).decode("utf-8")
                                        print(f"[AUDIO] {len(part.inline_data.data)} bytes | {part.inline_data.mime_type}")
                                        await websocket.send_json({
                                            "type": "audio",
                                            "data": audio_b64,
                                            "mime_type": part.inline_data.mime_type or "audio/pcm",
                                        })
                                    # Text part (fallback)
                                    elif part.text:
                                        print(f"[TEXT] Gemini: {part.text[:80]}")

                            # Turn-based conversation: After Arix responds, signal ready for next input
                            if getattr(sc, 'turn_complete', False):
                                print("[ARIX] ✅ Turn complete.")
                                await websocket.send_json({
                                    "type": "turn_complete",
                                    "ready": True
                                })

                        # ── Handle Tool Calls (screen capture request) ────────
                        if response.tool_call:
                            for fn_call in response.tool_call.function_calls:
                                if fn_call.name == "capture_screen":
                                    print("[TOOL] Gemini requested screen capture!")

                                    # Ask frontend to trigger screen capture
                                    await websocket.send_json({
                                        "type": "capture_screen_request"
                                    })

                                    # Immediately send a tool response to unblock Gemini.
                                    # The actual image will arrive via send_realtime_input shortly.
                                    await session.send_tool_response(
                                        function_responses=[
                                            types.FunctionResponse(
                                                name="capture_screen",
                                                id=fn_call.id,
                                                response={"status": "capturing_started"},
                                            )
                                        ]
                                    )

                except WebSocketDisconnect:
                    print("[WS] Frontend disconnected (in receive_from_gemini).")
                except Exception as e:
                    print(f"[ERROR] receive_from_gemini: {e}")

            # ── Task 2: Receive data from Frontend → Stream to Gemini ─────────
            async def send_to_gemini():
                try:
                    while True:
                        msg = await websocket.receive_json()

                        if msg.get("type") != "realtime_input":
                            continue

                        # ── Audio chunk (16kHz PCM from browser) ─────────────
                        if "audio" in msg:
                            raw = base64.b64decode(msg["audio"])
                            await session.send_realtime_input(
                                audio=types.Blob(
                                    data=raw,
                                    mime_type="audio/pcm;rate=16000",
                                )
                            )

                        # ── Image (whiteboard or screen capture) ─────────────
                        if "image" in msg:
                            b64 = msg["image"]
                            # Strip data URL prefix if present
                            if "," in b64:
                                b64 = b64.split(",", 1)[1]
                            img_bytes = base64.b64decode(b64)
                            await session.send_realtime_input(
                                media=types.Blob(
                                    data=img_bytes,
                                    mime_type="image/jpeg",
                                )
                            )

                except WebSocketDisconnect:
                    print("[WS] Frontend disconnected (in send_to_gemini).")
                except Exception as e:
                    print(f"[ERROR] send_to_gemini: {e}")

            # Run both tasks concurrently (don't cancel both if one fails)
            await asyncio.gather(
                receive_from_gemini(),
                send_to_gemini(),
                return_exceptions=True,
            )

    except WebSocketDisconnect:
        print("[WS] Frontend disconnected before session started.")
    except Exception as e:
        print(f"[ERROR] live_voice_session fatal: {e}")
        import traceback
        traceback.print_exc()
        try:
            await websocket.close()
        except Exception:
            pass


# ─── Simple Text Chat Endpoint (Uses Vertex AI) ───────────────────────────────
@app.websocket("/ws/chat")
async def text_chat_session(websocket: WebSocket):
    """Simple text chat with Gemini via Vertex AI. No Google AI Studio API key needed."""
    await websocket.accept()
    print("[CHAT] Text chat client connected (using Vertex AI).")

    # Check if text chat is available
    if not text_client:
        await websocket.send_json({
            "type": "error",
            "message": "Text chat not available. Check Vertex AI setup in backend/.env"
        })
        await websocket.close()
        return

    # Build persistent chat session with history using Vertex AI
    chat = text_client.chats.create(
        model="gemini-2.0-flash-001",  # Use faster/cheaper Vertex AI model
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
        )
    )

    try:
        while True:
            msg = await websocket.receive_json()
            user_text = msg.get("text", "").strip()
            if not user_text:
                continue

            print(f"[CHAT] User: {user_text}")

            # Get Gemini response (synchronous in thread to avoid blocking)
            response = await asyncio.to_thread(chat.send_message, user_text)
            reply = response.text or ""

            print(f"[CHAT] Arix: {reply[:100]}")

            # Send full response + signal frontend to speak it
            await websocket.send_json({
                "type": "text_response",
                "data": reply,
            })

    except WebSocketDisconnect:
        print("[CHAT] Text chat client disconnected.")
    except Exception as e:
        print(f"[ERROR] text_chat_session: {e}")
        import traceback
        traceback.print_exc()


# ─── Entry Point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
