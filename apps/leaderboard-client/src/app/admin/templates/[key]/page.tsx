import { TemplateEditorPage } from '@/components/templates/editor/GraphEditor';

// L'éditeur de graphe d'un template : son brouillon, ou une version publiée (`?version=`), en lecture seule.
export default async function AdminTemplateEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const { key } = await params;
  const { version } = await searchParams;
  return <TemplateEditorPage templateKey={decodeURIComponent(key)} version={typeof version === 'string' ? version : null} />;
}
