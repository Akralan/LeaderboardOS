import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { TemplateStoreError } from '../../../../../../../../packages/database-service/repositories';
import { templates, TemplatePublishError } from '../../../../../../../../packages/capabilities/templates';

export const dynamic = 'force-dynamic';

// POST /api/templates/:key/publish — admin only, sans corps : la version est
// lue dans le YAML du brouillon. Refusée (422) avec la liste que l'éditeur
// affiche ; une version qui ne dépasse pas la dernière publiée : 409.
export async function POST(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { key } = await params;
  try {
    const published = await templates().publish(key, session.id);
    return NextResponse.json({ version: published.version, published_at: published.published_at }, { status: 201 });
  } catch (caught) {
    if (caught instanceof TemplatePublishError) return NextResponse.json({ error: caught.message, diagnostics: caught.diagnostics }, { status: 422 });
    if (caught instanceof TemplateStoreError) return NextResponse.json({ error: caught.message }, { status: caught.reason === 'not_found' ? 404 : 409 });
    throw caught;
  }
}
