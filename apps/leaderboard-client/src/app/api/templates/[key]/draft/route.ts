import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { TemplateRepository } from '../../../../../../../../packages/database-service/repositories';
import { templates } from '../../../../../../../../packages/capabilities/templates';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ yaml: z.string().max(1_000_000) });

// PUT /api/templates/:key/draft — admin only. Écrit le brouillon, quel qu'il
// soit : un brouillon troué s'enregistre. Les diagnostics de ce texte reviennent
// avec chaque écriture — exactement ceux qui refuseraient sa publication.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { key } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation error', details: parsed.error.issues }, { status: 400 });
  if (!(await new TemplateRepository().findTemplate(key))) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

  const { draft, diagnostics } = await templates().saveDraft(key, parsed.data.yaml, session.id);
  return NextResponse.json({ updated_at: draft.updated_at, diagnostics });
}
