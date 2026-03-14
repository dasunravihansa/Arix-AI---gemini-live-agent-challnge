import os
import base64
import asyncio
import contextlib
from typing import List, Dict, Any
from datetime import datetime, timedelta

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

app = FastAPI(
    title="Arix Gemini Live Agent API",
    description="Backend for Arix AI Tutor — Real-time voice + vision via Gemini Live",
    version="2.3.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://arix-ai.vercel.app",
        "https://arix-frontend.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Conversation Manager ────────────────────────────────────────────────────
class ConversationManager:
    def __init__(self, max_history: int = 20):
        self.history: List[Dict[str, Any]] = []
        self.max_history = max_history
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.last_activity = datetime.now()

    def _touch(self):
        self.last_activity = datetime.now()

    def add_user_message(self, content: str, message_type: str = "text"):
        self.history.append({
            "role": "user",
            "type": message_type,
            "content": content,
            "timestamp": datetime.now().isoformat()
        })
        self._touch()
        self._trim_history()

    def add_assistant_message(self, content: str, message_type: str = "text"):
        self.history.append({
            "role": "assistant",
            "type": message_type,
            "content": content,
            "timestamp": datetime.now().isoformat()
        })
        self._touch()
        self._trim_history()

    def add_system_message(self, content: str):
        self.history.append({
            "role": "system",
            "type": "system",
            "content": content,
            "timestamp": datetime.now().isoformat()
        })
        self._touch()
        self._trim_history()

    def _trim_history(self):
        if len(self.history) > self.max_history:
            self.history = self.history[-self.max_history:]

    def get_context_prompt(self) -> str:
        recent = [m for m in self.history[-10:] if m["role"] != "system"]
        if len(recent) < 2:
            return ""

        lines = []
        for msg in recent:
            role = "Student" if msg["role"] == "user" else "Arix"
            lines.append(f"{role}: {msg['content']}")
        return "\n".join(lines)

    def clear(self):
        self.history = []
        self._touch()

    def get_summary(self) -> str:
        user_msgs = sum(1 for m in self.history if m["role"] == "user")
        asst_msgs = sum(1 for m in self.history if m["role"] == "assistant")
        return f"Session {self.session_id}: {user_msgs} user msgs, {asst_msgs} assistant msgs"


# ─── Live Session Manager ────────────────────────────────────────────────────
class LiveSessionManager:
    def __init__(self, session_id: str, conversation: ConversationManager):
        self.session_id = session_id
        self.conversation = conversation
        self.last_context_sent = ""
        self.message_count = 0
        self.last_activity = datetime.now()

    def should_send_context(self) -> bool:
        if self.message_count > 0 and self.message_count % 4 == 0:
            return True
        if (datetime.now() - self.last_activity).seconds > 45:
            return True
        return False

    def get_context_for_gemini(self) -> str:
        recent = [msg for msg in self.conversation.history[-8:] if msg["role"] != "system"]
        if len(recent) < 2:
            return ""

        context = "\n[CONVERSATION HISTORY]\n"
        for msg in recent:
          role = "User" if msg["role"] == "user" else "Arix"
          context += f"{role}: {msg['content']}\n"
        context += "[/CONVERSATION HISTORY]\nContinue naturally.\n"
        return context

    def add_user_message(self, content: str, msg_type: str = "audio"):
        self.conversation.add_user_message(content, msg_type)
        self.message_count += 1
        self.last_activity = datetime.now()

    def add_assistant_message(self, content: str):
        self.conversation.add_assistant_message(content)
        self.message_count += 1
        self.last_activity = datetime.now()


# ─── Gemini setup ────────────────────────────────────────────────────────────
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT", "arix-ai-489306")
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

text_client = None
live_client = None
MODEL = None

active_conversations: Dict[str, ConversationManager] = {}
active_live_sessions: Dict[str, LiveSessionManager] = {}

try:
    import vertexai
    vertexai.init(project=PROJECT_ID, location=LOCATION)
    text_client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    live_client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    MODEL = "gemini-live-2.5-flash-native-audio"
    print(f"[INIT] ✅ Vertex AI ready | Model: {MODEL}")
except Exception as e:
    print(f"[INIT] ❌ Vertex AI setup failed: {str(e)[:150]}...")


# ─── Prompt ──────────────────────────────────────────────────────────────────
BASE_SYSTEM_PROMPT = (
    "You are Arix, a smart, friendly, and enthusiastic educational AI voice tutor. "
    "Always give short, clear, helpful answers. When the user speaks Sinhala, reply in Sinhala. "
    "If the user asks you to look at their screen or whiteboard, use the 'capture_screen' tool. "
    "You receive real-time audio from the user. Respond conversationally with voice. "
    "Maintain conversation context naturally."
)

def get_dynamic_system_prompt() -> str:
    return BASE_SYSTEM_PROMPT


# ─── Keepalive ───────────────────────────────────────────────────────────────
async def send_keepalive(session):
    silence = b"\x00\x00" * 1600
    while True:
        await asyncio.sleep(15)
        try:
            await session.send_realtime_input(
                audio=types.Blob(data=silence, mime_type="audio/pcm;rate=16000")
            )
            print("[KEEPALIVE] ✅ sent")
        except Exception as e:
            print(f"[KEEPALIVE] stopped: {e}")
            break


# ─── Config ──────────────────────────────────────────────────────────────────
def build_config() -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
            )
        ),
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                silence_threshold_seconds=0.8,
                speech_threshold_seconds=0.2
            )
        ),
        system_instruction=types.Content(
            parts=[types.Part.from_text(text=get_dynamic_system_prompt())]
        ),
        tools=[
            types.Tool(
                function_declarations=[
                    types.FunctionDeclaration(
                        name="capture_screen",
                        description="Captures the user's current screen so you can see what they are looking at or working on.",
                    )
                ]
            )
        ],
    )


# ─── Helpers ─────────────────────────────────────────────────────────────────
def get_conversation(session_id: str | None = None) -> ConversationManager:
    if not session_id:
        session_id = f"session_{datetime.now().timestamp()}"

    if session_id not in active_conversations:
        active_conversations[session_id] = ConversationManager()

    return active_conversations[session_id]


def cleanup_old_sessions():
    now = datetime.now()

    old_conv = [
        sid for sid, conv in active_conversations.items()
        if now - conv.last_activity > timedelta(hours=6)
    ]
    for sid in old_conv:
        del active_conversations[sid]

    old_live = [
        sid for sid, live in active_live_sessions.items()
        if now - live.last_activity > timedelta(hours=2)
    ]
    for sid in old_live:
        del active_live_sessions[sid]


# ─── Health ──────────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    cleanup_old_sessions()
    return {
        "status": "ok",
        "version": "2.3.0",
        "text_chat": "available" if text_client else "unavailable",
        "live_api": "available" if live_client and MODEL else "unavailable",
        "live_model": MODEL or "not set",
        "provider": "Vertex AI",
        "active_sessions": len(active_conversations),
    }


# ─── Live Voice WS ───────────────────────────────────────────────────────────
@app.websocket("/ws/live")
async def live_voice_session(websocket: WebSocket):
    await websocket.accept()

    session_id = websocket.query_params.get("session_id", f"live_{datetime.now().timestamp()}")
    conversation = get_conversation(session_id)

    if session_id not in active_live_sessions:
        active_live_sessions[session_id] = LiveSessionManager(session_id, conversation)

    session_manager = active_live_sessions[session_id]
    session_manager.last_activity = datetime.now()

    print(f"[SESSION] Live started | {session_id}")

    if not live_client or not MODEL:
        await websocket.send_json({"type": "error", "message": "Live API unavailable."})
        await websocket.close()
        return

    try:
        config = build_config()
        async with live_client.aio.live.connect(model=MODEL, config=config) as session:
            print(f"[GEMINI] Live connected | {session_id}")

            session_manager.conversation.add_system_message("Live session started")

            initial_context = session_manager.get_context_for_gemini()
            if initial_context:
                await session.send(input=initial_context)
                session_manager.last_context_sent = initial_context

            async def receive_from_gemini():
                current_text_parts: List[str] = []
                try:
                    async for response in session.receive():
                        if response.server_content:
                            sc = response.server_content

                            if sc.model_turn:
                                for part in sc.model_turn.parts:
                                    if part.inline_data and part.inline_data.data:
                                        audio_b64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                                        await websocket.send_json({
                                            "type": "audio",
                                            "data": audio_b64,
                                            "mime_type": part.inline_data.mime_type or "audio/pcm",
                                        })
                                    elif part.text:
                                        current_text_parts.append(part.text)
                                        await websocket.send_json({
                                            "type": "live_text",
                                            "data": part.text
                                        })

                            if getattr(sc, "turn_complete", False):
                                full_text = "".join(current_text_parts).strip()
                                if full_text:
                                    session_manager.add_assistant_message(full_text)
                                    print(f"[ARIX] {full_text[:120]}")
                                current_text_parts = []
                                await websocket.send_json({"type": "turn_complete", "ready": True})

                        if response.tool_call:
                            for fn_call in response.tool_call.function_calls:
                                if fn_call.name == "capture_screen":
                                    await websocket.send_json({"type": "capture_screen_request"})
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
                    print(f"[WS] receive_from_gemini disconnected | {session_id}")
                except Exception as e:
                    print(f"[ERROR] receive_from_gemini: {e}")

            async def send_to_gemini():
                keepalive_task = asyncio.create_task(send_keepalive(session))

                try:
                    while True:
                        msg = await websocket.receive_json()
                        msg_type = msg.get("type")

                        session_manager.last_activity = datetime.now()
                        session_manager.conversation.last_activity = datetime.now()

                        if msg_type == "activity_start":
                            await session.send_realtime_input(activity_start=types.ActivityStart())
                            continue

                        if msg_type == "activity_end":
                            await session.send_realtime_input(activity_end=types.ActivityEnd())
                            continue

                        if msg_type == "audio_input" and "audio" in msg:
                            raw = base64.b64decode(msg["audio"])
                            await session.send_realtime_input(
                                audio=types.Blob(data=raw, mime_type="audio/pcm;rate=16000")
                            )
                            continue

                        if msg_type == "image_input" and "image" in msg:
                            b64 = msg["image"]
                            if "," in b64:
                                b64 = b64.split(",", 1)[1]
                            img_bytes = base64.b64decode(b64)
                            await session.send_realtime_input(
                                media=types.Blob(data=img_bytes, mime_type="image/jpeg")
                            )
                            session_manager.add_user_message("[Sent whiteboard or screen image]", "image")
                            continue

                        if msg_type == "context_sync" and "text" in msg:
                            text_ctx = msg["text"][:12000]
                            await session.send(input=text_ctx)
                            continue

                        if msg_type == "text_input" and "text" in msg:
                            user_text = msg["text"][:4000].strip()
                            if not user_text:
                                continue
                            await session.send(input=user_text)
                            session_manager.add_user_message(user_text, "text")
                            continue

                        if session_manager.should_send_context():
                            context = session_manager.get_context_for_gemini()
                            if context and context != session_manager.last_context_sent:
                                await session.send(input=context)
                                session_manager.last_context_sent = context

                except WebSocketDisconnect:
                    print(f"[WS] send_to_gemini disconnected | {session_id}")
                except Exception as e:
                    print(f"[ERROR] send_to_gemini: {e}")
                finally:
                    keepalive_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await keepalive_task

            await asyncio.gather(
                receive_from_gemini(),
                send_to_gemini(),
                return_exceptions=True
            )

    except WebSocketDisconnect:
        print(f"[WS] disconnected before complete start | {session_id}")
    except Exception as e:
        print(f"[ERROR] live_voice_session fatal: {e}")
        import traceback
        traceback.print_exc()
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        session_manager.last_activity = datetime.now()
        cleanup_old_sessions()
        print(f"[WS] Live ended | {conversation.get_summary()}")


# ─── Text Chat WS ────────────────────────────────────────────────────────────
@app.websocket("/ws/chat")
async def text_chat_session(websocket: WebSocket):
    await websocket.accept()

    session_id = websocket.query_params.get("session_id", f"chat_{datetime.now().timestamp()}")
    conversation = get_conversation(session_id)
    print(f"[CHAT] Connected | {session_id}")

    if not text_client:
        await websocket.send_json({"type": "error", "message": "Text chat unavailable."})
        await websocket.close()
        return

    conversation.add_system_message("Text chat session started")

    try:
        while True:
            msg = await websocket.receive_json()
            user_text = msg.get("text", "").strip()[:4000]
            if not user_text:
                continue

            prior_context = conversation.get_context_prompt()
            conversation.add_user_message(user_text)

            full_prompt = (
                f"Previous conversation:\n{prior_context}\n\n"
                f"Current user message:\n{user_text}"
            ).strip()

            response = await asyncio.to_thread(
                text_client.models.generate_content,
                model="gemini-2.0-flash-001",
                contents=full_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=BASE_SYSTEM_PROMPT
                ),
            )

            reply = getattr(response, "text", "") or ""
            conversation.add_assistant_message(reply)

            await websocket.send_json({
                "type": "text_response",
                "data": reply,
                "session_id": session_id,
            })

    except WebSocketDisconnect:
        print(f"[CHAT] Disconnected | {session_id}")
    except Exception as e:
        print(f"[ERROR] text_chat_session: {e}")
        import traceback
        traceback.print_exc()
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        cleanup_old_sessions()
        print(f"[CHAT] Session ended | {conversation.get_summary()}")


# ─── REST ────────────────────────────────────────────────────────────────────
@app.get("/conversation/{session_id}")
async def get_conversation_history(session_id: str):
    if session_id in active_conversations:
        conv = active_conversations[session_id]
        return {
            "session_id": session_id,
            "history": conv.history,
            "summary": conv.get_summary()
        }
    return {"error": "Session not found"}

@app.delete("/conversation/{session_id}")
async def clear_conversation(session_id: str):
    if session_id in active_conversations:
        active_conversations[session_id].clear()
        return {"status": "cleared", "session_id": session_id}
    return {"error": "Session not found"}

@app.get("/sessions")
async def list_sessions():
    cleanup_old_sessions()
    return {
        "active_sessions": len(active_conversations),
        "sessions": [
            {
                "session_id": sid,
                "summary": conv.get_summary(),
                "message_count": len(conv.history),
            }
            for sid, conv in list(active_conversations.items())[-20:]
        ]
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)