import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Retainer — recurring USDC billing on Base spend permissions",
  description:
    "Non-custodial recurring and usage-based USDC billing. Customer to router to merchant in one atomic transaction, on Base spend permissions.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {/* attribute="class" + enableSystem: a real second palette (.dark tokens in
            globals.css), following the OS by default, with a manual toggle. */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {/* The nav is fixed, so every route needs the same top offset (h-14 / sm:h-16),
              and the main region must fill the viewport so the footer sits at the
              bottom on short pages. Doing it here means /sign, /dashboard and /docs
              all inherit it instead of each page rediscovering the bug. */}
          <div className="flex min-h-screen flex-col">
            <Navbar />
            <main className="flex-1 pt-14 sm:pt-16">{children}</main>
            <Footer />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
