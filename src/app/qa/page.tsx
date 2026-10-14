import Link from 'next/link';
import type { ReactNode } from 'react';
import ThemeToggle from '@/components/ThemeToggle';

export const metadata = {
  title: 'Q&A — eta-lab',
  description:
    'The questions reviewers ask about eta-lab: dispatch rules, ETA modelling, determinism, and honest limitations — answered.',
};

interface Qa {
  q: string;
  a: ReactNode;
}

const NON_TECHNICAL: Qa[] = [
  {
    q: 'What does eta-lab do, in one sentence?',
    a: (
      <>
        It replays a Berlin dinner rush twice on the same real road network — once with naive
        courier dispatch and naive ETAs, once with road-aware ones — and shows exactly what better
        decision logic does to lateness, ETA accuracy and wasted kilometres.
      </>
    ),
  },
  {
    q: 'What am I actually looking at on the map?',
    a: (
      <>
        Real Berlin streets (OpenStreetMap via MapLibre). Orange dots are restaurants, coloured
        dots are orders (yellow = waiting for a courier, blue = kitchen cooking, purple = on the
        way, faded green = delivered), and red/green dots are couriers — red for the naive run,
        green for the smart run. Blue lines are pickup rides, purple lines are delivery rides.
        Press play or scrub the slider to replay the rush minute by minute.
      </>
    ),
  },
  {
    q: 'What exactly is BEFORE vs AFTER?',
    a: (
      <>
        Both runs drive the <b>same real roads</b> with the <b>same seeded orders</b>, the same
        couriers, the same kitchen prep times and the same traffic noise. Only the decision logic
        differs. <b>BEFORE (naive)</b> sends the idle courier with the smallest straight-line
        distance — ignoring rivers, parks and one-way streets — and promises the customer a naive
        ETA (straight lines at 25 km/h plus a flat 10-minute kitchen guess). <b>AFTER (smart)</b>{' '}
        picks by real road travel time, can chain a courier who is still finishing the previous
        job, and promises a road-aware ETA where cooking overlaps the pickup ride.
      </>
    ),
  },
  {
    q: 'How big is the improvement, honestly?',
    a: (
      <>
        On the three published seeds (recorded snapshot, see <code className="rounded bg-[var(--chip)] px-1">reports/</code>):
        seed 7 cuts late deliveries from 46% to 22%, seed 42 cuts the average ETA error from 7.0
        to 2.5 minutes (−64%) and wasted “deadhead” kilometres per order by a third. Every delta
        is green on every seed and every metric — not because the lab was tuned to win, but
        because road distance is the thing the naive rule throws away.
      </>
    ),
  },
  {
    q: 'What does “late” mean here, and what is an “ETA error”?',
    a: (
      <>
        “Late” means the food arrived at the customer&apos;s door after the promised time. The
        ETA error is actual delivery time minus the promised time; the lab reports its mean
        absolute error (MAE) and the p95 of the absolute error, so you see typical accuracy and
        the worst-case tail — not just averages.
      </>
    ),
  },
  {
    q: 'What is “deadhead km” and why should anyone care?',
    a: (
      <>
        Kilometres ridden <em>without food</em> — the empty trip from the courier&apos;s current
        spot to the restaurant. It is pure cost: unpaid time for the rider, lost capacity for the
        platform. Naive straight-line dispatch systematically underestimates that trip (rivers and
        one-ways make the road longer than the crow flies), which is exactly why the smart rule
        cuts it by roughly a third.
      </>
    ),
  },
  {
    q: 'Is this real data?',
    a: (
      <>
        The road network is real — OpenStreetMap routing (OSRM) over actual Berlin streets, with
        one-way restrictions and real geometry. The demand is simulated: venue names are
        synthetic, coordinates sit on real streets, and no real personal data is used anywhere.
        Orders, prep times and traffic noise come from a seeded random generator, so experiments
        are repeatable.
      </>
    ),
  },
  {
    q: 'Do I need an account? Where does my data go?',
    a: (
      <>
        No account, no login, no database. The whole simulation runs in your browser; the only
        network calls are road routing against the public OSRM demo server (cached in your
        browser&apos;s localStorage, with an offline snapshot as fallback) and the optional AI
        explainer, which sends nothing but the aggregated BEFORE/AFTER numbers you already see on
        screen. Change the seed, re-run, export JSON — nothing about you is stored server-side.
      </>
    ),
  },
  {
    q: 'Why did my numbers change slightly between visits or devices?',
    a: (
      <>
        Same seed always produces the same orders and decisions — but when the app routes
        <b> live</b> against the public OSRM server, the road graph may have been updated upstream
        since your last visit, so durations can shift slightly. The published numbers avoid this
        entirely: they use a frozen snapshot of route durations, and{' '}
        <code className="rounded bg-[var(--chip)] px-1">npm run bench -- --recorded</code>{' '}
        reproduces them offline, byte-for-byte. If the app can&apos;t reach OSRM at all, it shows
        the “offline mode” banner and falls back to the same snapshot.
      </>
    ),
  },
  {
    q: 'What does the seed do? Why is there a 🎲 button?',
    a: (
      <>
        The seed drives the random generator that creates the scenario: order arrivals,
        restaurants, customers, prep times and per-leg noise. Run seed 7 twice and you get the
        identical rush twice — that is what makes BEFORE vs AFTER fair and the results
        auditable. The 🎲 button picks a random seed so you can stress-test the conclusion on
        scenarios nobody hand-picked: the smart mode wins on every seed tried so far.
      </>
    ),
  },
  {
    q: 'What is the “✨ Explain with AI” button doing?',
    a: (
      <>
        It sends the metrics table you already see to a serverless function, which asks an LLM to
        write a short plain-English operations summary of those numbers. The AI never computes
        anything — it narrates what the deterministic engine produced, and its prompt is
        explicitly told not to invent figures beyond the table. Without an API key configured the
        button simply reports that AI is not available; the lab works fully without it.
      </>
    ),
  },
]

const TECHNICAL: Qa[] = [
  {
    q: 'What stack is this built with — and why this stack?',
    a: (
      <>
        <b>Next.js (App Router) + TypeScript</b> for the app, <b>MapLibre GL</b> with the free
        OpenFreeMap Liberty basemap, <b>OSRM</b> for road routing and travel-time tables, and{' '}
        <b>Vercel</b> for hosting. The simulation engine is plain TypeScript with zero runtime
        dependencies, shared verbatim between the browser app and the Node benchmark script — the
        exact code that draws the map computes the published tables. No database, no state
        library, no chart library: nothing that would add complexity without removing any.
      </>
    ),
  },
  {
    q: 'How is every number reproducible?',
    a: (
      <>
        Three layers. (1) A seeded PRNG (mulberry32) generates arrivals, venues, prep times and
        traffic noise — the same seed yields the identical scenario and decisions. (2) Route
        durations used for the published tables are frozen in{' '}
        <code className="rounded bg-[var(--chip)] px-1">public/data/recorded-routes.json</code>, so{' '}
        <code className="rounded bg-[var(--chip)] px-1">npm run bench -- --recorded</code>{' '}
        reproduces the reports offline, byte-for-byte. (3) The E2E test drives the real app in
        headless Chrome and asserts the UI shows the exact numbers from{' '}
        <code className="rounded bg-[var(--chip)] px-1">reports/</code>. If engine and evidence
        ever drift apart, the test suite fails instead of the claim.
      </>
    ),
  },
  {
    q: 'Why OSRM — isn’t straight-line distance “good enough”?',
    a: (
      <>
        Straight-line distance being wrong <em>is the experiment</em>. Berlin has the Spree, the
        Landwehrkanal, the Tiergarten and thousands of one-way streets; crow-flies nearest-courier
        rules silently ride through all of them. OSRM&apos;s table service gives real road travel
        times between many points at once, which is precisely the signal the naive rule discards —
        so the BEFORE/AFTER gap measures the value of that signal alone.
      </>
    ),
  },
  {
    q: 'How does the comparison stay fair?',
    a: (
      <>
        Both modes consume the identical seeded order set, identical couriers, identical kitchen
        prep draws and identical per-leg traffic noise — the RNG stream is shared, not restarted
        per mode. The only code paths that differ are the courier-choice rule and the customer ETA
        model. That isolation is deliberate: if everything else is held constant, the delta table
        measures the decision logic and nothing else.
      </>
    ),
  },
  {
    q: 'What is the smart ETA formula?',
    a: (
      <>
        For AFTER: <code className="rounded bg-[var(--chip)] px-1">promise = max(kitchen prep, pickup ride) + delivery ride + 2 min buffer</code>.
        The <code className="rounded bg-[var(--chip)] px-1">max</code> is the operational reality
        the naive model misses — cooking and the courier&apos;s ride to the restaurant happen in
        parallel, so whoever finishes later sets the departure. BEFORE promises{' '}
        <code className="rounded bg-[var(--chip)] px-1">straight-line/25 km/h + flat 10 min</code>,
        which double-punishes long real roads: it dispatches the wrong courier <em>and</em> quotes
        a time the road cannot deliver.
      </>
    ),
  },
  {
    q: 'Why can AFTER assign a courier who is still busy?',
    a: (
      <>
        Planned chaining. When every courier is mid-delivery, a naive FIFO queue idles the fleet;
        the smart rule instead evaluates where each busy courier will be <em>after</em> dropping
        off and picks the one with the smallest road travel time to the next restaurant. Because
        the same engine simulates both modes on the same orders, the win you see in the delta
        table comes from smarter sequencing, not from extra capacity — the fleet size is identical.
      </>
    ),
  },
  {
    q: 'Why no optimization solver or ML dispatching?',
    a: (
      <>
        Because the lab answers one question — what is road-awareness worth compared to the naive
        baseline? — and a solver or learned policy would confound it: you could no longer tell how
        much of the gain is road-awareness versus the optimizer itself. Single-lever comparisons
        are also how operations teams justify changes internally. Batching (two orders per trip)
        is the next big lever and is deliberately out of scope, as stated in the app and README.
      </>
    ),
  },
  {
    q: 'What is modelled, and what is deliberately not?',
    a: (
      <>
        Modelled: real road geometry and travel times, seeded order arrivals, kitchen prep with a
        realistic spread, per-leg traffic noise, couriers who stay in the district they last
        served. Not modelled: weather, rider shifts and breaks, batching, handover frictions
        beyond one minute. Every one of those is another lever; including them would make the
        BEFORE/AFTER gap harder to attribute and the lab harder to audit.
      </>
    ),
  },
  {
    q: 'How is the code tested?',
    a: (
      <>
        <code className="rounded bg-[var(--chip)] px-1">npm run selftest</code> asserts engine
        determinism and sanity invariants; <code className="rounded bg-[var(--chip)] px-1">npm run bench</code>{' '}
        cross-checks the browser engine against the Node harness and refreshes the recorded
        snapshot; <code className="rounded bg-[var(--chip)] px-1">npm run e2e</code> runs headless
        Chrome through the full user journey (map → run → replay → table), fails on any console
        error, and verifies the on-screen numbers match{' '}
        <code className="rounded bg-[var(--chip)] px-1">reports/</code>.
      </>
    ),
  },
  {
    q: 'What happens when the OSRM server is unreachable?',
    a: (
      <>
        The app degrades gracefully: it falls back to the recorded snapshot (or estimates from the
        road graph geometry for unknown pairs) and shows an explicit “offline mode” banner instead
        of silently pretending everything is fine. Route responses are cached in localStorage with
        retry logic, so the public demo server&apos;s fair-use limits don&apos;t break a demo
        mid-replay. A demo that dies behind a paid or rate-limited API is a demo that can&apos;t be
        reviewed.
      </>
    ),
  },
  {
    q: 'How does the AI explainer avoid making things up?',
    a: (
      <>
        Strictly downstream and scoped: the browser posts only the aggregated metrics table and
        scenario metadata to <code className="rounded bg-[var(--chip)] px-1">/api/explain</code>;
        the key lives in a server-side env var and never reaches the client; the prompt demands
        plain English, a word cap, and “do not invent numbers beyond the table”. The client never
        parses the AI output back into the UI — it is displayed as prose, and any API failure
        surfaces as an explicit message. The numbers on screen always come from the deterministic
        engine, never from the LLM.
      </>
    ),
  },
  {
    q: 'How does this relate to your other delivery-ops projects?',
    a: (
      <>
        eta-lab is the evidence-first lab for the dispatch/ETA question: one screen, two runs,
        reproducible deltas. It complements{' '}
        <a className="text-[var(--accent)] underline" href="https://github.com/ricothenfx/lastmile-lab">
          lastmile-lab
        </a>
        , which explores multi-strategy dispatch as a platform, and{' '}
        <a className="text-[var(--accent)] underline" href="https://github.com/ricothenfx/prep-truth">
          prep-truth
        </a>
        , which audits the restaurant-side prep-time promise. Each project isolates one decision
        layer of the same delivery pipeline.
      </>
    ),
  },
]

function QaItem({ qa }: { qa: Qa }) {
  return (
    <details className="group rounded-lg border border-[var(--line)] bg-[var(--panel)]">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-4 font-semibold">
        <span>{qa.q}</span>
        <span
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-[var(--muted)] transition-transform group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <div className="px-4 pb-4 text-sm leading-relaxed text-[var(--ink-soft)]">{qa.a}</div>
    </details>
  );
}

function QaSection({
  id,
  title,
  blurb,
  items,
}: {
  id: string;
  title: string;
  blurb: string;
  items: Qa[];
}) {
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className="text-lg font-bold tracking-tight">
        {title}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">{blurb}</p>
      <div className="mt-4 space-y-2.5">
        {items.map((qa) => (
          <QaItem key={qa.q} qa={qa} />
        ))}
      </div>
    </section>
  );
}

export default function QaPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm text-[var(--accent)] underline">
          ← back to the lab
        </Link>
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/methodology" className="text-[var(--accent)] underline">
            Methodology
          </Link>
          <ThemeToggle />
        </nav>
      </div>
      <h1 className="mb-1 mt-4 text-3xl font-bold tracking-tight">Q&amp;A</h1>
      <p className="max-w-2xl text-[var(--muted)]">
        The questions reviewers actually ask about eta-lab — answered from two seats: an
        operations manager&apos;s and an engineer&apos;s. Every number quoted here is produced by
        the code in the repository and locked by tests.
      </p>

      <QaSection
        id="qa-nontechnical"
        title="For non-technical reviewers"
        blurb="If you run delivery operations, work with couriers, or just want to understand what this lab tells you — start here."
        items={NON_TECHNICAL}
      />
      <QaSection
        id="qa-technical"
        title="For technical reviewers"
        blurb="Stack choices, determinism, the dispatch and ETA models, the AI guardrails and the testing strategy — with the reasoning behind each decision."
        items={TECHNICAL}
      />

      <p className="mt-10 border-t border-[var(--line)] pt-4 text-xs leading-relaxed text-[var(--muted)]">
        Something still unclear? The{' '}
        <a
          className="text-[var(--accent)] underline"
          href="https://github.com/ricothenfx/eta-lab"
          target="_blank"
          rel="noreferrer"
        >
          repository README
        </a>{' '}
        explains how the published numbers are produced — the{' '}
        <Link className="text-[var(--accent)] underline" href="/methodology">
          methodology page
        </Link>{' '}
        covers it in depth.
      </p>
    </main>
  );
}
