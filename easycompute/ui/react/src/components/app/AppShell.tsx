/*
 * EasyCompute design system — application shell (proposal for the integrator to wire into App.tsx).
 *
 *   <AppShellProvider labs={labs} defaultLabId="lab-chen">
 *     <AppShell labNav={LAB_NAV} adminNav={ADMIN_NAV}>
 *       <Routes>...</Routes>
 *     </AppShell>
 *   </AppShellProvider>
 *
 * - Top bar (Purdue black, gold mark): brand, section switch "Lab view | Research Computing", lab switcher
 *   (lab view only, the demo "logged-in" lab), theme toggle.
 * - Side nav lists the active section's pages (section = route starts with /admin).
 * - Responsive: >=1024 labelled 256px nav (collapsible, persisted); 768-1023 48px icon rail; <768 drawer from the
 *   menu button, which also holds the section switch and lab switcher.
 * Pages read the current lab with `useAppShell().labId`.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Building2, Check, ChevronDown, FlaskConical, Menu, Moon, Sun, X, type LucideIcon } from 'lucide-react';

import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SideNavPanelV2, SideNavPanelV2Item } from '@/components/ui/side-nav-panel-v2';
import { TopNavBar } from '@/components/ui/top-nav-bar';
import { DESKTOP_QUERY, PHONE_QUERY, useMediaQuery } from '@/hooks/useMediaQuery';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

/* ------------------------------------------------- context ------------------------------------------------- */

export interface ShellLab {
  id: string;
  name: string;
  piName?: string;
  department?: string;
}

export type ShellView = 'lab' | 'admin';

interface AppShellContextValue {
  labs: ShellLab[];
  labId: string | null;
  lab: ShellLab | null;
  setLabId: (id: string) => void;
  view: ShellView;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);
const LAB_KEY = 'easycompute.labId';
const NAV_KEY = 'easycompute.nav.expanded';

const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStored = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked (private mode); the choice still holds for this session.
  }
};

/** Holds the demo "logged-in" lab (persisted per browser) and derives the section from the route. */
export function AppShellProvider({ labs, defaultLabId, children }: { labs: ShellLab[]; defaultLabId?: string; children: ReactNode }) {
  const location = useLocation();
  const [labId, setLabIdState] = useState<string | null>(() => readStored(LAB_KEY) ?? defaultLabId ?? null);

  // Once labs load, make sure the stored id still exists.
  useEffect(() => {
    if (labs.length === 0) return;
    if (!labId || !labs.some((l) => l.id === labId)) setLabIdState(defaultLabId && labs.some((l) => l.id === defaultLabId) ? defaultLabId : labs[0].id);
  }, [labs, labId, defaultLabId]);

  const setLabId = useCallback((id: string) => {
    setLabIdState(id);
    writeStored(LAB_KEY, id);
  }, []);

  const value = useMemo<AppShellContextValue>(
    () => ({
      labs,
      labId,
      lab: labs.find((l) => l.id === labId) ?? null,
      setLabId,
      view: location.pathname.startsWith('/admin') ? 'admin' : 'lab',
    }),
    [labs, labId, setLabId, location.pathname],
  );
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

/** Current lab + section. Safe outside the provider (returns an empty shell) so pages render in isolation. */
export function useAppShell(): AppShellContextValue {
  const ctx = useContext(AppShellContext);
  return ctx ?? { labs: [], labId: null, lab: null, setLabId: () => undefined, view: 'lab' };
}

/* -------------------------------------------------- pieces -------------------------------------------------- */

export interface ShellNavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

const BrandMark = (
  <svg viewBox="0 0 24 24" aria-hidden="true" role="img" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" />
    <path d="M7.5 15.5h3m-3-3.5h6m-6-3.5h9" stroke="#111" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const SECTIONS: Array<{ view: ShellView; label: string; short: string; icon: LucideIcon; home: string }> = [
  { view: 'lab', label: 'Lab view', short: 'Lab', icon: FlaskConical, home: '/' },
  { view: 'admin', label: 'Research Computing', short: 'RCAC', icon: Building2, home: '/admin' },
];

/** Segmented switch between the two halves of the app. `tone="dark"` on the black bar, `light` in the drawer. */
function SectionSwitch({ tone }: { tone: 'dark' | 'light' }) {
  const { view } = useAppShell();
  const navigate = useNavigate();
  return (
    <div
      role="tablist"
      aria-label="App section"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md p-0.5',
        tone === 'dark' ? 'bg-white/10' : 'bg-[var(--c3-style-basic-bg-secondary)]',
      )}
    >
      {SECTIONS.map((s) => {
        const active = s.view === view;
        return (
          <button
            key={s.view}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => !active && navigate(s.home)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-[5px] px-3 text-[13px] font-medium whitespace-nowrap transition-colors',
              tone === 'dark'
                ? active
                  ? 'bg-[var(--ec-shell-gold)] text-[#17150f]'
                  : 'text-[var(--ec-shell-bar-muted)] hover:text-[var(--ec-shell-bar-fg)]'
                : active
                  ? 'bg-[var(--c3-style-basic-bg-primary)] text-[var(--c3-style-basic-fg-primary)] shadow-sm'
                  : 'text-[var(--c3-style-basic-fg-secondary)]',
            )}
          >
            <s.icon className="size-3.5" aria-hidden />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

/** Lab switcher (demo login). */
function LabSwitcher({ tone }: { tone: 'dark' | 'light' }) {
  const { labs, lab, setLabId, labId } = useAppShell();
  if (labs.length === 0) return null;
  return (
    <DropdownMenu align="end">
      <DropdownMenuTrigger>
        <button
          type="button"
          aria-label="Switch lab"
          className={cn(
            'inline-flex h-8 max-w-56 min-w-0 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium',
            tone === 'dark'
              ? 'text-[var(--ec-shell-bar-fg)] hover:bg-[var(--ec-shell-bar-hover)]'
              : 'w-full border border-[var(--c3-style-basic-border-border)] text-[var(--c3-style-basic-fg-primary)]',
          )}
        >
          <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-[var(--ec-shell-gold)] text-[10px] font-bold text-[#17150f]">
            {(lab?.name ?? '?').replace(/^(The )?/, '').charAt(0)}
          </span>
          <span className="min-w-0 truncate">{lab?.name ?? 'Select lab'}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuLabel>Signed in as lab (demo)</DropdownMenuLabel>
      {labs.map((l) => (
        <DropdownMenuItem
          key={l.id}
          value={l.id}
          label={l.name}
          subLabel={l.piName ? `PI ${l.piName}` : l.department}
          trailingIcon={l.id === labId ? <Check /> : undefined}
          onSelect={() => setLabId(l.id)}
        />
      ))}
    </DropdownMenu>
  );
}

/* --------------------------------------------------- shell --------------------------------------------------- */

interface AppShellProps {
  labNav: ShellNavItem[];
  adminNav: ShellNavItem[];
  children: ReactNode;
}

export default function AppShell({ labNav, adminNav, children }: AppShellProps) {
  const { view } = useAppShell();
  const { currentTheme, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [expanded, setExpanded] = useState(() => readStored(NAV_KEY) !== 'false');
  const [railExpanded, setRailExpanded] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => writeStored(NAV_KEY, String(expanded)), [expanded]);
  useEffect(() => setDrawerOpen(false), [location.pathname]);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const items = view === 'admin' ? adminNav : labNav;
  // Longest matching path wins ("/admin/clusters/x" selects Clusters, not Overview).
  const active =
    items
      .filter((i) => (i.path === '/' || i.path === '/admin' ? location.pathname === i.path : location.pathname === i.path || location.pathname.startsWith(`${i.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? '';

  const ThemeIcon = currentTheme === 'dark' ? Sun : Moon;

  const panel = (isExpanded: boolean, onExpandedChange: (v: boolean) => void, className: string) => (
    <SideNavPanelV2
      expanded={isExpanded}
      onExpandedChange={onExpandedChange}
      value={active}
      onValueChange={(path) => navigate(path)}
      className={className}
      aria-label={view === 'admin' ? 'Research Computing navigation' : 'Lab navigation'}
    >
      {items.map((item) => (
        <SideNavPanelV2Item
          key={item.path}
          value={item.path}
          icon={<item.icon />}
          label={item.label}
          trailing={
            item.badge ? (
              <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--c3-style-basic-bg-danger)] px-1.5 text-[11px] font-semibold text-[var(--c3-style-basic-fg-danger)]">
                {item.badge}
              </span>
            ) : undefined
          }
        />
      ))}
    </SideNavPanelV2>
  );

  const surface = 'shrink-0 border-r border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)]';
  const iconBtn =
    'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--ec-shell-bar-muted)] hover:bg-[var(--ec-shell-bar-hover)] hover:text-[var(--ec-shell-bar-fg)]';

  return (
    <div className="flex h-screen max-w-full flex-col overflow-hidden">
      <TopNavBar
        className="ec-shellbar gap-3"
        logo={
          <span className="flex items-center gap-2">
            {isPhone ? (
              <button type="button" aria-label="Open navigation" className={iconBtn} onClick={() => setDrawerOpen(true)}>
                <Menu className="size-4" />
              </button>
            ) : null}
            {BrandMark}
          </span>
        }
        appName={
          <span className="flex items-baseline gap-2">
            EasyCompute
            <span className="hidden text-xs font-normal text-[var(--ec-shell-bar-muted)] xl:inline">Purdue Research Computing</span>
          </span>
        }
        center={isPhone ? undefined : <SectionSwitch tone="dark" />}
        actions={
          <>
            {view === 'lab' && !isPhone ? <LabSwitcher tone="dark" /> : null}
            <button type="button" aria-label={`Switch to ${currentTheme === 'dark' ? 'light' : 'dark'} mode`} className={iconBtn} onClick={toggleTheme}>
              <ThemeIcon className="size-4" />
            </button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        {isPhone ? null : isDesktop ? panel(expanded, setExpanded, surface) : panel(railExpanded, setRailExpanded, surface)}
        <main className="min-w-0 flex-1 overflow-auto bg-[var(--c3-style-basic-bg-page)]">{children}</main>
      </div>

      {isPhone && drawerOpen ? (
        <div className="app-drawer fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Navigation">
          <button type="button" aria-label="Close navigation" className="app-drawer__backdrop absolute inset-0" onClick={() => setDrawerOpen(false)} />
          <div className="app-drawer__panel relative flex h-full w-[280px] max-w-[85vw] flex-col gap-3 bg-[var(--c3-style-basic-bg-primary)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">EasyCompute</span>
              <button
                type="button"
                aria-label="Close navigation"
                className="inline-flex size-8 items-center justify-center rounded-md hover:bg-[var(--c3-style-basic-bg-secondary)]"
                onClick={() => setDrawerOpen(false)}
              >
                <X className="size-4" />
              </button>
            </div>
            <SectionSwitch tone="light" />
            {view === 'lab' ? <LabSwitcher tone="light" /> : null}
            <div className="-mx-3 min-h-0 flex-1">{panel(true, () => setDrawerOpen(false), 'h-full w-full! border-r-0!')}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
