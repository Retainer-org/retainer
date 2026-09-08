import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";

// Public site chrome. The nav is sticky and in normal flow, so it occupies its
// own space and content never scrolls underneath it -- no top-offset padding
// needed, and no overlap at any scroll position. Anchored sections keep
// scroll-mt-* so jump links land clear of the bar.
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
