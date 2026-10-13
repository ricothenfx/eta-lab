import { NextResponse } from 'next/server';

interface Delta {
  label: string;
  unit: string;
  before: number;
  after: number;
  pct: number;
}

export async function POST(req: Request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: 'OPENAI_API_KEY is not configured on the server' },
      { status: 501 },
    );
  }
  try {
    const body = (await req.json()) as {
      before?: Record<string, number>;
      after?: Record<string, number>;
      deltas?: Delta[];
      scenario?: { seed?: number; preset?: string; orderCount?: number };
    };
    if (!body.before || !body.after || !body.deltas) {
      return NextResponse.json({ error: 'before/after/deltas required' }, { status: 400 });
    }

    const table = body.deltas
      .map(
        (d) =>
          `- ${d.label}: BEFORE ${d.before.toFixed(1)} ${d.unit} → AFTER ${d.after.toFixed(1)} ${d.unit} (${d.pct >= 0 ? '+' : ''}${d.pct.toFixed(0)}%)`,
      )
      .join('\n');

    const prompt = `You are explaining a portfolio benchmark to a hiring manager at a food-delivery company (Lieferando/Wolt-style operations).

Scenario: ${body.scenario?.orderCount ?? '?'} seeded orders in a 90-minute Berlin dinner rush, real road network (OSRM, OpenStreetMap). BEFORE = nearest-courier-by-straight-line dispatch plus naive straight-line ETA. AFTER = road-network-aware dispatch plus road-aware ETA that overlaps kitchen prep with the pickup ride. Same seeded orders in both runs.

Results:
${table}

Write at most 110 words, plain English, no markdown headers, no bullet lists. Explain what changed operationally (why assignment + ETA modeling move these numbers) and what an operations team would feel. Do not invent numbers beyond the table.`;

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 260,
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json({ error: `OpenAI ${res.status}: ${detail.slice(0, 180)}` }, { status: 502 });
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return NextResponse.json({ error: 'empty response' }, { status: 502 });
    return NextResponse.json({ text });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'unknown error' },
      { status: 500 },
    );
  }
}
