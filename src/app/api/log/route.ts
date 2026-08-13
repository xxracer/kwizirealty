export async function POST(request: Request) {
  try {
    const body = await request.json();
    const label = body?.label || 'client';
    const data = body?.data;
    console.log(`[${label}]`, data);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
}
