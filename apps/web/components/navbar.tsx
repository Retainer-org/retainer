"use client";

import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { motion, useMotionValueEvent, useScroll, useTransform } from "motion/react";
import { ModeToggle } from "@/components/mode-toggle";

// Five items now that Docs exists. Guarantees, Contract and FAQ are reachable
// by scrolling the landing page. The primary button is Dashboard --
// "See the evidence" already lives in the hero, so it was wasted here.
const links = [
  { title: "How it works", href: "/#how-it-works" },
  { title: "Evidence", href: "/#evidence" },
  { title: "Docs", href: "/docs" },
  { title: "Source", href: "https://github.com/Retainer-org/retainer", external: true },
  { title: "Try it (testnet)", href: "/try" },
  { title: "Your permissions", href: "/account" },
];

export const Navbar = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const lastScrollY = useRef(0);

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileMenuOpen]);

  const { scrollY } = useScroll();
  const paddingHorizontal = useTransform(scrollY, [0, 50], [0, 16]);
  const paddingVertical = useTransform(scrollY, [0, 50], [0, 8]);

  useMotionValueEvent(scrollY, "change", (latest) => {
    setHasScrolled(latest > 10);
    const delta = Math.abs(latest - lastScrollY.current);
    if (delta > 5) {
      setIsVisible(!(latest > lastScrollY.current && latest > 100));
      lastScrollY.current = latest;
    }
  });

  const linkCls = "text-sm font-medium text-neutral-600 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white";
  const primary = "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200";

  return (
    // sticky, not fixed: the bar keeps its own space in the document, so page
    // content can never render underneath it at any scroll position.
    <motion.nav
      initial={{ y: 0 }}
      animate={{ y: isVisible ? 0 : -100 }}
      transition={{ duration: 0.3, ease: "easeInOut" }}
      style={{ paddingLeft: paddingHorizontal, paddingRight: paddingHorizontal, paddingTop: paddingVertical }}
      className="sticky top-0 z-50 mx-auto w-full max-w-7xl"
    >
      <motion.div
        animate={{ borderRadius: hasScrolled ? 24 : 0, backdropFilter: hasScrolled ? "blur(12px)" : "blur(0px)" }}
        transition={{ duration: 0.3 }}
        className={`flex h-14 items-center justify-between px-4 transition-colors duration-300 sm:h-16 md:px-8 ${
          hasScrolled
            ? "bg-white/80 shadow-[0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.1)] dark:bg-neutral-900/80 dark:shadow-[0_1px_3px_0_rgba(0,0,0,0.3),0_1px_2px_-1px_rgba(0,0,0,0.3)]"
            : "bg-white dark:bg-neutral-950"
        }`}
      >
        <Link href="/" className="flex items-center gap-2">
          <Mark className="size-4 text-brand-primary" />
          <span className="text-base font-semibold text-black sm:text-lg dark:text-white">Retainer</span>
          <span className="ml-1 hidden rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] font-medium tracking-wide text-neutral-600 sm:inline dark:border-neutral-700 dark:text-neutral-400">
            BASE SEPOLIA
          </span>
        </Link>

        <div className="hidden items-center gap-6 lg:flex lg:gap-8">
          {links.map((l) => (
            <Link key={l.title} href={l.href} className={linkCls} {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {l.title}
            </Link>
          ))}
        </div>

        <div className="hidden items-center gap-4 lg:flex">
          <ModeToggle />
          <Link href="/dashboard" className={primary}>Dashboard</Link>
        </div>

        <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="flex size-10 items-center justify-center rounded-md lg:hidden" aria-label="Toggle menu">
          {mobileMenuOpen ? <CloseIcon className="size-5 text-neutral-900 dark:text-white" /> : <MenuIcon className="size-5 text-neutral-900 dark:text-white" />}
        </button>
      </motion.div>

      <motion.div
        initial={false}
        animate={{ opacity: mobileMenuOpen ? 1 : 0, y: mobileMenuOpen ? 0 : -20 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={`fixed inset-0 top-14 z-40 flex flex-col bg-white sm:top-16 lg:hidden dark:bg-neutral-900 ${mobileMenuOpen ? "pointer-events-auto" : "pointer-events-none"}`}
      >
        <div className="flex flex-1 flex-col overflow-y-auto px-6 py-6">
          <div className="flex flex-col gap-2">
            {links.map((l) => (
              <Link key={l.title} href={l.href} onClick={() => setMobileMenuOpen(false)}
                className="rounded-xl px-4 py-3.5 text-base font-medium text-neutral-900 transition-colors hover:bg-neutral-100 dark:text-white dark:hover:bg-neutral-800"
                {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                {l.title}
              </Link>
            ))}
          </div>
          <div className="mt-auto flex items-center justify-between pt-6">
            <ModeToggle />
            <Link href="/dashboard" onClick={() => setMobileMenuOpen(false)} className="rounded-xl bg-neutral-900 px-4 py-3 text-base font-medium text-white dark:bg-white dark:text-black">Dashboard</Link>
          </div>
        </div>
      </motion.div>
    </motion.nav>
  );
};

const Mark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M4 12h16" /><path d="M14 6l6 6-6 6" />
  </svg>
);
const MenuIcon = (p: React.SVGProps<SVGSVGElement>) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}><path d="M4 6h16M4 12h16M4 18h16" /></svg>);
const CloseIcon = (p: React.SVGProps<SVGSVGElement>) => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...p}><path d="M18 6L6 18M6 6l12 12" /></svg>);
