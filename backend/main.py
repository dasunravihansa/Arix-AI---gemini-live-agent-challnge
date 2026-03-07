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

# ─── Load Environment Variables ──────────────────────────────────────────────
load_dotenv()

# ─── App Setup ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="Arix Gemini Live Agent API",
    description="Backend for Arix AI Tutor — Real-time voice + vision via Gemini Live",
    version="2.1.0",  # Updated version
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Conversation Manager ────────────────────────────────────────────────────
class ConversationManager:
    """Manages conversation history for both live and chat sessions"""
    
    def __init__(self, max_history: int = 20):
        self.history: List[Dict[str, Any]] = []
        self.max_history = max_history
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        
    def add_user_message(self, content: str, message_type: str = "text"):
        """Add user message to history"""
        self.history.append({
            "role": "user",
            "type": message_type,
            "content": content,
            "timestamp": datetime.now().isoformat()
        })
        self._trim_history()
        
    def add_assistant_message(self, content: str, message_type: str = "text"):
        """Add assistant message to history"""
        self.history.append({
            "role": "assistant",
            "type": message_type,
            "content": content,
            "timestamp": datetime.now().isoformat()
        })
        self._trim_history()
    
    def add_system_message(self, content: str):
        """Add system message to history"""
        self.history.append({
            "role": "system",
            "type": "system",
            "content": content,
            "timestamp": datetime.now().isoformat()
        })
        self._trim_history()
    
    def _trim_history(self):
        """Keep history within max_history limit"""
        if len(self.history) > self.max_history:
            self.history = self.history[-self.max_history:]
    
    def get_context_prompt(self) -> str:
        """Generate context prompt from recent history"""
        if len(self.history) < 2:  # Only system message or empty
            return ""
        
        context = "\n\nRecent conversation history:\n"
        # Get last 5 exchanges (excluding system messages)
        recent = [msg for msg in self.history[-10:] if msg["role"] != "system"]
        
        for msg in recent:
            role = "Student" if msg["role"] == "user" else "Arix"
            context += f"{role}: {msg['content']}\n"
        
        return context
    
    def get_formatted_history(self) -> List[Dict[str, str]]:
        """Get history formatted for Gemini API"""
        formatted = []
        for msg in self.history:
            if msg["role"] == "system":
                formatted.append({
                    "role": "system",
                    "content": msg["content"]
                })
            elif msg["role"] == "user":
                formatted.append({
                    "role": "user",
                    "content": msg["content"]
                })
            else:  # assistant
                formatted.append({
                    "role": "assistant",
                    "content": msg["content"]
                })
        return formatted
    
    def clear(self):
        """Clear conversation history"""
        self.history = []
    
    def get_summary(self) -> str:
        """Get a brief summary of the conversation"""
        if len(self.history) < 2:
            return "No conversation yet"
        
        user_msgs = sum(1 for msg in self.history if msg["role"] == "user")
        assistant_msgs = sum(1 for msg in self.history if msg["role"] == "assistant")
        return f"Session {self.session_id}: {user_msgs} user messages, {assistant_msgs} assistant messages"

# ─── Gemini Client Setup ──────────────────────────────────────────────────────
# Use Vertex AI for everything (no Google AI Studio required)
PROJECT_ID     = os.getenv("GOOGLE_CLOUD_PROJECT", "arix-ai-489306")
LOCATION       = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

# Initialize Vertex AI client for both text chat and live API
text_client = None
live_client = None
MODEL = None

# Store active conversations
active_conversations: Dict[str, ConversationManager] = {}

try:
    import vertexai
    vertexai.init(project=PROJECT_ID, location=LOCATION)

    # Use Vertex AI for both text chat and live API
    text_client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    live_client = genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)
    # Fix: Use correct model name for Live API
    MODEL = "gemini-2.0-flash-exp"  # Updated model name

    print(f"[INIT] ✅ Vertex AI ready for both text chat and Live API")
    print(f"[INIT] 📁 Using service account: {os.getenv('GOOGLE_APPLICATION_CREDENTIALS', 'arix-ai-489306-01869072469f.json')}")
    print(f"[INIT] 🚀 No Google AI Studio API key required!")

except Exception as e:
    print(f"[INIT] ❌ Vertex AI setup failed: {str(e)[:100]}...")
    print(f"[INIT] 💡 Make sure GOOGLE_APPLICATION_CREDENTIALS points to valid service account JSON")
    print(f"[INIT] 💡 Download from: https://console.cloud.google.com/iam-admin/serviceaccounts")

# ─── Updated System Prompt with Context Awareness ────────────────────────────
BASE_SYSTEM_PROMPT = (
    "You are Arix, a smart, friendly, and enthusiastic educational AI voice tutor. "
    "Always give short, clear and helpful answers. When the user speaks Sinhala, reply in Sinhala. "
    "If the user asks you to look at their screen or whiteboard, use the 'capture_screen' tool. "
    "You receive real-time audio from the user. Respond conversationally with voice.\n\n"
    "IMPORTANT: Remember our previous conversation! When the user asks follow-up questions, "
    "refer to what we just discussed. Maintain context throughout the conversation. "
    "If the user says 'ඒ කියපු දේ තව පැහැදිලි කරන්න' or similar, refer to your last response."
)

def get_dynamic_system_prompt(conversation: ConversationManager = None) -> str:
    """Generate dynamic system prompt with conversation context"""
    prompt = BASE_SYSTEM_PROMPT
    
    if conversation and len(conversation.history) > 1:
        # Add context from conversation
        prompt += conversation.get_context_prompt()
        
        # Add specific instructions for follow-ups
        last_messages = conversation.history[-3:] if len(conversation.history) >= 3 else conversation.history
        if any(msg["role"] == "user" for msg in last_messages) and any(msg["role"] == "assistant" for msg in last_messages):
            prompt += "\n\nThis is a follow-up conversation. Make sure your response connects to the previous exchange."
    
    return prompt

# ─── Gemini Live Session Config ───────────────────────────────────────────────

async def send_keepalive(session):
    """Send silent PCM audio every 10s to keep Gemini Live session alive."""
    silence = b'\x00\x00' * 1600  # 100ms of silence at 16kHz
    while True:
        await asyncio.sleep(10)
        try:
            await session.send_realtime_input(
                audio=types.Blob(data=silence, mime_type="audio/pcm;rate=16000")
            )
            print("[KEEPALIVE] Sent silent audio to keep session alive")
        except Exception as e:
            print(f"[KEEPALIVE] Error: {e}")
            break

def build_config(conversation: ConversationManager = None) -> types.LiveConnectConfig:
    """Build Live API config with dynamic system prompt"""
    system_prompt = get_dynamic_system_prompt(conversation)
    
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Puck"  # Try "Charon" or "Kore" for different voices
                )
            )
        ),
        # Disable automatic voice-activity detection – we manage turns manually
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(
                disabled=True
            )
        ),
        system_instruction=types.Content(
            parts=[types.Part.from_text(text=system_prompt)]
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
        "message": "Arix Backend Active with Vertex AI.",
        "active_sessions": len(active_conversations),
        "version": "2.1.0"
    }
    if MODEL:
        status["live_model"] = MODEL
    return status

# ─── Get or Create Conversation ──────────────────────────────────────────────
def get_conversation(session_id: str = None) -> ConversationManager:
    """Get or create a conversation manager for a session"""
    if not session_id:
        session_id = f"session_{datetime.now().timestamp()}"
    
    if session_id not in active_conversations:
        active_conversations[session_id] = ConversationManager()
        # Clean up old sessions (keep last 100)
        if len(active_conversations) > 100:
            oldest = sorted(active_conversations.keys())[0]
            del active_conversations[oldest]
    
    return active_conversations[session_id]

# ─── WebSocket Live Session ───────────────────────────────────────────────────
@app.websocket("/ws/live")
async def live_voice_session(websocket: WebSocket):
    await websocket.accept()
    
    # Get session ID from query params or generate new one
    session_id = websocket.query_params.get("session_id", f"live_{datetime.now().timestamp()}")
    conversation = get_conversation(session_id)
    
    print(f"[WS] React Client Connected to Arix Live Engine! Session: {session_id}")
    print(f"[WS] {conversation.get_summary()}")

    # Check if Live API is available
    if not live_client or not MODEL:
        await websocket.send_json({
            "type": "error",
            "message": "Live API requires Vertex AI setup. Use text chat instead, or set up GCP credentials."
        })
        await websocket.close()
        return

    try:
        # Build config with conversation context
        config = build_config(conversation)

        async with live_client.aio.live.connect(model=MODEL, config=config) as session:
            print(f"[GEMINI] Connected to Gemini Live [{MODEL}] for session {session_id}")

            # Add system message to conversation
            conversation.add_system_message("Live session started")

            # ── Task 1: Receive responses from Gemini → Send to Frontend ──────
            async def receive_from_gemini():
                try:
                    async for response in session.receive():
                        # DEBUG: dump raw response object for troubleshooting
                        print(f"[GEMINI:{session_id}] raw response:", response)

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
                                        print(f"[AUDIO:{session_id}] {len(part.inline_data.data)} bytes | {part.inline_data.mime_type}")
                                        await websocket.send_json({
                                            "type": "audio",
                                            "data": audio_b64,
                                            "mime_type": part.inline_data.mime_type or "audio/pcm",
                                        })
                                    # Text part (fallback) - add to conversation
                                    elif part.text:
                                        print(f"[TEXT:{session_id}] Gemini: {part.text[:80]}")
                                        conversation.add_assistant_message(part.text, "text")
                                        # Also send as text for debugging/TTS
                                        await websocket.send_json({
                                            "type": "live_text",
                                            "data": part.text,
                                        })

                            # Turn-based conversation: After Arix responds, signal ready for next input
                            if getattr(sc, 'turn_complete', False):
                                print(f"[ARIX:{session_id}] ✅ Turn complete.")
                                await websocket.send_json({
                                    "type": "turn_complete",
                                    "ready": True
                                })

                        # ── Handle Tool Calls (screen capture request) ────────
                        if response.tool_call:
                            for fn_call in response.tool_call.function_calls:
                                if fn_call.name == "capture_screen":
                                    print(f"[TOOL:{session_id}] Gemini requested screen capture!")

                                    # Ask frontend to trigger screen capture
                                    await websocket.send_json({
                                        "type": "capture_screen_request"
                                    })

                                    # Immediately send a tool response to unblock Gemini.
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
                    print(f"[WS:{session_id}] Frontend disconnected (in receive_from_gemini).")
                except Exception as e:
                    print(f"[ERROR:{session_id}] receive_from_gemini: {e}")

            # ── Task 2: Receive data from Frontend → Stream to Gemini ─────────
            async def send_to_gemini():
                keepalive_task = asyncio.create_task(send_keepalive(session))
                try:
                    while True:
                        msg = await websocket.receive_json()

                        # manual VAD signals from frontend
                        if msg.get("type") == "activity_start":
                            await session.send_realtime_input(
                                activity_start=types.ActivityStart()
                            )
                            continue
                        if msg.get("type") == "activity_end":
                            await session.send_realtime_input(
                                activity_end=types.ActivityEnd()
                            )
                            continue

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
                            # Add to conversation history
                            conversation.add_user_message("[Sent whiteboard image]", "image")

                except WebSocketDisconnect:
                    print(f"[WS:{session_id}] Frontend disconnected (in send_to_gemini).")
                except Exception as e:
                    print(f"[ERROR:{session_id}] send_to_gemini: {e}")
                finally:
                    keepalive_task.cancel()

            # Run both tasks concurrently
            await asyncio.gather(
                receive_from_gemini(),
                send_to_gemini(),
                return_exceptions=True,
            )

    except WebSocketDisconnect:
        print(f"[WS:{session_id}] Frontend disconnected before session started.")
    except Exception as e:
        print(f"[ERROR:{session_id}] live_voice_session fatal: {e}")
        import traceback
        traceback.print_exc()
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        # Log session end
        print(f"[WS:{session_id}] Session ended. {conversation.get_summary()}")

# ─── Enhanced Text Chat Endpoint with Context ───────────────────────────────
@app.websocket("/ws/chat")
async def text_chat_session(websocket: WebSocket):
    """Enhanced text chat with full conversation history"""
    await websocket.accept()
    
    # Get session ID from query params or generate new one
    session_id = websocket.query_params.get("session_id", f"chat_{datetime.now().timestamp()}")
    conversation = get_conversation(session_id)
    
    print(f"[CHAT:{session_id}] Text chat client connected (using Vertex AI).")
    print(f"[CHAT:{session_id}] {conversation.get_summary()}")

    # Check if text chat is available
    if not text_client:
        await websocket.send_json({
            "type": "error",
            "message": "Text chat not available. Check Vertex AI setup in backend/.env"
        })
        await websocket.close()
        return

    # Add system message to conversation
    conversation.add_system_message("Text chat session started")

    try:
        while True:
            msg = await websocket.receive_json()
            user_text = msg.get("text", "").strip()
            
            # Check for context override
            provided_context = msg.get("context", "")
            
            if not user_text:
                continue

            print(f"[CHAT:{session_id}] User: {user_text}")
            
            # Add user message to conversation
            conversation.add_user_message(user_text, "text")

            # Build chat with history
            chat = text_client.chats.create(
                model="gemini-2.0-flash-001",
                config=types.GenerateContentConfig(
                    system_instruction=get_dynamic_system_prompt(conversation),
                )
            )

            # Get all previous messages for context
            history = conversation.get_formatted_history()
            
            # Send messages with full context
            response = None
            for hist_msg in history[:-1]:  # Skip the last user message as we'll send it separately
                if hist_msg["role"] == "user":
                    response = await asyncio.to_thread(chat.send_message, hist_msg["content"])
                elif hist_msg["role"] == "assistant":
                    # Add to chat history but don't send
                    pass
            
            # Send current user message
            response = await asyncio.to_thread(chat.send_message, user_text)
            reply = response.text or ""

            print(f"[CHAT:{session_id}] Arix: {reply[:100]}")

            # Add assistant response to conversation
            conversation.add_assistant_message(reply, "text")

            # Send full response + signal frontend to speak it
            await websocket.send_json({
                "type": "text_response",
                "data": reply,
                "session_id": session_id,
                "conversation_summary": conversation.get_summary()
            })

    except WebSocketDisconnect:
        print(f"[CHAT:{session_id}] Text chat client disconnected.")
    except Exception as e:
        print(f"[ERROR:{session_id}] text_chat_session: {e}")
        import traceback
        traceback.print_exc()
    finally:
        print(f"[CHAT:{session_id}] Session ended. {conversation.get_summary()}")

# ─── New Endpoint: Get Conversation History ──────────────────────────────────
@app.get("/conversation/{session_id}")
async def get_conversation_history(session_id: str):
    """Get conversation history for a session"""
    if session_id in active_conversations:
        conv = active_conversations[session_id]
        return {
            "session_id": session_id,
            "history": conv.history,
            "summary": conv.get_summary()
        }
    return {"error": "Session not found"}

# ─── New Endpoint: Clear Conversation ────────────────────────────────────────
@app.delete("/conversation/{session_id}")
async def clear_conversation(session_id: str):
    """Clear conversation history for a session"""
    if session_id in active_conversations:
        active_conversations[session_id].clear()
        return {"status": "cleared", "session_id": session_id}
    return {"error": "Session not found"}

# ─── New Endpoint: List Active Sessions ──────────────────────────────────────
@app.get("/sessions")
async def list_sessions():
    """List all active conversation sessions"""
    return {
        "active_sessions": len(active_conversations),
        "sessions": [
            {
                "session_id": sid,
                "summary": conv.get_summary(),
                "message_count": len(conv.history)
            }
            for sid, conv in active_conversations.items()
        ][-20:]  # Return last 20 sessions
    }

# ─── Entry Point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)