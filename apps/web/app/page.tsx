import Hero from "@/components/hero";
import { HowItWorks } from "@/components/how-it-works";
import { Guarantees } from "@/components/guarantees";
import { Contract } from "@/components/contract";
import { FAQs } from "@/components/faqs";
import { CTA } from "@/components/cta";

// Three template sections are omitted: the social-proof strip, the quote carousel and the price table.
// Nothing in this repo can back any of them.
export default function Home() {
  return (
    <main>
      <Hero />
      <HowItWorks />
      <Guarantees />
      <Contract />
      <FAQs />
      <CTA />
    </main>
  );
}
