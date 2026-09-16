import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { templates } from '../../../../../../../packages/capabilities/templates';

export const dynamic = 'force-dynamic';

// GET /api/templates/:key — admin only. Les versions publiées d'un template
// (avec leur usage), et son brouillon avec les diagnostics de ce brouillon.
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { key } = await params;
  const detail = await templates().detail(key);
  if (!detail) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  return NextResponse.json(detail);
}
