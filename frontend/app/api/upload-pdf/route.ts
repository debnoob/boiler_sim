import { NextRequest, NextResponse } from 'next/server';

const RAG_SERVER = process.env.RAG_SERVER_URL ?? 'http://localhost:8001';

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get('file');

  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  // Forward the multipart form to the RAG server
  const upstream = new FormData();
  upstream.append('file', file);

  try {
    const resp = await fetch(`${RAG_SERVER}/api/upload-pdf`, {
      method: 'POST',
      body: upstream,
    });

    const data = await resp.json();

    if (!resp.ok) {
      return NextResponse.json(data, { status: resp.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: 'RAG server unreachable. Make sure rag_server.py is running on port 8001.' },
      { status: 502 },
    );
  }
}
