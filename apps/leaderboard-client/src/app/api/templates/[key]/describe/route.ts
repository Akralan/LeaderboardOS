import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { TemplateRepository } from '../../../../../../../../packages/database-service/repositories';
import { describeTemplate } from '../../../../../../../../packages/interpreter/describe';
import { compareVersions } from '../../../../../../../../packages/registry/platform';
import { templates } from '../../../../../../../../packages/capabilities/templates';

export const dynamic = 'force-dynamic';

const repo = new TemplateRepository();

// GET /api/templates/:key/describe?version=1.2.0
// La surface sérialisable d'une version publiée — descripteur, lanes, champs
// typés, déclarations de paramètres — d'où le client génère ses écrans et son
// formulaire. Sans `version` : la dernière publiée. Une version publiée ne
// contient rien qu'un participant ne voie déjà jouer.
//
// `?draft=1` (admin) : la prévisualisation du brouillon, par les mêmes
// composants générés ; un brouillon qui ne se décrit pas rend ses diagnostics.
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;

  if (request.nextUrl.searchParams.get('draft') === '1') {
    const session = await getSessionUser();
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const preview = await templates().describeDraft(key);
    if (!preview) return NextResponse.json({ error: 'No draft' }, { status: 404 });
    if (!preview.ok) return NextResponse.json({ error: 'This draft cannot be previewed yet', diagnostics: preview.diagnostics }, { status: 422 });
    return NextResponse.json({ key, version: null, draft: true, descriptor: preview.descriptor, surface: preview.surface });
  }

  const requested = request.nextUrl.searchParams.get('version');
  const row = requested
    ? await repo.findPublished(key, requested)
    : (await repo.listPublished()).filter((version) => version.template_key === key).sort((a, b) => compareVersions(a.version, b.version)).at(-1) ?? null;
  if (!row) return NextResponse.json({ error: 'Template version not found' }, { status: 404 });

  try {
    const { descriptor, surface } = describeTemplate(row.yaml, key);
    return NextResponse.json({ key, version: row.version, descriptor, surface });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'This version cannot be described' }, { status: 409 });
  }
}
