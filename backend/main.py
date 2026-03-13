import os
import base64
import asyncio
from typing import List, Dict, Any
from datetime import datetime

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

app = FastAPI(
    title="Arix Gemini Live Agent API",
    description="Backend for Arix AI Tutor — Real-time voice + vision via Gemini Live",
    version="2.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Conversation Manager ─────────────────────────────────────────────────────
class ConversationManager:
    def __init__(self, max_history: int = 20):
        self.history: List[Dict[str, Any]] = []
        self.max_history = max_history
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S")

    def add_user_message(self, content: str, message_type: str = "text"):
        self.history.append({
            "role": "user", "type": message_type,
            "content": content, "timestamp": datetime.now().isoformat()
        })
        self._trim_history()

    def add_assistant_message(self, content: str, message_type: str = "text"):
        self.history.append({
            "role": "assistant", "type": message_type,
            "content": content, "timestamp": datetime.now().isoformat()
        })
        self._trim_history()

    def add_system_message(self, content: str):
        self.history.append({
            "role": "system", "type": "system",
            "content": content, "timestamp": datetime.now().isoformat()
        })
        self._trim_history()

    def _trim_history(self):
        if len(self.history) > self.max_history:
            self.history = self.history[-self.max_history:]

    def get_context_prompt(self) -> str:
        if len(self.history) < 2:
            return ""
        context = "\n\nRecent conversation history:\n"
        recent = [msg for msg in self.history[-10:] if msg["role"] != "system"]
        for msg in recent:
            role = "Student" if msg["role"] == "user" else "Arix"
            context += f"{role}: {msg['content']}\n"
        return context

    def get_formatted_history(self) -> List[Dict[str, str]]:
        formatted = []
        for msg in self.history:
            if msg["role"] in ("system", "user", "assistant"):
                formatted.append({"role": msg["role"], "content": msg["content"]})
        return formatted

    def clear(self):
        self.history = []

    def get_summary(self) -> str:
        if len(self.history) < 2:
            return "No conversation yet"
        user_msgs = sum(1 for m in self.history if m["role"] == "user")
        asst_msgs = sum(1 for m in self.history if m["role"] == "assistant")
        return f"Session {self.session_id}: {user_msgs} user msgs, {asst_msgs} assistant msgs"


# ─── Gemini Client Setup ──────────────────────────────────────────────────────
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT", "arix-ai-489306")
LOCATION   = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

text_client = None
live_client = None
MODEL = None
active_conversations: Dict[str, ConversationManager] = {}

try:
    import vertexai
    vertexai.init(project=PROJECT_ID, location=LOCATION)
    text_client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    live_client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    MODEL = "gemini-live-2.5-flash-native-audio"
    print(f"[INIT] ✅ Vertex AI ready | Model: {MODEL}")
except Exception as e:
    print(f"[INIT] ❌ Vertex AI setup failed: {str(e)[:100]}...")


# ─── System Prompt ────────────────────────────────────────────────────────────
BASE_SYSTEM_PROMPT = (
    "You are Arix, a smart, friendly, and enthusiastic educational AI voice tutor. "
    "Always give short, clear and helpful answers. When the user speaks Sinhala, reply in Sinhala. "
    "If the user asks you to look at their screen or whiteboard, use the 'capture_screen' tool. "
    "You receive real-time audio from the user. Respond conversationally with voice.\n\n"
    "IMPORTANT: Remember our previous conversation! When the user asks follow-up questions, "
    "refer to what we just discussed. Maintain context throughout the conversation."
)

def get_dynamic_system_prompt(conversation: ConversationManager = None) -> str:
    prompt = BASE_SYSTEM_PROMPT
    if conversation and len(conversation.history) > 1:
        prompt += conversation.get_context_prompt()
        last = conversation.history[-3:] if len(conversation.history) >= 3 else conversation.history
        if any(m["role"] == "user" for m in last) and any(m["role"] == "assistant" for m in last):
            prompt += "\n\nThis is a follow-up conversation. Connect your response to the previous exchange."
    return prompt


# ─── Keepalive — 25s interval (10s was too aggressive) ───────────────────────
async def send_keepalive(session):
    # Send silence every 8s to prevent Gemini idle timeout (which is ~30s)
    silence = b'\x00\x00' * 1600  # 100ms silence at 16kHz
    while True:
        await asyncio.sleep(8)
        try:
            await session.send_realtime_input(
                audio=types.Blob(data=silence, mime_type="audio/pcm;rate=16000")
            )
            print("[KEEPALIVE] ✅ Sent silent audio")
        except Exception as e:
            print(f"[KEEPALIVE] ❌ Error: {e}")
            break


# ─── Live Config ──────────────────────────────────────────────────────────────
def build_config(conversation: ConversationManager = None) -> types.LiveConnectConfig:
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
            parts=[types.Part.from_text(text=get_dynamic_system_prompt(conversation))]
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


# ─── Conversation Helper ──────────────────────────────────────────────────────
def get_conversation(session_id: str = None) -> ConversationManager:
    if not session_id:
        session_id = f"session_{datetime.now().timestamp()}"
    if session_id not in active_conversations:
        active_conversations[session_id] = ConversationManager()
        if len(active_conversations) > 100:
            oldest = sorted(active_conversations.keys())[0]
            del active_conversations[oldest]
    return active_conversations[session_id]


# ─── Health Check ─────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    return {
        "status": "ok",
        "version": "2.2.0",
        "text_chat": "available" if text_client else "unavailable",
        "live_api": "available" if live_client and MODEL else "unavailable",
        "live_model": MODEL or "not set",
        "provider": "Vertex AI",
        "active_sessions": len(active_conversations),
    }


# ─── WebSocket: Live Voice ────────────────────────────────────────────────────
@app.websocket("/ws/live")
async def live_voice_session(websocket: WebSocket):
    await websocket.accept()

    session_id = websocket.query_params.get("session_id", f"live_{datetime.now().timestamp()}")
    conversation = get_conversation(session_id)
    print(f"[SESSION] Started | ID: {session_id}")

    # Track messages
    message_counter = 0

    if not live_client or not MODEL:
        await websocket.send_json({"type": "error", "message": "Live API unavailable."})
        await websocket.close()
        return

    try:
        config = build_config(conversation)
        async with live_client.aio.live.connect(model=MODEL, config=config) as session:
            print(f"[GEMINI] Live session started [{MODEL}] | {session_id}")
            conversation.add_system_message("Live session started")

            async def receive_from_gemini():
                nonlocal message_counter
                try:
                    async for response in session.receive():
                        if response.server_content:
                            sc = response.server_content
                            if sc.model_turn:
                                for part in sc.model_turn.parts:
                                    if part.inline_data and part.inline_data.data:
                                        audio_b64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                                        print(f"[AUDIO] {len(part.inline_data.data)} bytes")
                                        await websocket.send_json({
                                            "type": "audio",
                                            "data": audio_b64,
                                            "mime_type": part.inline_data.mime_type or "audio/pcm",
                                        })
                                    elif part.text:
                                        message_counter += 1
                                        print(f"[SESSION:{session_id}] Message #{message_counter}: {part.text[:80]}")
                                        conversation.add_assistant_message(part.text)
                                        await websocket.send_json({"type": "live_text", "data": part.text})

                            if getattr(sc, 'turn_complete', False):
                                print(f"[ARIX] ✅ Turn complete | {session_id}")
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
                    print(f"[WS] Disconnected in receive_from_gemini | {session_id}")
                except Exception as e:
                    print(f"[ERROR] receive_from_gemini: {e}")

            async def send_to_gemini():
                keepalive_task = asyncio.create_task(send_keepalive(session))
                try:
                    while True:
                        msg = await websocket.receive_json()

                        if msg.get("type") == "activity_start":
                            print(f"[VAD] ✅ activity_start received → sending to Gemini | {session_id}")
                            await session.send_realtime_input(activity_start=types.ActivityStart())
                            continue
                        if msg.get("type") == "activity_end":
                            print(f"[VAD] ✅ activity_end received → sending to Gemini | {session_id}")
                            await session.send_realtime_input(activity_end=types.ActivityEnd())
                            continue
                        if msg.get("type") != "realtime_input":
                            continue

                        if "audio" in msg:
                            raw = base64.b64decode(msg["audio"])
                            await session.send_realtime_input(
                                audio=types.Blob(data=raw, mime_type="audio/pcm;rate=16000")
                            )
                        if "image" in msg:
                            b64 = msg["image"]
                            if "," in b64:
                                b64 = b64.split(",", 1)[1]
                            img_bytes = base64.b64decode(b64)
                            await session.send_realtime_input(
                                media=types.Blob(data=img_bytes, mime_type="image/jpeg")
                            )
                            conversation.add_user_message("[Sent whiteboard image]", "image")
                        if "text" in msg:
                            # Context injection into live session
                            text_ctx = msg["text"]
                            print(f"[TEXT IN] Injecting text/context to Gemini: {text_ctx[:80]}...")
                            try:
                                await session.send(input=text_ctx)
                                conversation.add_user_message(text_ctx, "text")
                            except Exception as e:
                                print(f"[ERROR] sending text context: {e}")

                except WebSocketDisconnect:
                    print(f"[WS] Disconnected in send_to_gemini | {session_id}")
                except Exception as e:
                    print(f"[ERROR] send_to_gemini: {e}")
                finally:
                    keepalive_task.cancel()

            await asyncio.gather(receive_from_gemini(), send_to_gemini(), return_exceptions=True)

    except WebSocketDisconnect:
        print(f"[WS] Disconnected before session started | {session_id}")
    except Exception as e:
        print(f"[ERROR] live_voice_session fatal: {e}")
        import traceback
        traceback.print_exc()
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        print(f"[WS] Session ended | {conversation.get_summary()}")


# ─── WebSocket: Text Chat (FIX: /ws/chat — was 403 because frontend used wrong path) ───
@app.websocket("/ws/chat")
async def text_chat_session(websocket: WebSocket):
    await websocket.accept()

    session_id = websocket.query_params.get("session_id", f"chat_{datetime.now().timestamp()}")
    conversation = get_conversation(session_id)
    print(f"[CHAT] Connected | Session: {session_id}")

    if not text_client:
        await websocket.send_json({"type": "error", "message": "Text chat unavailable."})
        await websocket.close()
        return

    conversation.add_system_message("Text chat session started")

    try:
        while True:
            msg = await websocket.receive_json()
            user_text = msg.get("text", "").strip()
            if not user_text:
                continue

            print(f"[CHAT] User: {user_text}")
            conversation.add_user_message(user_text)

            # Build chat with full conversation history for context
            chat = text_client.chats.create(
                model="gemini-2.0-flash-001",
                config=types.GenerateContentConfig(
                    system_instruction=get_dynamic_system_prompt(conversation),
                )
            )

            # Replay previous turns so Gemini has full context
            history = conversation.get_formatted_history()
            for hist_msg in history[:-1]:  # skip last (current user msg)
                if hist_msg["role"] == "user":
                    await asyncio.to_thread(chat.send_message, hist_msg["content"])

            # Send current message
            response = await asyncio.to_thread(chat.send_message, user_text)
            reply = response.text or ""
            print(f"[CHAT] Arix: {reply[:100]}")

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
    finally:
        print(f"[CHAT] Session ended | {conversation.get_summary()}")


# ─── REST: Conversation History ───────────────────────────────────────────────
@app.get("/conversation/{session_id}")
async def get_conversation_history(session_id: str):
    if session_id in active_conversations:
        conv = active_conversations[session_id]
        return {"session_id": session_id, "history": conv.history, "summary": conv.get_summary()}
    return {"error": "Session not found"}

@app.delete("/conversation/{session_id}")
async def clear_conversation(session_id: str):
    if session_id in active_conversations:
        active_conversations[session_id].clear()
        return {"status": "cleared", "session_id": session_id}
    return {"error": "Session not found"}

@app.get("/sessions")
async def list_sessions():
    return {
        "active_sessions": len(active_conversations),
        "sessions": [
            {"session_id": sid, "summary": conv.get_summary(), "message_count": len(conv.history)}
            for sid, conv in list(active_conversations.items())[-20:]
        ]
    }


# ─── Entry Point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)