import type { Metadata, Viewport } from "next";
import { Host_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import RegisterSW, { OfflineBanner } from "@/components/pwa/register-sw";
import { Toaster } from "@/components/ui/kit";

const sans = Host_Grotesk({ variable: "--font-host", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-jbmono", subsets: ["latin"], display: "swap", weight: ["400", "500"] });

export const metadata: Metadata = {
  title: { default: "T2T Student Portal", template: "%s · T2T" },
  description: "T2T student payments and operations.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#1f3038", width: "device-width", initialScale: 1, interactiveWidget: "resizes-content" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-radius="sharp" className={`${sans.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full bg-bg text-ink font-sans">
        <OfflineBanner />
        {children}
        <RegisterSW />
        <Toaster />
      </body>
    </html>
  );
}
