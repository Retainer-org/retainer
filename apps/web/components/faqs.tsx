"use client";

import React, { useRef, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Heading } from "@/components/heading";
import { Subheading } from "@/components/subheading";
import { cn } from "@/lib/utils";
import { IconPlus } from "@tabler/icons-react";
import { GridLineHorizontal, GridLineVertical } from "./grid-lines";

// Accordion mechanics from the template; every answer rewritten from the repo.
const faqData = [
  { title: "Status", items: [
    { question: "Is this on mainnet?",
      answer: "No. Everything runs on Base Sepolia (chain 84532). The router is deployed and verified there, and every charge referenced on this page is a testnet transaction. There is no mainnet deployment and no production claim." },
    { question: "Who is behind it?",
      answer: "One person. The repository is public and the commit history is the whole story." },
  ]},
  { title: "Custody", items: [
    { question: "Does Retainer ever hold funds?",
      answer: "No, by construction. The router pulls from the customer and forwards to the merchant treasury in the same transaction; if the forward fails, the whole charge reverts. Retainer holds the executor key, which can trigger a charge, and nothing else. A fuzz test asserts the router's balance is zero after every charge and fails the build otherwise." },
    { question: "Can Retainer take a fee out of the flow?",
      answer: "No. The router forwards the full value to a single recipient — there is no fee split. That is a structural limit, and it means any Retainer revenue has to be a flat fee to the merchant, never a percentage of the money moving." },
  ]},
  { title: "Charging", items: [
    { question: "What can the customer control?",
      answer: "The permission fixes the spender, token, allowance per period, period length, start and end. The allowance resets on-chain at each period boundary and unused amounts do not carry over. The customer can revoke at any time, and revocation is effective the block it is mined. The contract enforces all of this, not Retainer." },
    { question: "What happens when a charge fails?",
      answer: "It is classified from chain state before any gas is spent: revoked, expired, insufficient balance, allowance exhausted, not started, or not approved. Revoked and expired are terminal. Insufficient balance retries with backoff. Allowance exhausted and not started wait for a known time. A reverted charge consumes no allowance, so retrying is safe against the cap." },
    { question: "What does a charge cost?",
      answer: "About 135,000–150,000 gas for a routed charge. At the Base fees we measured, roughly $0.002–$0.011 — about half a cent. Gas is paid by the merchant's executor, never the customer." },
  ]},
];

export function FAQs() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) { if (containerRef.current && !containerRef.current.contains(e.target as Node)) setActiveId(null); }
    document.addEventListener("mousedown", onDown); return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div id="faq" className="mx-auto max-w-4xl scroll-mt-24 overflow-hidden px-4 py-20 md:px-8 md:py-32">
      <div className="text-center">
        <Heading as="h2">Questions worth asking</Heading>
        <Subheading className="mx-auto mt-4 max-w-2xl">Answers are only as good as what the repo can back.</Subheading>
      </div>
      <div ref={containerRef} className="relative mt-16 flex flex-col gap-12 px-4 md:px-8">
        {faqData.map((section) => (
          <div key={section.title}>
            <h3 className="mb-6 text-lg font-medium text-neutral-800 dark:text-neutral-200">{section.title}</h3>
            <div className="flex flex-col gap-3">
              {section.items.map((item, index) => {
                const id = `${section.title}-${index}`; const isActive = activeId === id;
                return (
                  <div key={id} className={cn("relative rounded-lg transition-all duration-200", isActive ? "bg-white shadow-sm ring-1 shadow-black/10 ring-black/10 dark:bg-neutral-900 dark:shadow-white/5 dark:ring-white/10" : "hover:bg-neutral-50 dark:hover:bg-neutral-900")}>
                    {isActive && (<div className="absolute inset-0">
                      <GridLineHorizontal className="-top-[2px]" offset="100px" /><GridLineHorizontal className="-bottom-[2px]" offset="100px" />
                      <GridLineVertical className="-left-[2px]" offset="100px" /><GridLineVertical className="-right-[2px] left-auto" offset="100px" />
                    </div>)}
                    <button onClick={() => setActiveId(isActive ? null : id)} className="flex w-full items-center justify-between px-4 py-4 text-left">
                      <span className="text-sm font-medium text-neutral-700 md:text-base dark:text-neutral-300">{item.question}</span>
                      <motion.div animate={{ rotate: isActive ? 45 : 0 }} transition={{ duration: 0.2 }} className="ml-4 shrink-0"><IconPlus className="size-5 text-neutral-500 dark:text-neutral-400" /></motion.div>
                    </button>
                    <AnimatePresence initial={false}>
                      {isActive && (<motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15, ease: "easeInOut" }} className="relative">
                        <p className="max-w-[90%] px-4 pb-4 text-sm text-neutral-600 dark:text-neutral-400">{item.answer}</p>
                      </motion.div>)}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
