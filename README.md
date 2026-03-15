# Arix Live Agent: Your Guided Education AI Tutor

**Arix** is a next-generation AI Tutor built specifically for the **Gemini Live Agent Challenge**. It transcends traditional text-based interactions by delivering a real-time, multimodal (Voice + Screen-aware) learning experience seamlessly integrated into the user's environment.

## 🚀 The Problem & Solution
Traditional AI tutors require students to constantly type out questions, copy-paste homework, and wait for text responses. This breaks the state of flow. 

**Arix** solves this by providing:
1. **Voice-First Real-Time Interaction**: Built closely referencing the **Gemini Live API** to provide interruption-friendly, fluid, human-like voice conversations.
2. **Context-Aware Screen Access**: A companion Chrome Extension (and upcoming mobile app) allows Arix to "see" the student's screen content, whether it's a PDF worksheet or an educational video, without breaking their concentration.

## ☁️ Google Cloud & GenAI Technologies Used
This project was strictly developed fulfilling the competition requirements:
*   **Google GenAI SDK (Vertex AI)**: We use the new `google-genai` SDK initialized with `vertexai=True` connected directly to Google Cloud.
*   **Model**: `gemini-2.0-flash-exp` connected via the **Live API** endpoint (`aio.live.connect`).
*   **Google Cloud**: Project securely connects via `gcloud auth application-default login` using the `us-central1` zone.

---

## 🏗️ Architecture

1.  **Backend (Python/FastAPI)**: Operates entirely on the cloud, leveraging Vertex AI to handle bidirectional Live WebSocket streaming.
2.  **Web UI (Next.js / React)**: An extensively interactive, Framer-Motion powered front-end allowing microphone capture and raw audio buffering.
3.  **Browser Extension (Chrome)**: Custom service workers and content scripts manage environment context and inject the necessary application attributes directly into the DOM seamlessly.

---

## 💻 Spin-up Instructions (Local Deployment)

### Prerequisites
*   Node.js (v18+)
*   Python (3.10+)
*   Google Cloud CLI (`gcloud`)

### 1. Backend Setup (FastAPI + Vertex)
```bash
# Navigate to backend
cd backend

# Create virtual environment and install dependencies
python -m venv venv
venv\Scripts\activate # (For Windows)
pip install -r requirements.txt

# Authenticate with Google Cloud
gcloud auth application-default login

# Start the server
python main.py
```
*The backend will be available at `ws://localhost:8000/ws/live`*

### 2. Frontend Setup (Next.js)
```bash
# Navigate to the root level project folder Next.js App
npm install

# Start the development server
npm run dev
```
*The UI will be accessible at `http://localhost:3000`*

### 3. Extension Setup
1. Open Google Chrome.
2. Navigate to `chrome://extensions/`.
3. Enable "Developer Mode" in the top right.
4. Click "Load unpacked" and select the `extension/` folder in this repository.

---

## 🎥 Demonstration
[https://www.youtube.com/watch?v=dVN45WFnFQg]

## 📜 Proof of Google Cloud Deployment
Please refer to `backend/main.py`. The initialization utilizes `genai.Client(vertexai=True, project=PROJECT_ID, location=LOCATION)` strictly pointing to our assigned GCP Environment (`https://arix-backend-103963879704.us-central1.run.app/`).
