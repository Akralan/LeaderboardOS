import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { declaredQualifications } from '@/distribution/mytwin.templates';
import { TemplatePublishError } from '../../../../../../../packages/capabilities/templates';
import { AuthorUnavailableError, authorDraft } from '../../../../../../../packages/template-author/service';

export const dynamic = 'force-dynamic';
// La boucle génère puis répare jusqu'à trois fois : synchrone, avec une durée généreuse (note template-author §0.5).
export const maxDuration = 300;

const bodySchema = z.object({
  description: z.string().trim().min(10, 'describe the flow in a sentence or more').max(8000),
  name: z.string().trim().min(1).max(255).optional(),
  key: z.string().regex(/^[a-z][a-z0-9-]*$/, 'a template key is kebab-case, without dots').max(50).optional(),
});

// POST /api/templates/author — admin only. Une description → un brouillon,
// enregistré même rouge, avec ses diagnostics, les choix faits et les
// questions ouvertes. L'agent ne publie jamais.
export async function POST(request: NextRequest) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Validation error', details: parsed.error.issues }, { status: 400 });

  try {
    const report = await authorDraft({ ...parsed.data, by: session.id }, { declaredQualifications });
    return NextResponse.json({ ...report, previewUrl: `/api/templates/${encodeURIComponent(report.key)}/describe?draft=1` }, { status: 201 });
  } catch (caught) {
    if (caught instanceof AuthorUnavailableError) return NextResponse.json({ error: caught.message }, { status: 503 });
    if (caught instanceof TemplatePublishError) return NextResponse.json({ error: caught.message, diagnostics: caught.diagnostics }, { status: 409 });
    console.error(JSON.stringify({ level: 'error', event: 'template_author_failed', reason: caught instanceof Error ? caught.message : String(caught) }));
    return NextResponse.json({ error: 'The template author failed — try again' }, { status: 502 });
  }
}
