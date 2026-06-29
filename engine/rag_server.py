"""
NEXUS OS — RAG Server
Handles PDF ingestion → chunking → Ollama embeddings → Qdrant,
and exposes a /search endpoint consumed by ai_analyst.py.

Run:
    uvicorn engine.rag_server:app --host 0.0.0.0 --port 8001 --reload
"""

import os
import io
import uuid
import math
import requests

import fitz  # PyMuPDF
from dotenv import load_dotenv
load_dotenv()
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct,
    Filter, FieldCondition, MatchValue,
)

# ──────────────────────────────────────────────
# CONFIG
# ──────────────────────────────────────────────
QDRANT_URL    = os.environ.get("QDRANT_URL")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY")
COLLECTION    = "boiler_manuals"
EMBED_MODEL   = os.environ.get("EMBED_MODEL", "nomic-embed-text")
OLLAMA_BASE   = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
EMBED_DIM     = 768          # nomic-embed-text output size
CHUNK_SIZE    = 500          # characters per chunk
CHUNK_OVERLAP = 80           # character overlap between chunks

# ──────────────────────────────────────────────
# QDRANT CLIENT
# ──────────────────────────────────────────────
qdrant = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)


def ensure_collection():
    existing = [c.name for c in qdrant.get_collections().collections]
    if COLLECTION not in existing:
        qdrant.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=EMBED_DIM, distance=Distance.COSINE),
        )
        print(f"[RAG] Created Qdrant collection '{COLLECTION}'")
    else:
        print(f"[RAG] Collection '{COLLECTION}' already exists")


# ──────────────────────────────────────────────
# EMBEDDING
# ──────────────────────────────────────────────
def embed_text(text: str) -> list[float]:
    """Call Ollama /api/embeddings to get a vector for text."""
    resp = requests.post(
        f"{OLLAMA_BASE}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": text},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


# ──────────────────────────────────────────────
# CHUNKING
# ──────────────────────────────────────────────
def chunk_text(text: str) -> list[str]:
    """Split text into overlapping character-level chunks."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunks.append(text[start:end].strip())
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return [c for c in chunks if len(c) > 40]  # drop tiny tail chunks


def extract_text_from_pdf(data: bytes) -> str:
    """Extract all text from PDF bytes using PyMuPDF."""
    doc = fitz.open(stream=data, filetype="pdf")
    pages = []
    for page in doc:
        pages.append(page.get_text())
    doc.close()
    return "\n".join(pages)


# ──────────────────────────────────────────────
# FASTAPI APP
# ──────────────────────────────────────────────
from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_collection()
    print("[RAG] Server ready")
    yield


app = FastAPI(title="NEXUS OS RAG Server", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "collection": COLLECTION}


# ──────────────────────────────────────────────
# PDF INGEST
# ──────────────────────────────────────────────
@app.post("/api/upload-pdf")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    data = await file.read()
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 50 MB).")

    print(f"[RAG] Ingesting '{file.filename}' ({len(data)//1024} KB)…")

    try:
        raw_text = extract_text_from_pdf(data)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"PDF extraction failed: {e}")

    if not raw_text.strip():
        raise HTTPException(status_code=422, detail="No extractable text found in PDF.")

    chunks = chunk_text(raw_text)
    print(f"[RAG] {len(chunks)} chunks from '{file.filename}'")

    doc_id = str(uuid.uuid4())
    points = []
    for i, chunk in enumerate(chunks):
        try:
            vector = embed_text(chunk)
        except Exception as e:
            print(f"[RAG] Embedding error on chunk {i}: {e}")
            continue
        points.append(
            PointStruct(
                id=str(uuid.uuid4()),
                vector=vector,
                payload={
                    "doc_id": doc_id,
                    "filename": file.filename,
                    "chunk_index": i,
                    "text": chunk,
                },
            )
        )

    if not points:
        raise HTTPException(status_code=500, detail="All chunks failed to embed.")

    # Upsert in batches of 64
    batch_size = 64
    for start in range(0, len(points), batch_size):
        qdrant.upsert(
            collection_name=COLLECTION,
            points=points[start : start + batch_size],
        )

    print(f"[RAG] Stored {len(points)} vectors for '{file.filename}'")
    return {
        "filename": file.filename,
        "doc_id": doc_id,
        "chunks_stored": len(points),
        "total_chars": len(raw_text),
    }


# ──────────────────────────────────────────────
# SEARCH
# ──────────────────────────────────────────────
class SearchRequest(BaseModel):
    query: str
    top_k: int = 4


@app.post("/api/search")
def search(req: SearchRequest):
    if not req.query.strip():
        return {"results": []}
    try:
        vector = embed_text(req.query)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding failed: {e}")

    response = qdrant.query_points(
        collection_name=COLLECTION,
        query=vector,
        limit=req.top_k,
        with_payload=True,
    )
    hits = response.points
    results = [
        {
            "text": h.payload["text"],
            "filename": h.payload.get("filename", ""),
            "score": round(h.score, 4),
            "chunk_index": h.payload.get("chunk_index", 0),
        }
        for h in hits
    ]
    return {"results": results}


# ──────────────────────────────────────────────
# LIST INGESTED DOCS
# ──────────────────────────────────────────────
@app.get("/api/docs")
def list_docs():
    """Return unique filenames stored in the collection."""
    try:
        # Scroll through all points and collect unique filenames
        seen, names = set(), []
        offset = None
        while True:
            result, offset = qdrant.scroll(
                collection_name=COLLECTION,
                limit=200,
                offset=offset,
                with_payload=["filename", "doc_id"],
                with_vectors=False,
            )
            for p in result:
                fn = p.payload.get("filename", "")
                if fn not in seen:
                    seen.add(fn)
                    names.append({"filename": fn, "doc_id": p.payload.get("doc_id")})
            if offset is None:
                break
        return {"documents": names}
    except Exception as e:
        return {"documents": [], "error": str(e)}
