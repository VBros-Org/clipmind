import type { ReactNode } from "react";
import Link from "next/link";

import styles from "./app-shell.module.css";

export type AppTab = "home" | "upload" | "review" | "rhythm";

type AppShellProps = {
  activeTab: AppTab;
  reviewCount: number;
  children: ReactNode;
};

const tabs: Array<{
  id: AppTab;
  label: string;
  href: string;
}> = [
  { id: "home", label: "Home", href: "/home" },
  { id: "upload", label: "Upload", href: "/upload" },
  { id: "review", label: "Review", href: "/review" },
  { id: "rhythm", label: "Rhythm", href: "/rhythm" },
];

export function AppShell({ activeTab, reviewCount, children }: AppShellProps) {
  return (
    <main className={styles.screen}>
      <div className={styles.content}>{children}</div>
      <nav
        className={styles.tabBar}
        aria-label="App tabs"
        data-testid="bottom-tab-bar"
      >
        <div className={styles.tabList}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`${styles.tab} ${isActive ? styles.activeTab : ""}`}
                href={tab.href}
                key={tab.id}
              >
                <span className={styles.iconWrap}>
                  <TabIcon id={tab.id} />
                  {tab.id === "review" && reviewCount > 0 ? (
                    <span className={styles.badge}>{badgeLabel(reviewCount)}</span>
                  ) : null}
                </span>
                <span className={styles.label}>{tab.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </main>
  );
}

function badgeLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

function TabIcon({ id }: { id: AppTab }) {
  const commonProps = {
    className: styles.icon,
    fill: "none",
    height: "24",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: "2",
    viewBox: "0 0 24 24",
    width: "24",
    "aria-hidden": true,
  };

  if (id === "home") {
    return (
      <svg {...commonProps}>
        <path d="M3 11.5 12 4l9 7.5" />
        <path d="M5 10.5V20h5v-5h4v5h5v-9.5" />
      </svg>
    );
  }

  if (id === "upload") {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8" />
        <path d="M8 12h8" />
      </svg>
    );
  }

  if (id === "review") {
    return (
      <svg {...commonProps}>
        <path d="M7 7h12v10H7z" />
        <path d="M5 9H4v10h12v-1" />
        <path d="m12 10 4 2.5-4 2.5z" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
    </svg>
  );
}
