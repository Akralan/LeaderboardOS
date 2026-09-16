import { NextRequest, NextResponse } from 'next/server';
import { TemplateRepository } from '../../../../../../../../packages/database-service/repositories';
import { describeTemplate } from '../../../../../../../../packages/interpreter/describe';
import { compareVersions } from '../../../../../../../../packages/registry/platform';

export const dynamic = 'force-dynamic';

const repo = new TemplateRepository();

// GET /api/templates/:key/describe?version=1.2.0
// La surface sérialisable d'une version publiée — descripteur, lanes, champs
// typés, déclarations de paramètres — d'où le client génère ses écrans et son
// formulaire. Sans `version` : la dernière publiée. Un brouillon n'est jamais
// servi ici ; une version publiée ne contient rien qu'un participant ne voie
// déjà jouer.
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
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
