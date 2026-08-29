import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fire Growth Tracker",
  description:
    "California wildfire starts, active incidents, CAL OES evacuations, perimeters, satellite imagery, and saved growth history.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
