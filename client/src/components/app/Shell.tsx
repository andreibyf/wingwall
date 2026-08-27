import { Link, useLocation } from "wouter";
import type { ReactNode } from "react";
import { WingwallLogo } from "./Logo";
import { LayoutGrid, LineChart, Flag, BookText } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/builder", label: "Builder", icon: LineChart },
  { href: "/campaign", label: "Campaign", icon: Flag },
  { href: "/journal", label: "Journal", icon: BookText },
];

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground md:grid-cols-[220px_1fr] md:grid-rows-[auto_1fr]">
      <aside className="hidden border-r border-sidebar-border bg-sidebar overflow-y-auto [overscroll-behavior:contain] md:row-span-2 md:flex md:flex-col">
        <div className="flex items-center gap-2 px-5 py-5">
          <WingwallLogo className="h-6 w-6 text-primary" />
          <span className="text-base font-bold tracking-tight text-sidebar-foreground">Wingwall</span>
        </div>
        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((item) => {
            const active = location === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`link-nav-${item.label.toLowerCase()}`}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium hover-elevate",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto px-5 py-4 text-xs text-muted-foreground">
          Defined-risk desk
          <br />
          Butterfly Trading
        </div>
      </aside>
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:col-start-2 md:px-6">
        <div className="flex items-center gap-2 md:hidden">
          <WingwallLogo className="h-5 w-5 text-primary" />
          <span className="text-sm font-bold tracking-tight text-foreground">Wingwall</span>
        </div>
        <h1 className="text-sm font-semibold text-foreground">
          {NAV.find((n) => n.href === location)?.label ?? "Wingwall"}
        </h1>
      </header>
      <main className="col-start-1 overflow-y-auto pb-20 [overscroll-behavior:contain] px-4 py-6 md:col-start-2 md:px-6 md:pb-6">
        {children}
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-10 flex items-stretch justify-around border-t border-sidebar-border bg-sidebar md:hidden">
        {NAV.map((item) => {
          const active = location === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={`link-nav-mobile-${item.label.toLowerCase()}`}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium",
                active ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/60"
              )}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
