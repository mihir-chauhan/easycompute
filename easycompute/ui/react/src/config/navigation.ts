/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import { Activity, FileText, House, LayoutDashboard, List, Rocket, ScrollText, Server, ShieldCheck, Sparkles, UserCog, Users, Wallet, Workflow, Zap } from 'lucide-react';

import type { ShellNavItem } from '@/components/app/AppShell';

/** Lab-view side nav, grouped like the mockup. Paths must match routes in App.tsx. */
export const labNav = (liveCount?: number): ShellNavItem[] => [
  { path: '/', label: 'Overview', icon: House },
  { path: '/context', label: 'Lab context', icon: FileText, group: 'Before a run' },
  { path: '/policies', label: 'Policies & rules', icon: ShieldCheck, group: 'Before a run' },
  { path: '/plan', label: 'Launch planner', icon: Rocket, group: 'Before a run' },
  { path: '/runs', label: 'Runs', icon: List, group: 'Before a run' },
  {
    path: '/monitor',
    label: 'Live monitor',
    icon: Activity,
    group: 'During a run',
    badge: liveCount ? `${liveCount} live` : undefined,
    badgeTone: 'live',
  },
  { path: '/guardrails', label: 'Guardrails', icon: Zap, group: 'During a run', badge: 'New' },
  { path: '/history', label: 'Allocations & usage', icon: Wallet, group: 'Lab' },
  { path: '/members', label: 'Members & roles', icon: Users, group: 'Lab' },
  { path: '/assistant', label: 'AI Advisor', icon: Sparkles, group: 'Lab' },
];

/** Research Computing side nav (every path under /admin). */
export const ADMIN_NAV: ShellNavItem[] = [
  { path: '/admin', label: 'Overview', icon: LayoutDashboard, group: 'Research Computing' },
  { path: '/admin/clusters', label: 'Clusters', icon: Server, group: 'Research Computing' },
  { path: '/admin/policies', label: 'Policies', icon: ScrollText, group: 'Research Computing' },
  { path: '/admin/labs', label: 'Labs', icon: Users, group: 'Research Computing' },
  { path: '/admin/data', label: 'Data Fusion', icon: Workflow, group: 'Platform' },
  { path: '/admin/users', label: 'Users & roles', icon: UserCog, group: 'Platform' },
];
