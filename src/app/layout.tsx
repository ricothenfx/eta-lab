import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'eta-lab — why are food deliveries late?',
  description:
    'Naive vs smart courier assignment and ETA, on a real Berlin road network. Every BEFORE/AFTER number is reproducible.',
};

const themeScript = `(function(){var t;try{t=localStorage.getItem('eta-lab-theme')}catch(e){}if(t!=='dark'&&t!=='light')t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t)})()`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
