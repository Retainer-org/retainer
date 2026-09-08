import './globals.css';

export const metadata = { title: 'Retainer — permission signing (test harness)' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="p-6 font-mono text-sm">{children}</body>
    </html>
  );
}
