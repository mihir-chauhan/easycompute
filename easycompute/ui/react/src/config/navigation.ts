/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import { Activity, BookOpenText, ChartColumn, LayoutDashboard, Rocket, ScrollText, Server, Sparkles, Users } from 'lucide-react';

import type { ShellNavItem } from '@/components/app/AppShell';

/** Side nav of the Lab view. Paths must match routes in App.tsx. */
export const LAB_NAV: ShellNavItem[] = [
  { path: '/', label: 'Lab Home', icon: LayoutDashboard },
  { path: '/plan', label: 'Plan a Run', icon: Rocket },
  { path: '/runs', label: 'Live Runs', icon: Activity },
  { path: '/history', label: 'History & Insights', icon: ChartColumn },
  { path: '/context', label: 'Lab Context', icon: BookOpenText },
  { path: '/assistant', label: 'AI Advisor', icon: Sparkles },
];

/** Side nav of the Research Computing view (every path under /admin). */
export const ADMIN_NAV: ShellNavItem[] = [
  { path: '/admin', label: 'Overview', icon: LayoutDashboard },
  { path: '/admin/clusters', label: 'Clusters', icon: Server },
  { path: '/admin/policies', label: 'Policies', icon: ScrollText },
  { path: '/admin/labs', label: 'Labs', icon: Users },
];
