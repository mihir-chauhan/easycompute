/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Building2, ChevronDown, FlaskConical } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SECTION_HOME, sectionForPath } from '@/config/navigation';
import { fetchLabs } from '@/features/lab/api';
import type { Lab } from '@/features/lab/types';
import { setCurrentLabId, useCurrentLab } from '@/features/lab/useCurrentLab';
import type { NavSection } from '@/types/navigation';

const VIEWS: { section: NavSection; label: string; short: string; icon: typeof Building2 }[] = [
  { section: 'lab', label: 'Lab view', short: 'Lab', icon: FlaskConical },
  { section: 'admin', label: 'Research Computing', short: 'RC', icon: Building2 },
];

/** Segmented role toggle: Lab view vs Research Computing view (each has its own side nav). */
function RoleToggle() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = sectionForPath(location.pathname);
  return (
    <div
      role="radiogroup"
      aria-label="View"
      className="inline-flex items-center rounded-[var(--c3-style-border-radius-6)] border border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-secondary)] p-0.5"
    >
      {VIEWS.map(({ section, label, short, icon: Icon }) => {
        const active = section === current;
        return (
          <button
            key={section}
            type="button"
            role="radio"
            aria-checked={active}
            title={label}
            onClick={() => !active && navigate(SECTION_HOME[section])}
            className={
              'inline-flex h-7 items-center gap-1.5 rounded-[var(--c3-style-border-radius-4)] px-2.5 text-c3-regular-label-l2 transition-colors ' +
              (active
                ? 'bg-[var(--c3-style-basic-bg-primary)] text-[var(--c3-style-basic-fg-primary)] shadow-sm'
                : 'text-[var(--c3-style-basic-fg-neutral)] hover:text-[var(--c3-style-basic-fg-primary)]')
            }
          >
            <Icon className="size-3.5" />
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{short}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Demo "logged-in" lab switcher (lab view only). Writes the shared current-lab state from features/lab. */
function LabSwitcher() {
  const { lab } = useCurrentLab();
  const [labs, setLabs] = React.useState<Lab[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    fetchLabs()
      .then((rows) => {
        if (!cancelled) setLabs(rows);
      })
      .catch(() => {
        /* the lab pages show their own load error */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DropdownMenu align="end">
      <DropdownMenuTrigger>
        <Button variant="outline" appearance="secondary" size="sm" className="max-w-[16rem]" aria-label="Switch lab">
          <FlaskConical className="size-3.5 shrink-0" />
          <span className="truncate">{lab?.name ?? 'Select lab'}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuLabel>Signed in as a member of</DropdownMenuLabel>
      {labs.map((l) => (
        <DropdownMenuItem
          key={l.id}
          value={l.id}
          label={l.name}
          subLabel={[l.piName && `PI ${l.piName}`, l.department].filter(Boolean).join(' · ') || undefined}
          onSelect={() => setCurrentLabId(l.id)}
        />
      ))}
    </DropdownMenu>
  );
}

/** Right side of the TopNav: lab switcher (lab view) + role toggle. */
export default function ShellControls() {
  const location = useLocation();
  return (
    <div className="flex items-center gap-2">
      {sectionForPath(location.pathname) === 'lab' && <LabSwitcher />}
      <RoleToggle />
    </div>
  );
}
