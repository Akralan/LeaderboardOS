import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { TemplateRepository } from '../../../../../../packages/database-service/repositories';
import { describeTemplate } from '../../../../../../packages/interpreter/describe';
import { compareVersions } from '../../../../../../packages/registry/platform';

export const dynamic = 'force-dynamic';

const repo = new TemplateRepository();

// GET /api/templates — admin only.
// Les templates en base et leurs versions publiées, avec la description de la
// dernière : ce que le sélecteur de type du formulaire de création propose, et
// les déclarations de paramètres dont il génère la section (templates-in-db, T1).
// Un template archivé n'y figure plus ; ses challenges, eux, restent servis.
export async function GET() {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const [all, published] = await Promise.all([repo.listTemplates(), repo.listPublished()]);
  const templates = all
    .filter((template) => !template.archived_at)
    .map((template) => {
      const versions = published
        .filter((version) => version.template_key === template.key)
        .sort((a, b) => compareVersions(a.version, b.version));
      const newest = versions.at(-1);
      let latest = null;
      if (newest) {
        try {
          const { descriptor, surface } = describeTemplate(newest.yaml, template.key);
          latest = { version: newest.version, descriptor, surface };
        } catch {
          // Une version publiée qui ne se décrit plus n'est pas instanciable : elle n'est pas proposée.
        }
      }
      return {
        key: template.key,
        name: template.name,
        versions: versions.map((version) => ({ version: version.version, published_at: version.published_at })),
        latest,
      };
    });

  return NextResponse.json({ templates });
}
