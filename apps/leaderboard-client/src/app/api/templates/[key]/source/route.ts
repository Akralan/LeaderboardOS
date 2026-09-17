import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { systemTemplateSources } from '@/distribution/mytwin.templates';
import { TemplateRepository } from '../../../../../../../../packages/database-service/repositories';
import { compareVersions } from '../../../../../../../../packages/registry/platform';

export const dynamic = 'force-dynamic';

// GET /api/templates/:key/source?version=1.2.0 — admin only.
// Le texte d'une version publiée, que l'éditeur ouvre en lecture seule (et
// dont « New version » repart). Sans `version` : la dernière publiée. Un
// template système rend son texte de distribution, lui aussi en lecture seule.
export async function GET(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { key } = await params;
  const system = systemTemplateSources.find((source) => source.key === key);
  if (system) return NextResponse.json({ key, origin: 'system', version: null, yaml: system.yaml });

  const repo = new TemplateRepository();
  const requested = request.nextUrl.searchParams.get('version');
  const row = requested
    ? await repo.findPublished(key, requested)
    : (await repo.listVersions(key))
        .filter((version) => version.status === 'published' && version.version)
        .sort((a, b) => compareVersions(a.version!, b.version!))
        .at(-1) ?? null;
  if (!row) return NextResponse.json({ error: 'Template version not found' }, { status: 404 });
  return NextResponse.json({ key, origin: 'database', version: row.version, published_at: row.published_at, yaml: row.yaml });
}
