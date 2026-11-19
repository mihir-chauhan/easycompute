/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import {
  Activity,
  BookOpenText,
  Building2,
  ChartColumn,
  FlaskConical,
  LayoutDashboard,
  Rocket,
  Scale,
  Server,
  Sparkles,
} from 'lucide-react';

import { NavigationItem, NavSection } from '@/types/navigation';

/**
 * Navigation for both shell views. The SideNav lists only the items of the current view
 * ({@link sectionForPath}); the TopNav role toggle switches views. Paths must match routes in App.tsx.
 */
export const navigationConfig: NavigationItem[] = [
  { id: 'lab-home', path: '/', icon: LayoutDashboard, label: 'Lab Home', tooltip: 'Lab overview', section: 'lab' },
  { id: 'lab-context', path: '/context', icon: BookOpenText, label: 'Lab Context', tooltip: 'What makes this lab unique', section: 'lab' },
  { id: 'plan', path: '/plan', icon: Rocket, label: 'Plan a Run', tooltip: 'Check rules and get launch plans', section: 'lab' },
  { id: 'runs', path: '/runs', icon: Activity, label: 'Live Runs', tooltip: 'Monitor running jobs', section: 'lab' },
  { id: 'history', path: '/history', icon: ChartColumn, label: 'History & Insights', tooltip: 'Past usage and efficiency', section: 'lab' },
  { id: 'assistant', path: '/assistant', icon: Sparkles, label: 'AI Advisor', tooltip: 'Ask the compute advisor', section: 'lab' },
  { id: 'admin', path: '/admin', icon: Building2, label: 'University Overview', tooltip: 'Purdue-wide compute', section: 'admin' },
  { id: 'admin-clusters', path: '/admin/clusters', icon: Server, label: 'Clusters & Partitions', tooltip: 'Clusters and partitions', section: 'admin' },
  { id: 'admin-policies', path: '/admin/policies', icon: Scale, label: 'Policies', tooltip: 'Rule catalog', section: 'admin' },
  { id: 'admin-labs', path: '/admin/labs', icon: FlaskConical, label: 'Labs', tooltip: 'Labs and budget burn', section: 'admin' },
];

/** Default landing path of each view. */
export const SECTION_HOME: Record<NavSection, string> = { lab: '/', admin: '/admin' };

/** `/admin` and everything below it is the Research Computing view; every other path is the lab view. */
export const sectionForPath = (pathname: string): NavSection =>
  pathname === '/admin' || pathname.startsWith('/admin/') ? 'admin' : 'lab';
