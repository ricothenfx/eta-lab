export const metadata = {
  title: 'Methodology — eta-lab',
  description: 'How the BEFORE/AFTER numbers are produced and why they are reproducible.',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <div className="space-y-2 text-[15px] leading-relaxed text-[#33404d]">{children}</div>
    </section>
  );
}

export default function MethodologyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <a href="/" className="text-sm text-[var(--accent)] underline">
        ← back to the lab
      </a>
      <h1 className="mb-1 mt-4 text-3xl font-bold tracking-tight">Methodology</h1>
      <p className="mb-8 text-[var(--muted)]">
        Every number in eta-lab is produced by the code in the repository and can be re-run with
        one command: <code className="rounded bg-gray-100 px-1">npm run bench -- --recorded</code>.
      </p>

      <Section title="What the two runs are">
        <p>
          Both runs execute the <b>same seeded order set</b> on the <b>same real road network</b>
          (OSRM on OpenStreetMap data, Berlin). Couriers drive real roads with identical speed
          assumptions. Only two things differ:
        </p>
        <p>
          <b>BEFORE (naive)</b> — assigns the idle courier with the smallest <i>straight-line</i>{' '}
          distance to the restaurant, ignoring rivers, parks and one-way streets. When nobody is
          idle it waits FIFO for the next free courier. The customer gets a naive ETA: straight
          lines at a constant 25 km/h plus a flat 10-minute kitchen guess.
        </p>
        <p>
          <b>AFTER (smart)</b> — assigns by <i>real road travel time</i> (OSRM table), including
          couriers that are still finishing their previous job (planned chaining). The customer ETA
          is road-aware: pickup ride overlaps kitchen prep (whoever comes later wins), then the
          delivery ride, plus a 2-minute operational buffer.
        </p>
      </Section>

      <Section title="Determinism">
        <p>
          Order arrivals, restaurants, customers, kitchen prep times and per-leg traffic noise are
          drawn from a seeded PRNG (mulberry32). Route durations come from OSRM; the exact values
          used for the published numbers are frozen in{' '}
          <code className="rounded bg-gray-100 px-1">public/data/recorded-routes.json</code>, so{' '}
          <code className="rounded bg-gray-100 px-1">npm run bench -- --recorded</code> reproduces
          the published tables byte-for-byte, offline. Re-running against live OSRM may shift
          numbers slightly when the road graph is updated upstream — the reports record the
          provider and date of each run.
        </p>
      </Section>

      <Section title="Metric definitions">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <b>Pickup wait</b> — order placed → courier picks up the food (includes dispatch wait
            and kitchen prep).
          </li>
          <li>
            <b>Delivery</b> — order placed → food at the customer&apos;s door.
          </li>
          <li>
            <b>ETA error</b> — actual delivery time − promised time; reported as MAE and p95 of
            the absolute error. <b>Late</b> — actual delivery later than the promise.
          </li>
          <li>
            <b>Deadhead km</b> — kilometres ridden without food (courier → restaurant), summed and
            divided by orders.
          </li>
        </ul>
      </Section>

      <Section title="What is modelled, what is not">
        <ul className="list-disc space-y-1 pl-5">
          <li>Kitchen prep and road traffic are randomised per order with a realistic spread — both modes get the same draws.</li>
          <li>Couriers start at real Berlin squares and stay in the district they last delivered to.</li>
          <li>Not modelled: weather, handover frictions beyond 1 minute, batching (two orders per trip) — batching is a separate, larger lever we deliberately left out of scope.</li>
          <li>Venue names are synthetic; coordinates sit on real streets. No real personal data is used.</li>
        </ul>
      </Section>

      <Section title="Stack">
        <p>
          Next.js (App Router) · TypeScript · MapLibre GL with the free OpenFreeMap Liberty
          basemap · OSRM public routing with an offline recorded snapshot · deterministic engine
          in plain TypeScript shared between the browser app and the Node benchmark script ·
          deployed on Vercel.
        </p>
      </Section>
    </main>
  );
}
