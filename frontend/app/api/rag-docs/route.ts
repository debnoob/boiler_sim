import { NextResponse } from 'next/server';

const RAG_SERVER = process.env.RAG_SERVER_URL ?? 'http://localhost:8001';

export async function GET() {
  try {
    const resp = await fetch(`${RAG_SERVER}/api/docs`, { cache: 'no-store' });
    const data = await resp.json();
    if (!resp.ok) return NextResponse.json(data, { status: resp.status });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: 'RAG server unreachable', documents: [] },
      { status: 502 },
    );
  }
}
