'use client';

import MapView from '@/components/MapView';

export default function Home() {
  return (
    <main className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--panel)] px-4 py-2">
        <div>
          <h1 className="text-base font-semibold tracking-tight">
            eta-lab <span className="text-[var(--muted)]">· Berlin dinner rush</span>
          </h1>
          <p className="text-xs text-[var(--muted)]">
            Naive vs smart courier assignment &amp; ETA on real roads — reproducible numbers
          </p>
        </div>
        <nav className="text-xs text-[var(--muted)]">methodology · github</nav>
      </header>
      <div className="flex min-h-0 flex-1">
        <MapView className="min-h-0 flex-1" />
        <aside className="w-[360px] shrink-0 border-l border-[var(--line)] bg-[var(--panel)] p-4">
          <p className="text-sm text-[var(--muted)]">Panel placeholder — engine lands next.</p>
        </aside>
      </div>
    </main>
  );
}
