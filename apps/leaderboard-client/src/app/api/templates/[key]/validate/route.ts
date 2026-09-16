import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { TemplateRepository } from '../../../../../../../../packages/database-service/repositories';
import { diagnose } from '../../../../../../../../packages/capabilities/templates';

export const dynamic = 'force-dynamic';

// POST /api/templates/:key/validate — admin only. Les diagnostics à la demande :
// d'un texte envoyé (`{yaml}`), ou du brouillon enregistré.
export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { key } = await params;
  const body = (await request.json().catch(() => ({}))) as { yaml?: unknown };
  const yaml = typeof body.yaml === 'string' ? body.yaml : (await new TemplateRepository().findDraft(key))?.yaml;
  if (yaml === undefined) return NextResponse.json({ error: 'No draft to validate' }, { status: 404 });
  return NextResponse.json({ diagnostics: await diagnose(yaml, key) });
}
