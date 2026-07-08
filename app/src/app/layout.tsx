import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { NavSidebar } from "@/components/nav-sidebar";
import { ServiceWorkerRegister } from "@/components/sw-register";
import { LightboxProvider } from "@/components/lightbox";
import { OwnerProvider } from "@/components/owner-context";
import { getOwnerName } from "@/lib/config";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "aiTeam",
  description: "Control center for your aiTeam — a persistent multi-agent AI team",
  manifest: "/manifest.webmanifest",
  applicationName: "aiTeam",
  appleWebApp: {
    capable: true,
    title: "aiTeam",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#282828",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full flex flex-col">
        <OwnerProvider owner={getOwnerName()}>
        <LightboxProvider>
          <div className="pwa-titlebar" aria-hidden="true" />
          {/* Mobile top bar — only visible on small screens. The NavSidebar renders
              the hamburger button itself (fixed-position); this bar provides the
              app title and safe spacing so page content isn't hidden behind the button. */}
          <div className="md:hidden flex items-center gap-3 px-4 h-12 bg-cards-bg border-b border-border shrink-0">
            {/* Spacer reserving room for the fixed hamburger button at left-3 */}
            <div className="w-10 shrink-0" aria-hidden="true" />
            <span className="text-sm font-semibold tracking-tight">aiTeam</span>
          </div>
          <div className="flex flex-1 min-h-0">
            <NavSidebar />
            <main className="flex-1 flex flex-col min-w-0">{children}</main>
          </div>
          <ServiceWorkerRegister />
        </LightboxProvider>
        </OwnerProvider>
      </body>
    </html>
  );
}
