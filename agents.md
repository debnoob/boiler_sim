# AGENTS.md

## Architecture & Core Logic
- **Event-Driven Design**: The LLM acts as an explainer, never a detector. The existing `anomaly_detector.py` (Isolation Forest) handles all mathematical detection. 
- **Trigger**: Run the LLM only when an anomaly fires. It turns telemetry numbers into language (paragraphs or JSON cards) after an alert.
- **Data Privacy & Transmission**: Telemetry data leaves the local network to query the Groq Cloud API. Ensure payloads contain only essential sensor metrics and omit sensitive infrastructure metadata where possible.

## Tech Stack & Environment
- **LLM Runner**: Use the Groq API (via standard HTTP requests or the Groq Python SDK). 
- **Target Model**: `llama-3.3-70b-versatile`.
- **Hardware Profile**: The local machine requires minimal resources since the heavy lifting moves to the cloud. Local RAM and CPU strictly handle the MQTT broker, the anomaly detector, and the API client service.
- **Service Integration**: Build a lightweight Python "AI analyst" service alongside `anomaly_detector.py`. It subscribes to the anomaly MQTT topic, sends the payload to Groq via API, and publishes results to `.../ai/diagnosis`. Ensure the service requires a `GROQ_API_KEY` environment variable.

## Feature Roadmap (Build in this order)
1. **AI Incident Cards (Demo Priority)**
   - When `anomaly_score` crosses the threshold, assemble a payload containing: deviated sensors, baseline difference, 60s trend, and operating mode.
   - Send to Groq with a forced-JSON prompt (e.g., "You are a boiler maintenance engineer. Return probable cause, severity, and recommended action as JSON").
   - Test by injecting a fault live via `boiler_engine.py`.
2. **"Ask the Plant" Chat Panel**
   - Inject the last N minutes of telemetry into the prompt context to answer user questions like "why is efficiency down?". The 70B model handles complex reasoning over this data effortlessly.
3. **End-of-Shift Summary**
   - Generate a shift report detailing uptime, anomaly count, efficiency trends, and recommended follow-ups.
4. **Manual-Aware Diagnosis (RAG)**
   - Use `sqlite-vec` or `ChromaDB` locally. You can use Groq for generation, but you need a lightweight local embedding model (like `all-MiniLM-L6-v2` via `sentence-transformers`) or a cloud embedding API to vectorize the boiler maintenance manual PDF.
   - Cite specific manual sections inside the incident cards.

## Development Rules & Model Constraints
- **Temperature**: Force `temperature: 0.2` for consistent, deterministic outputs.
- **Output Format**: Force JSON mode for incident cards.
- **Prompt Size & Context**: Llama 3.3 70B has a massive context window (128k). You can safely include extended telemetry logs and manual excerpts without hitting local memory limits.
- **Rate Limits & Debouncing**: Generate exactly one diagnosis per anomaly event. Implement API retry logic to handle potential Groq rate limits gracefully.
- **UI State**: Publish an "AI analyzing…" state to the dashboard websockets. Because Groq is exceptionally fast (often returning tokens in under a second), this spinner flashes quickly, giving a snappy feel to the interface.