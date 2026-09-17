import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { declaredQualifications } from '@/distribution/mytwin.templates';
import { AuthorUnavailableError, refineDraft } from '../../../../../../../../../packages/template-author/service';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const bodySchema = z.object({ instruction: z.string().trim().min(3).max(4000) });

// POST /api/templates/:key/author/refine — admin only. Le brouillon enregistré
// + une consigne → le brouillon modifié par éditions ciblées (le reste reste
// intact), enregistré, avec ses diagnostics.
export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { key } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation error', details: parsed.error.issues }, { status: 400 });

  try {
    const report = await refineDraft({ key, instruction: parsed.data.instruction, by: session.id }, { declaredQualifications });
    if (!report) return NextResponse.json({ error: 'No draft to refine' }, { status: 404 });
    return NextResponse.json(report);
  } catch (caught) {
    if (caught instanceof AuthorUnavailableError) return NextResponse.json({ error: caught.message }, { status: 503 });
    console.error(JSON.stringify({ level: 'error', event: 'template_refine_failed', template: key, reason: caught instanceof Error ? caught.message : String(caught) }));
    return NextResponse.json({ error: 'The template author failed — try again' }, { status: 502 });
  }
}
