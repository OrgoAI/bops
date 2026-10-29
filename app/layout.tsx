import type { Metadata } from "next";
import { Geist, Geist_Mono, Poppins } from "next/font/google";
import { BRAND } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// A partner's build in its own type (lib/brand.ts): Momentum AMP sets everything in Poppins.
const poppins = Poppins({
  variable: "--font-brand",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-brand={BRAND.id}
      className={`${geistSans.variable} ${geistMono.variable} ${BRAND.id === "momentum" ? poppins.variable : ""} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
