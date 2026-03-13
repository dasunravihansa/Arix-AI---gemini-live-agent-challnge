import os
import base64
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT", "arix-ai-489306")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

client = None
MODEL = "gemini-live-2.5-flash-native-audio"

try:
    import vertexai
    vertexai.init(project=PROJECT_ID, location=LOCATION)
    client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    print("[INIT] ok")
except Exception as e:
    print("[INIT] failed", e)

SYSTEM_PROMPT = (
    "You are Arix, a friendly AI tutor. "
    "Reply clearly and conversationally. "
    "If the user speaks Sinhala, reply in Sinhala."
)

def build_config():
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
            )
        ),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(disabled=True)
        ),
        system_instruction=types.Content(
            parts=[types.Part.from_text(text=SYSTEM_PROMPT)]
        ),
    )

@app.get("/")
async def root():
    return {"status": "ok", "model": MODEL}

@app.websocket("/ws/live")
async def live_ws(websocket: WebSocket):
    await websocket.accept()

    if not client:
        await websocket.send_json({"type": "error", "message": "Gemini client unavailable"})
        await websocket.close()
        return

    try:
        async with client.aio.live.connect(model=MODEL, config=build_config()) as session:
            print("[LIVE] connected")

            async def recv_gemini():
                try:
                    async for response in session.receive():
                        if response.server_content:
                            sc = response.server_content

                            if sc.model_turn:
                                for part in sc.model_turn.parts:
                                    if part.inline_data and part.inline_data.data:
                                        await websocket.send_json({
                                            "type": "audio",
                                            "data": base64.b64encode(part.inline_data.data).decode("utf-8")
                                        })
                                    elif part.text:
                                        await websocket.send_json({
                                            "type": "live_text",
                                            "data": part.text
                                        })

                            if getattr(sc, "turn_complete", False):
                                await websocket.send_json({"type": "turn_complete"})

                except Exception as e:
                    print("[recv_gemini error]", e)

            async def send_gemini():
                try:
                    while True:
                        msg = await websocket.receive_json()
                        msg_type = msg.get("type")

                        if msg_type == "activity_start":
                            print("[activity_start]")
                            await session.send_realtime_input(activity_start=types.ActivityStart())

                        elif msg_type == "activity_end":
                            print("[activity_end]")
                            await session.send_realtime_input(activity_end=types.ActivityEnd())

                        elif msg_type == "audio_input":
                            raw = base64.b64decode(msg["audio"])
                            await session.send_realtime_input(
                                audio=types.Blob(data=raw, mime_type="audio/pcm;rate=16000")
                            )
                except Exception as e:
                    print("[send_gemini error]", e)

            await asyncio.gather(recv_gemini(), send_gemini())

    except WebSocketDisconnect:
        print("[LIVE] websocket disconnected")
    except Exception as e:
        print("[LIVE] fatal", e)
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except:
            pass