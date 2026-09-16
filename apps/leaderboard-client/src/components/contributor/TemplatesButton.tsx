import Link from "next/link";

// L'accès à l'éditeur de templates, à côté du bouton Admin du profil.
export function TemplatesButton() {
  return (
    <Link
      href="/admin/templates"
      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-brandCP/60 transition-colors hover:bg-white/[0.05] hover:text-brandCP/100"
    >
      Templates
    </Link>
  );
}
