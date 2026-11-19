/*
 * EasyCompute design system — application shell in the owner's "Gantry" layout (input/gantry-mockups).
 *
 *   <AppShellProvider labs={labs} defaultLabId="...">
 *     <AppShell labNav={LAB_NAV} adminNav={ADMIN_NAV}>
 *       <Routes>...</Routes>
 *     </AppShell>
 *   </AppShellProvider>
 *
 * - Announcement strip (dismissible), 52px top bar: logo + EasyCompute, workspace switcher (avatar, lab name,
 *   "Lab admin" pill; the menu also switches to the Research Computing view), "/", cluster scope ("all clusters"),
 *   Search ⌘K (command palette), Cluster health dot, Budget pill, alerts bell, settings, avatar.
 * - 256px sidebar grouped by `ShellNavItem.group` ("Before a run", "During a run", "Lab", ...), green active
 *   item, badges ("2 live", "New"), footer with allocation meters (lab view). Below 768px the sidebar becomes a
 *   horizontal scroll strip under the top bar.
 * - Dark only by design: the shell pins `dark` on <html>.
 * Pages read the current lab with `useAppShell().labId` and the cluster scope with `useAppShell().clusterId`.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeftRight, Bell, Building2, Check, ChevronDown, Lock, Search, Settings, Wallet, X, type LucideIcon } from 'lucide-react';

import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { c3Call } from '@/c3Action';
import { getLabSummary, getUniversityOverview, setDemoUser } from '@/features/admin/api';
import type { LabSummaryLite, UniversityOverview } from '@/features/admin/types';
import { cn } from '@/lib/utils';

import { ProgressBar } from './ProgressBar';
import { ROLE_LABEL, ROLE_SHORT, roleCan, type EcRole, type Permission } from './roles';
import { burnTone, type Tone } from './tone';

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
  /** Cluster scope from the top bar ("all clusters" = null). */
  clusterId: string | null;
  setClusterId: (id: string | null) => void;
  /** Demo role (avatar menu): drives nav, access and page actions. */
  role: EcRole;
  setRole: (role: EcRole) => void;
  can: (permission: Permission) => boolean;
  /** Demo signed-in person for the role: the lab's PI, a student of the lab, or RCAC staff. */
  user: ShellUser | null;
}

export interface ShellUser {
  id: string;
  name: string;
  username: string;
  /** LabMember.role (PI, POSTDOC, STUDENT, STAFF) or 'RCAC' for university admins. */
  memberRole: string;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);
const LAB_KEY = 'easycompute.labId';
const BANNER_KEY = 'easycompute.banner.dismissed';
const ROLE_KEY = 'easycompute.role';
const RCAC_USER: ShellUser = { id: 'rcac-admin', name: 'RCAC staff (demo)', username: 'rcac-admin', memberRole: 'RCAC' };

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

/** Holds the demo "logged-in" lab (persisted per browser), the cluster scope, and derives the view from the route. */
export function AppShellProvider({ labs, defaultLabId, children }: { labs: ShellLab[]; defaultLabId?: string; children: ReactNode }) {
  const location = useLocation();
  const [labId, setLabIdState] = useState<string | null>(() => readStored(LAB_KEY) ?? defaultLabId ?? null);
  const [clusterId, setClusterId] = useState<string | null>(null);
  const [role, setRoleState] = useState<EcRole>(() => {
    const r = readStored(ROLE_KEY);
    return r === 'PI' || r === 'MEMBER' || r === 'UNIVERSITY_ADMIN' ? r : 'UNIVERSITY_ADMIN';
  });
  const [members, setMembers] = useState<Array<{ id: string; name: string; username: string; role: string }>>([]);
  const setRole = useCallback((r: EcRole) => {
    setRoleState(r);
    writeStored(ROLE_KEY, r);
  }, []);

  // Members of the current lab, to pick the demo signed-in person for the role.
  useEffect(() => {
    if (!labId) return undefined;
    let cancelled = false;
    c3Call('LabMember', 'fetch', null, [{ include: 'id, name, username, role', filter: `lab.id == '${labId.replace(/'/g, '')}'`, order: 'name', limit: 100, offset: 0 }])
      .then((res: { objs?: Array<{ id: string; name: string; username: string; role: string }> }) => !cancelled && setMembers(res?.objs ?? []))
      .catch(() => !cancelled && setMembers([]));
    return () => {
      cancelled = true;
    };
  }, [labId]);

  useEffect(() => {
    if (labs.length === 0) return;
    if (!labId || !labs.some((l) => l.id === labId)) setLabIdState(defaultLabId && labs.some((l) => l.id === defaultLabId) ? defaultLabId : labs[0].id);
  }, [labs, labId, defaultLabId]);

  const setLabId = useCallback((id: string) => {
    setLabIdState(id);
    writeStored(LAB_KEY, id);
  }, []);

  // Server-side enforcement follows the demo identity (UserAdmin.setDemoUser; AppUser id = LabMember id).
  const demoUserId = role === 'UNIVERSITY_ADMIN' ? null : (role === 'PI' ? members.find((x) => x.role === 'PI') : members.find((x) => x.role === 'STUDENT') ?? members.find((x) => x.role === 'POSTDOC'))?.id ?? null;
  useEffect(() => {
    if (role !== 'UNIVERSITY_ADMIN' && !demoUserId) return;
    void setDemoUser(demoUserId);
  }, [role, demoUserId]);

  const value = useMemo<AppShellContextValue>(
    () => ({
      labs,
      labId,
      lab: labs.find((l) => l.id === labId) ?? null,
      setLabId,
      view: location.pathname.startsWith('/admin') ? 'admin' : 'lab',
      clusterId,
      setClusterId,
      role,
      setRole,
      can: (p: Permission) => roleCan(role, p),
      user: (() => {
        if (role === 'UNIVERSITY_ADMIN') return RCAC_USER;
        const m = role === 'PI' ? members.find((x) => x.role === 'PI') : members.find((x) => x.role === 'STUDENT') ?? members.find((x) => x.role === 'POSTDOC');
        return m ? { id: m.id, name: m.name, username: m.username, memberRole: m.role } : null;
      })(),
    }),
    [labs, labId, setLabId, location.pathname, clusterId, role, setRole, members],
  );
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

/** Current lab, view and cluster scope. Safe outside the provider (returns an empty shell). */
export function useAppShell(): AppShellContextValue {
  const ctx = useContext(AppShellContext);
  return (
    ctx ?? {
      labs: [],
      labId: null,
      lab: null,
      setLabId: () => undefined,
      view: 'lab',
      clusterId: null,
      setClusterId: () => undefined,
      role: 'UNIVERSITY_ADMIN',
      setRole: () => undefined,
      can: () => true,
      user: null,
    }
  );
}

/* -------------------------------------------------- types -------------------------------------------------- */

export interface ShellNavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Sidebar group heading ("Before a run", "During a run", "Lab"). Items without a group render at the top. */
  group?: string;
  /** Number -> red count; string -> pill text ("2 live", "New"). */
  badge?: number | string;
  /** Pill style for a string badge: 'live' (green) | 'new' (blue). Default 'new'. */
  badgeTone?: 'live' | 'new';
  /** Hide from the sidebar (still matched for the active state, e.g. detail routes). */
  hidden?: boolean;
  /** Roles that see this item (default: all). */
  roles?: EcRole[];
}

/* -------------------------------------------------- pieces -------------------------------------------------- */

/** EasyCompute mark (four tiles, green), after the mockup logo. */
export const BrandMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 28 28" aria-hidden="true" className={cn('size-[26px] shrink-0', className)}>
    <rect x="2" y="2" width="11" height="11" rx="2.5" fill="var(--ec-accent-hi)" />
    <rect x="15" y="2" width="11" height="11" rx="2.5" fill="none" stroke="var(--ec-accent-hi)" strokeWidth="2" />
    <rect x="2" y="15" width="11" height="11" rx="2.5" fill="none" stroke="var(--ec-accent-hi)" strokeWidth="2" />
    <rect x="15" y="15" width="11" height="11" rx="2.5" fill="var(--ec-accent-hi)" opacity=".55" />
  </svg>
);

const initials = (name?: string | null) =>
  (name ?? '?')
    .replace(/^(The|Lab)\s+/i, '')
    .split(/\s+/)
    .slice(0, 1)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');

const Avatar = ({ text, size = 24, className }: { text: string; size?: 24 | 28; className?: string }) => (
  <span
    aria-hidden
    className={cn(
      'grid shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,#8b7cf6,#c06bd6)] text-xs font-semibold text-white',
      size === 24 ? 'size-6' : 'size-7',
      className,
    )}
  >
    {text}
  </span>
);

const topBtn = 'inline-flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-sm font-medium whitespace-nowrap text-[var(--ec-fg)] hover:bg-[var(--ec-card)]';
const iconBtn = 'grid size-8 shrink-0 place-items-center rounded-lg text-[var(--ec-fg-2)] hover:bg-[var(--ec-card)] hover:text-[var(--ec-fg-hi)] [&_svg]:size-4';

/** Workspace switcher: lab (lab view) or "Purdue Research Computing" (admin view). The menu switches both. */
function WorkspaceSwitcher() {
  const { labs, lab, labId, setLabId, view, role } = useAppShell();
  const navigate = useNavigate();
  const name = view === 'admin' ? 'research-computing' : lab?.name ?? 'Select lab';
  const pill = view === 'admin' ? ROLE_SHORT.UNIVERSITY_ADMIN : ROLE_SHORT[role];
  return (
    <DropdownMenu align="start">
      <DropdownMenuTrigger>
        <button type="button" aria-label="Switch lab or view" className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--ec-card)]">
          {view === 'admin' ? (
            <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--ec-blue-bg)] text-[var(--ec-blue)] [&_svg]:size-3.5">
              <Building2 />
            </span>
          ) : (
            <Avatar text={initials(lab?.name)} />
          )}
          <span className="min-w-0 truncate text-[15px] font-medium text-[var(--ec-fg-hi)] md:text-base">{name}</span>
          <span
            className={cn(
              'hidden rounded-full px-2 text-xs leading-[18px] whitespace-nowrap sm:inline',
              view === 'admin' ? 'bg-[var(--ec-blue-bg)] text-[var(--ec-blue)]' : 'bg-[var(--ec-pink-bg)] text-[var(--ec-pink)]',
            )}
          >
            {pill}
          </span>
          <ChevronDown className="size-4 shrink-0 text-[var(--ec-fg-2)]" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuLabel>Labs (demo sign-in)</DropdownMenuLabel>
      {labs.map((l) => (
        <DropdownMenuItem
          key={l.id}
          value={l.id}
          label={l.name}
          subLabel={l.piName ? `PI ${l.piName}` : l.department}
          trailingIcon={view === 'lab' && l.id === labId ? <Check /> : undefined}
          onSelect={() => {
            setLabId(l.id);
            if (view === 'admin') navigate('/');
          }}
        />
      ))}
      {role === 'UNIVERSITY_ADMIN' ? <DropdownMenuSeparator /> : null}
      {role === 'UNIVERSITY_ADMIN' ? (
      <DropdownMenuItem
        value="__view"
        label={view === 'admin' ? 'Back to lab view' : 'Research Computing view'}
        subLabel={view === 'admin' ? undefined : 'University-wide clusters, cost, fairness'}
        leftIcon={<ArrowLeftRight />}
        onSelect={() => navigate(view === 'admin' ? '/' : '/admin')}
      />
      ) : null}
    </DropdownMenu>
  );
}

/** Cluster scope ("all clusters"). */
function ClusterScope({ clusters }: { clusters: Array<{ id: string; name: string }> }) {
  const { clusterId, setClusterId } = useAppShell();
  const current = clusters.find((c) => c.id === clusterId);
  return (
    <DropdownMenu align="start">
      <DropdownMenuTrigger>
        <button type="button" aria-label="Cluster scope" className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-base font-medium whitespace-nowrap text-[var(--ec-fg-hi)] hover:bg-[var(--ec-card)]">
          {current?.name ?? 'all clusters'}
          <ChevronDown className="size-4 text-[var(--ec-fg-2)]" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuItem value="__all" label="all clusters" trailingIcon={!clusterId ? <Check /> : undefined} onSelect={() => setClusterId(null)} />
      {clusters.map((c) => (
        <DropdownMenuItem key={c.id} value={c.id} label={c.name} trailingIcon={c.id === clusterId ? <Check /> : undefined} onSelect={() => setClusterId(c.id)} />
      ))}
    </DropdownMenu>
  );
}

/** ⌘K command palette over every page and lab. */
function CommandPalette({ open, onClose, items }: { open: boolean; onClose: () => void; items: Array<{ key: string; label: string; hint?: string; run: () => void }> }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const list = useMemo(() => items.filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 12), [items, q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  if (!open) return null;
  const pick = (i: number) => {
    const it = list[i];
    if (it) {
      it.run();
      onClose();
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search">
      <button type="button" aria-label="Close search" className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-[var(--ec-line-2)] bg-[var(--ec-card)] shadow-2xl">
        <div className="flex items-center gap-2 border-b border-[var(--ec-line)] px-3">
          <Search className="size-4 text-[var(--ec-fg-3)]" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => Math.min(list.length - 1, i + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter') pick(idx);
            }}
            placeholder="Jump to a page or lab…"
            aria-label="Search pages and labs"
            className="h-12 flex-1 bg-transparent text-[15px] text-[var(--ec-fg-hi)] outline-none placeholder:text-[var(--ec-fg-3)] focus-visible:outline-none"
          />
          <span className="rounded bg-[var(--ec-card-2)] px-1.5 text-[11px] text-[#bababa]">esc</span>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5" role="listbox" aria-label="Results">
          {list.length === 0 ? <li className="px-3 py-6 text-center text-sm text-[var(--ec-fg-2)]">No matches</li> : null}
          {list.map((it, i) => (
            <li key={it.key} role="option" aria-selected={i === idx}>
              <button
                type="button"
                onMouseEnter={() => setIdx(i)}
                onClick={() => pick(i)}
                className={cn('flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm', i === idx ? 'bg-[var(--ec-accent-bg)] text-[var(--ec-fg-hi)]' : 'text-[var(--ec-fg)]')}
              >
                <span className="truncate">{it.label}</span>
                {it.hint ? <span className="shrink-0 text-xs text-[var(--ec-fg-3)]">{it.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const ROLES: EcRole[] = ['UNIVERSITY_ADMIN', 'PI', 'MEMBER'];
const ROLE_AVATAR: Record<EcRole, string> = { UNIVERSITY_ADMIN: 'R', PI: 'P', MEMBER: 'S' };

/** Avatar menu with the demo role switcher (University Admin / PI / Student). */
function RoleMenu({ role, setRole, userName }: { role: EcRole; setRole: (r: EcRole) => void; userName?: string }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu align="end">
      <DropdownMenuTrigger>
        <button type="button" aria-label={`Account and demo role: ${ROLE_LABEL[role]}`} className="rounded-full focus-visible:outline-2">
          <Avatar text={ROLE_AVATAR[role]} size={28} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuLabel>{userName ? `${userName} · ${ROLE_LABEL[role]}` : ROLE_LABEL[role]}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Demo role</DropdownMenuLabel>
      {ROLES.map((r) => (
        <DropdownMenuItem
          key={r}
          value={`role-${r}`}
          label={ROLE_LABEL[r]}
          trailingIcon={r === role ? <Check /> : undefined}
          onSelect={() => {
            setRole(r);
            if (r !== 'UNIVERSITY_ADMIN' && window.location.hash.startsWith('#/admin')) navigate('/');
          }}
        />
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem value="__members" label={role === 'MEMBER' ? 'Lab members' : 'Users & roles'} onSelect={() => navigate(role === 'UNIVERSITY_ADMIN' ? '/admin/users' : '/members')} />
    </DropdownMenu>
  );
}

/** Shown on Research Computing pages for roles without access. */
function AccessNotice({ role, onSwitch }: { role: EcRole; onSwitch: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-[var(--ec-card-2)] text-[var(--ec-fg-2)]">
        <Lock className="size-5" aria-hidden />
      </span>
      <p className="m-0 text-base font-medium text-[var(--ec-fg-hi)]">Research Computing is for University Admins</p>
      <p className="m-0 max-w-md text-sm text-[var(--ec-fg-2)]">
        You are signed in as {ROLE_LABEL[role]}. University dashboards, clusters, data pipelines and user management need the RCAC staff role.
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={() => navigate('/')} className="inline-flex h-[34px] items-center rounded-md border border-[var(--ec-line-2)] px-3 text-sm font-medium hover:bg-[var(--ec-card)]">
          Back to my lab
        </button>
        <button type="button" onClick={onSwitch} className="inline-flex h-[34px] items-center rounded-md bg-[var(--ec-accent-hi)] px-3 text-sm font-medium text-[#132010] hover:bg-[#95f37e]">
          Switch demo role to Admin
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------- shell --------------------------------------------------- */

interface AppShellProps {
  labNav: ShellNavItem[];
  adminNav: ShellNavItem[];
  /** Announcement strip text; `null` hides it. Default: the Gautschi Nov 2 scheduler update. */
  banner?: ReactNode | null;
  children: ReactNode;
}

const DEFAULT_BANNER = 'Gautschi scheduler update (Nov 2): GPU shares now follow each lab’s semester usage. EasyCompute re-planned queued runs.';

interface Meter {
  label: string;
  value: string;
  frac: number;
  tone: Tone;
}

const elapsedOf = (start?: string, end?: string): number | null => {
  if (!start || !end) return null;
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return Number.isNaN(s) || Number.isNaN(e) || e <= s ? null : Math.max(0, Math.min(1, (Date.now() - s) / (e - s)));
};

export default function AppShell({ labNav, adminNav, banner = DEFAULT_BANNER, children }: AppShellProps) {
  const { view, labId, labs, setLabId, role, setRole, user } = useAppShell();
  const location = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(() => readStored(BANNER_KEY) === '1');
  const [overview, setOverview] = useState<UniversityOverview | null>(null);
  const [summary, setSummary] = useState<LabSummaryLite | null>(null);

  // Dark only, by design; load Fira Mono for code/ids/times (the template ships Inter only).
  useEffect(() => {
    document.documentElement.classList.add('dark');
    if (!document.getElementById('ec-fira-mono')) {
      const link = document.createElement('link');
      link.id = 'ec-fira-mono';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Fira+Mono:wght@400;500&display=swap';
      document.head.appendChild(link);
    }
  }, []);

  // Shell data: cluster health + scope list (university overview), lab budget + meters (lab summary).
  useEffect(() => {
    let cancelled = false;
    getUniversityOverview()
      .then((o) => !cancelled && setOverview(o))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!labId) return undefined;
    let cancelled = false;
    getLabSummary(labId)
      .then((s) => !cancelled && setSummary(s))
      .catch(() => !cancelled && setSummary(null));
    return () => {
      cancelled = true;
    };
  }, [labId, location.pathname]);

  // ⌘K / Ctrl+K opens the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = view === 'admin' ? (role === 'UNIVERSITY_ADMIN' ? adminNav : []) : labNav;
  const active =
    items
      .filter((i) => (i.path === '/' || i.path === '/admin' ? location.pathname === i.path : location.pathname === i.path || location.pathname.startsWith(`${i.path}/`)))
      .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? '';

  const groups = useMemo(() => {
    const out: Array<{ name: string | null; items: ShellNavItem[] }> = [];
    items
      .filter((i) => !i.hidden && (!i.roles || i.roles.includes(role)))
      .forEach((i) => {
        const name = i.group ?? null;
        const g = out.find((x) => x.name === name);
        if (g) g.items.push(i);
        else out.push({ name, items: [i] });
      });
    return out;
  }, [items]);

  const health: Tone = !overview
    ? 'neutral'
    : overview.clusters.some((c) => c.status === 'DEGRADED') || overview.kpis.criticalAlerts > 0
      ? overview.kpis.criticalAlerts > 2
        ? 'bad'
        : 'warn'
      : 'good';
  const budgetUsd = summary?.allocations?.reduce((s, a) => s + (a.remainingUsd ?? 0), 0);
  const meters: Meter[] = (summary?.allocations ?? []).slice(0, 2).map((a) => {
    const frac = a.totalUnits ? a.usedUnits / a.totalUnits : 0;
    const unit = a.unitName === 'GPU-hour' ? 'GPU-hrs' : a.unitName === 'SU' ? 'SUs' : a.unitName ?? '';
    return {
      label: `${a.clusterName ?? a.clusterId} ${unit}${a.source === 'ACCESS' ? ' (ACCESS)' : ''}`,
      value: a.unitName === 'SU' || a.unitName === 'USD' ? `${Math.round(frac * 100)}% used` : `${Math.round(a.usedUnits).toLocaleString('en-US')} / ${Math.round(a.totalUnits).toLocaleString('en-US')}`,
      frac,
      tone: burnTone(frac, elapsedOf(a.startDate, a.endDate)),
    };
  });
  const openAlerts = view === 'admin' ? overview?.kpis.openAlerts ?? 0 : summary?.kpis.openAlerts ?? 0;

  const paletteItems = useMemo(
    () => [
      ...labNav.filter((i) => !i.hidden && (!i.roles || i.roles.includes(role))).map((i) => ({ key: `l${i.path}`, label: i.label, hint: 'Lab view', run: () => navigate(i.path) })),
      ...adminNav.filter((i) => !i.hidden && role === 'UNIVERSITY_ADMIN').map((i) => ({ key: `a${i.path}`, label: i.label, hint: 'Research Computing', run: () => navigate(i.path) })),
      ...labs.map((l) => ({
        key: `lab-${l.id}`,
        label: l.name,
        hint: 'Switch lab',
        run: () => {
          setLabId(l.id);
          navigate('/');
        },
      })),
      ...(overview?.clusters ?? []).map((c) => ({ key: `c-${c.id}`, label: c.name, hint: 'Cluster', run: () => navigate(`/admin/clusters/${c.id}`) })),
    ],
    [labNav, adminNav, labs, overview, navigate, setLabId, role],
  );

  const navLink = (item: ShellNavItem, target: string = item.path) => {
    const on = item.path === active;
    return (
      <button
        key={item.path}
        type="button"
        onClick={() => navigate(target)}
        aria-current={on ? 'page' : undefined}
        className={cn(
          'flex h-9 shrink-0 items-center gap-3 rounded-md px-2 text-left text-sm font-medium whitespace-nowrap',
          on ? 'bg-[var(--ec-accent-bg)] text-[var(--ec-fg-hi)]' : 'text-[var(--ec-fg)] hover:bg-[var(--ec-card)]',
        )}
      >
        <item.icon className={cn('size-4 shrink-0', on ? 'text-[var(--ec-accent-hi)]' : 'text-[var(--ec-fg-2)]')} aria-hidden />
        <span className="truncate">{item.label}</span>
        {item.badge != null && item.badge !== 0 ? (
          typeof item.badge === 'number' ? (
            <span className="ml-auto rounded-full bg-[var(--ec-crit-bg)] px-[7px] text-[11px] leading-[18px] text-[var(--ec-crit-fg)]">{item.badge}</span>
          ) : (
            <span
              className={cn(
                'ml-auto rounded-full px-[7px] text-[11px] leading-[18px]',
                item.badgeTone === 'live' ? 'border border-[var(--ec-accent-line)] bg-[var(--ec-accent-bg)] text-[var(--ec-accent-text)]' : 'bg-[var(--ec-blue-bg)] text-[var(--ec-blue)]',
              )}
            >
              {item.badge}
            </span>
          )
        ) : null}
      </button>
    );
  };

  return (
    <div className="flex h-screen max-w-full flex-col overflow-hidden bg-[var(--ec-bg)] text-[var(--ec-fg)]">
      {banner && !bannerHidden ? (
        <div className="relative shrink-0 border-b border-[var(--ec-line)] bg-[var(--ec-strip)] px-10 py-2 text-center text-xs font-medium text-[var(--ec-accent-text)]">
          {banner}
          <button type="button" className="ml-3 text-[var(--ec-fg-hi)] hover:underline" onClick={() => navigate('/admin/policies')}>
            Learn more →
          </button>
          <button
            type="button"
            aria-label="Dismiss announcement"
            className="absolute top-1/2 right-3 -translate-y-1/2 rounded p-0.5 text-[var(--ec-fg-3)] hover:text-[var(--ec-fg-hi)]"
            onClick={() => {
              setBannerHidden(true);
              writeStored(BANNER_KEY, '1');
            }}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <header className="z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-[var(--ec-line)] bg-[var(--ec-bar)] pr-4 pl-4 md:pl-5">
        <button type="button" onClick={() => navigate(view === 'admin' ? '/admin' : '/')} className="mr-1 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-[var(--ec-fg-hi)] md:mr-3.5">
          <BrandMark />
          <span className="hidden sm:inline">EasyCompute</span>
        </button>
        <WorkspaceSwitcher />
        <span className="hidden text-xl font-light text-[var(--ec-fg-3)] md:inline">/</span>
        <span className="hidden md:inline-flex">
          <ClusterScope clusters={(overview?.clusters ?? []).filter((c) => c.status !== 'MAINTENANCE').map((c) => ({ id: c.id, name: c.name }))} />
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" className={cn(topBtn, 'hidden lg:inline-flex')} onClick={() => setPaletteOpen(true)}>
            <Search className="size-4" aria-hidden />
            Search
            <span className="rounded bg-[var(--ec-card-2)] px-1.5 text-[11px] font-medium text-[#bababa]">⌘K</span>
          </button>
          <button type="button" className={cn(topBtn, 'hidden md:inline-flex')} onClick={() => navigate('/admin/clusters')} title="Cluster health">
            <span
              aria-hidden
              className={cn(
                'inline-block size-[7px] rounded-full',
                health === 'good' ? 'bg-[var(--ec-accent-hi)]' : health === 'warn' ? 'bg-[var(--ec-warn)]' : health === 'bad' ? 'bg-[var(--ec-bad)]' : 'bg-[var(--ec-fg-3)]',
              )}
            />
            <span className="hidden xl:inline">Cluster health</span>
          </button>
          {view === 'lab' ? (
            <button type="button" className={topBtn} onClick={() => navigate('/history')} title="Grant compute remaining">
              <Wallet className="size-4" aria-hidden />
              <span className="hidden sm:inline">Budget</span>
              <span className="rounded-full bg-[var(--ec-card-2)] px-2 text-xs leading-5 tabular-nums">
                {budgetUsd != null ? budgetUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—'}
              </span>
            </button>
          ) : null}
          <button type="button" className={cn(iconBtn, 'relative hidden sm:grid')} aria-label={`${openAlerts} open alerts`} onClick={() => navigate(view === 'admin' ? '/admin/labs' : '/runs')}>
            <Bell />
            {openAlerts > 0 ? <span aria-hidden className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[var(--ec-bad)]" /> : null}
          </button>
          <button type="button" className={cn(iconBtn, 'hidden sm:grid')} aria-label="Lab settings" onClick={() => navigate('/context')}>
            <Settings />
          </button>
          <RoleMenu role={role} setRole={setRole} userName={user?.name} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label={view === 'admin' ? 'Research Computing navigation' : 'Lab navigation'}
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-[var(--ec-line)] px-4 py-2 md:w-64 md:flex-col md:overflow-y-auto md:border-r md:border-b-0 md:p-3"
        >
          {groups.map((g, gi) => (
            <React.Fragment key={g.name ?? `_${gi}`}>
              {g.name ? <h6 className="mx-2 mt-3.5 mb-1.5 hidden text-xs font-medium text-[var(--ec-fg-2)] md:block">{g.name}</h6> : null}
              {g.items.map((i) => navLink(i))}
            </React.Fragment>
          ))}
          {role === 'UNIVERSITY_ADMIN' || view === 'admin' ? (
            <>
              <h6 className="mx-2 mt-3.5 mb-1.5 hidden text-xs font-medium text-[var(--ec-fg-2)] md:block">{view === 'admin' ? 'Lab' : 'University'}</h6>
              {navLink(
                { path: '__switch', label: view === 'admin' ? 'Back to lab view' : 'Research Computing', icon: view === 'admin' ? ArrowLeftRight : Building2 },
                view === 'admin' ? '/' : '/admin',
              )}
            </>
          ) : null}

          {view === 'lab' && meters.length > 0 ? (
            <div className="mt-auto hidden flex-col gap-2.5 border-t border-[var(--ec-line)] px-2 pt-3 pb-1 text-xs text-[var(--ec-fg-2)] md:flex">
              {meters.map((m) => (
                <div key={m.label} className="flex flex-col gap-2">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">{m.label}</span>
                    <span className="shrink-0 tabular-nums text-[var(--ec-fg-hi)]">{m.value}</span>
                  </div>
                  <ProgressBar value={m.frac} tone={m.tone === 'good' ? 'accent' : m.tone} ariaLabel={`${m.label}: ${m.value}`} />
                </div>
              ))}
            </div>
          ) : null}
        </nav>
        <main className="min-w-0 flex-1 overflow-auto bg-[var(--ec-bg)]">
          {view === 'admin' && role !== 'UNIVERSITY_ADMIN' ? <AccessNotice role={role} onSwitch={() => setRole('UNIVERSITY_ADMIN')} /> : children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={paletteItems} />
    </div>
  );
}
