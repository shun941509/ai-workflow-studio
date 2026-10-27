import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@studio/ui/tokens.css";
import "./globals.css";
import { AppShell } from "../features/shell/AppShell";

export const metadata: Metadata = { title: "AI Workflow Studio", description: "AI가 일하는 순서를 만들고, 내 도구에서 실행하세요." };

/** The application shell exposes only product navigation; account access uses the profile button. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="ko"><body><a href="#main-content" className="skip-link">본문으로 이동</a><AppShell>{children}</AppShell></body></html>;
}
