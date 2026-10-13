import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'eta-lab — why are food deliveries late?',
  description:
    'Naive vs smart courier assignment and ETA, on a real Berlin road network. Every BEFORE/AFTER number is reproducible.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
