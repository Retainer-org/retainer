import { DocsShell } from "@/components/docs/shell";

// Docs chrome: its own reading shell with a sidebar of topics. No marketing
// nav or footer; the public site's (site) group is untouched.
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
