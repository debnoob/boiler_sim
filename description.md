# NEXUS OS — Project Description

---

## What Is This Project?

NEXUS OS is a **real-time boiler monitoring and intelligence dashboard** built for industrial facilities. Think of it as a smart control room assistant that watches over a boiler 24/7, detects when something is going wrong before it becomes a serious problem, predicts what will happen next, and answers questions from the operator in plain English.

It simulates a real boiler using physics math, runs machine learning models to spot anomalies, forecasts future sensor readings, and uses an AI chatbot to explain what is happening and what to do about it — all shown live on a browser dashboard.

---

## Purpose of the Project

Industrial boilers are complex, expensive, and dangerous if not properly maintained. Most facilities rely on operators manually watching gauges or basic alarm systems that only alert when something has already gone wrong.

NEXUS OS goes further by:

- **Continuously watching** 15 sensor values (pressure, temperature, drum level, fuel flow, flue gas, etc.) in real time
- **Detecting early warning signs** of equipment degradation before a fault occurs
- **Predicting future sensor behavior** so operators know what to expect in the next 60 seconds
- **Explaining anomalies in plain language** so operators can act quickly without guessing
- **Answering questions** via an AI chat panel (e.g., "Why is my efficiency dropping?")
- **Grounding AI answers in actual boiler manuals** uploaded by the operator (RAG)

---

## How It Can Be Used in Real Life

| Industry | Real-Life Use Case |
|----------|--------------------|
| **Power Plants** | Monitor boilers that generate steam for turbines — catch tube failures early to prevent costly shutdowns |
| **Oil & Gas** | Watch process heaters and fired equipment in refineries for abnormal combustion or pressure swings |
| **Manufacturing** | Monitor steam boilers in factories (food, textiles, chemicals) that run production lines |
| **Hospitals & Universities** | Central plant operators can track campus boilers remotely and get AI-generated shift reports |
| **District Heating** | Cities that pipe steam heat to buildings can detect faults across multiple units from one dashboard |
| **Maintenance Teams** | Maintenance engineers can upload boiler manuals and ask the AI specific technical questions during inspections |

In practice, a plant operator opens the dashboard in a browser, watches live sensor readings update every second, sees the AI flag anomalies with a severity score, and reads a plain-English explanation of what is happening — all without needing to be a data scientist.

---

## Detailed Tech Stack

### Backend / Engine Layer

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Physics Simulation | Python (`boiler_engine.py`) | Simulates a real boiler using thermodynamic equations. Generates realistic sensor data at 1 reading per second across 4 operating modes: Normal, Degrading, Critical, Fault |
| Message Bus | **Mosquitto MQTT Broker** | Lightweight, industrial-grade messaging protocol. All services publish and subscribe to sensor topics. Runs on TCP port 1883 and WebSocket port 9001 |
| Anomaly Detection | **scikit-learn Isolation Forest** | Machine learning model that learns what "normal" sensor patterns look like, then scores how abnormal each new reading is (0–100%). Warms up on 40 samples, then runs live |
| Probabilistic Forecasting | **Moirai 2.0 + HuggingFace** | Time-series AI model that predicts future sensor values with confidence bands (best case / expected / worst case). Runs every 15 seconds. Falls back to statistical methods if GPU is unavailable |
| AI Analysis | **Ollama (local LLM)** | Locally-hosted large language model that reads sensor buffers, anomaly scores, and alerts to write diagnosis cards and answer operator questions in plain English |
| RAG Knowledge Server | **FastAPI + Qdrant + Ollama Embeddings** | Operator uploads boiler PDFs → they are chunked, embedded as vectors, stored in Qdrant. When the AI answers a question, it searches the manual first to ground the answer in real documentation |
| Python Runtime | Python 3.11+ | All backend services are standalone Python scripts |

### Data & Messaging Layer

| Component | Technology | Purpose |
|-----------|-----------|---------|
| MQTT Protocol | **paho-mqtt** (Python client) | Publishes sensor readings and AI results to topic hierarchy: `factory/pumphouse4/boiler/unit01/*` |
| MQTT WebSocket | **Mosquitto WS port 9001** | Lets the browser dashboard subscribe directly to live MQTT topics without a backend API |
| MQTT Client (Browser) | **MQTT.js 5.15** | JavaScript library that connects the Next.js frontend to the Mosquitto broker over WebSocket |
| Vector Database | **Qdrant** | Stores embedded chunks of boiler manuals for fast similarity search during RAG lookups |

### Frontend / Dashboard Layer

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Framework | **Next.js 16 + React 19** | Modern web framework for the live dashboard. Server-side rendering with client-side real-time updates |
| State Management | **Zustand 5** | Lightweight global state that holds live sensor buffers, chart data, and AI messages — updates 1× per second without re-rendering everything |
| Charts | **Chart.js 4.5 + react-chartjs-2** | 7 real-time line charts: pressure, temperature, drum level, fuel flow, flue gas, efficiency, and anomaly score. Each shows a rolling 60-second window |
| Styling | **Tailwind CSS 4** | Utility-first CSS framework. Supports light/dark theme toggle with state persisted in the browser |
| KPI Gauges | Custom React components | 4 large gauge displays: Steam Pressure, Drum Level, Boiler Efficiency, Load Percentage |
| AI Chat Panel | Custom React component | Typewriter-effect chat UI with PDF upload button. Operator types questions, AI responds with diagnosis and advice. Shows 3-turn conversation memory |

### ML & AI Layer

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Anomaly Detector | **Isolation Forest** (sklearn) | Unsupervised ML — no labelled fault data needed. Scores 6 sensor features: pressure, temperature, drum level, fuel flow, flue gas temp, efficiency |
| Time-Series Forecaster | **Moirai 2.0** (Salesforce, via HuggingFace) | Foundation model for time-series prediction. Generates p10/p50/p90 probability bands. Calculates time-to-breach ETA for safety thresholds |
| Language Model | **Ollama** (local inference) | Runs LLMs locally (no cloud API needed). Used for diagnosis cards (probable cause, severity, confidence, recommended actions) and freeform operator chat |
| Embeddings | **nomic-embed-text** (768-dim, via Ollama) | Converts PDF manual text chunks into vectors so Qdrant can find the most relevant passages for any operator question |
| PDF Parsing | **PyMuPDF (fitz)** | Extracts raw text from uploaded boiler manuals before chunking and embedding |

### Infrastructure & DevOps

| Component | Technology | Purpose |
|-----------|-----------|---------|
| MQTT Broker | **Eclipse Mosquitto** | Open-source, lightweight MQTT server. Runs locally or on a server on the plant network |
| Local AI | **Ollama** | Runs language models entirely on-premise — no data leaves the facility |
| Package Management | pip (Python), npm (Node.js) | Dependency management for both stacks |
| TypeScript | TypeScript 5 | Adds type safety to all frontend React components and MQTT payload interfaces |

---

## System Architecture (Simple View)

```
[Boiler Simulation]
     boiler_engine.py
           |
           | MQTT (1 Hz sensor readings)
           ▼
  [Mosquitto MQTT Broker]
    TCP 1883 | WS 9001
    /              \
   /                \
[ML Services]    [Browser Dashboard]
anomaly_detector  Next.js + Chart.js
forecasting_engine   (real-time charts,
ai_analyst           KPI gauges,
rag_server           AI chat panel)
   |
   | MQTT (scores, forecasts, AI diagnosis)
   ▼
[Mosquitto MQTT Broker]
           |
           ▼
   [Browser Dashboard]
     (receives AI results)
```

---

## Key Numbers at a Glance

| Metric | Value |
|--------|-------|
| Sensor update rate | 1 Hz (1 reading/second) |
| Sensors monitored | 15 tags (pressure, temp, level, fuel, flue gas, etc.) |
| Anomaly score range | 0–100% |
| Forecast horizon | 60 seconds ahead |
| Forecast runs every | 15 seconds |
| Chart history window | 60 data points (1 minute) |
| AI diagnosis debounce | 1 card per 30 seconds max |
| LLM memory | Last 3 chat turns + 2-minute telemetry buffer |
| Python code | ~2,100 lines across 5 services |
| Frontend code | ~1,400 lines across 8 React components |
| Operating modes | Normal → Degrading → Critical → Fault |
