import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { systemTemplateSources } from '@/distribution/mytwin.templates';
import { TemplateStoreError } from '../../../../../../packages/database-service/repositories';
import { templates, TemplatePublishError } from '../../../../../../packages/capabilities/templates';

export const dynamic = 'force-dynamic';

async function requireAdmin() {
  const session = await getSessionUser();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

// GET /api/templates — admin only.
// La bibliothèque de l'éditeur (templates-in-db, T3) : les templates système,
// en lecture seule et duplicables, et ceux de la base, avec leurs versions
// publiées, leur brouillon, leur usage et la description de la dernière
// version — celle dont le formulaire de création génère sa section.
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  return NextResponse.json(await templates().library(systemTemplateSources));
}

const createSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]*$/, 'a template key is kebab-case, without dots').max(50).refine((key) => key !== 'author', 'author is reserved'),
    name: z.string().trim().min(1).max(255),
    yaml: z.string().max(1_000_000).optional(),
    // Dupliquer : un template système, ou une version publiée (la dernière sans `version`).
    seed: z.object({ key: z.string().min(1), version: z.string().optional() }).optional(),
  })
  .refine((body) => !(body.yaml !== undefined && body.seed), { message: 'yaml or seed, not both' });

// POST /api/templates — admin only. Crée un template et son premier brouillon.
export async function POST(request: NextRequest) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation error', details: parsed.error.issues }, { status: 400 });
  const { key, name, seed } = parsed.data;

  let yaml = parsed.data.yaml ?? '';
  if (seed) {
    const seeded = await templates().seedYaml(seed, key, systemTemplateSources);
    if (seeded === null) {
      return NextResponse.json({ error: `No template ${seed.key}${seed.version ? `@${seed.version}` : ''} to duplicate` }, { status: 404 });
    }
    yaml = seeded;
  }

  try {
    const created = await templates().create({ key, name, yaml, by: session.id });
    return NextResponse.json({ template: created.template, diagnostics: created.diagnostics }, { status: 201 });
  } catch (caught) {
    if (caught instanceof TemplatePublishError) return NextResponse.json({ error: caught.message, diagnostics: caught.diagnostics }, { status: 409 });
    if (caught instanceof TemplateStoreError) {
      return NextResponse.json({ error: caught.message }, { status: caught.reason === 'key_taken' ? 409 : 400 });
    }
    throw caught;
  }
}
