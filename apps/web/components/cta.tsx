import Link from "next/link";
import { Heading } from "./heading";
import { Subheading } from "./subheading";

// Adapted from the template CTA, minus the image parallax: there is no product
// imagery that would be honest here.
export function CTA() {
  return (
    <section className="mx-auto my-10 w-full max-w-7xl px-4 md:my-16 md:px-8">
      <div className="max-w-xl">
        <Heading as="h2" className="text-3xl font-bold tracking-tight text-balance text-black md:text-4xl dark:text-white">
          Read it, run it, or sign a permission yourself.
        </Heading>
        <Subheading className="mt-6 max-w-lg text-base text-neutral-600 md:text-base dark:text-neutral-400">
          The engine, the drills, the transaction hashes and the phase reports are all in one repository. The signing page is a
          bare test harness against the deployed router.
        </Subheading>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="https://github.com/Retainer-org/retainer" target="_blank" rel="noopener noreferrer" className="rounded-md bg-neutral-900 px-6 py-3 text-base font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200">Source on GitHub</Link>
          <Link href="/sign" className="rounded-md bg-white px-6 py-3 text-base font-medium text-neutral-700 ring-1 ring-neutral-200 hover:bg-neutral-50 dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700 dark:hover:bg-neutral-700">Signing harness</Link>
        </div>
      </div>
    </section>
  );
}
