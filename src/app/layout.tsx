import type { Metadata } from "next";
import { Baloo_2, Figtree, Geist_Mono } from "next/font/google";
import "./globals.css";

// Ike's rebrand type (kickoff §5f, locked decision 4): free Google-Font
// stand-ins for the licensed brand faces — Baloo 2 for the rounded display
// letterforms, Figtree for body/UI. Official faces can swap in later by
// changing only these loaders.
const balooDisplay = Baloo_2({
  variable: "--font-baloo",
  subsets: ["latin"],
  weight: ["700", "800"],
});

const figtreeSans = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Employee Performance Platform",
  description: "Internal employee performance reporting dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${balooDisplay.variable} ${figtreeSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
