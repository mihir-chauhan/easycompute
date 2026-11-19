/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';

import { SideNavPanelV2, SideNavPanelV2Item } from '@/components/ui/side-nav-panel-v2';
import { DESKTOP_QUERY, PHONE_QUERY, useMediaQuery } from '@/hooks/useMediaQuery';
import { useTheme } from '@/hooks/useTheme';
import { navigationConfig, sectionForPath } from '@/config/navigation';
import { NavigationItem } from '@/types/navigation';

// Key under which the desktop sidebar expanded/collapsed state is persisted so it survives a refresh.
const SIDENAV_EXPANDED_KEY = 'c3.sidenav.expanded';

const readStoredExpanded = (): boolean => {
  try {
    const stored = window.localStorage.getItem(SIDENAV_EXPANDED_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    // localStorage can be unavailable (private mode, blocked cookies).
    return true;
  }
};

interface SideNavProps {
  /** Phone width only: whether the navigation drawer is open (opened from the TopNav menu button). */
  mobileOpen?: boolean;
  /** Phone width only: closes the drawer (backdrop click, Escape, or navigation). */
  onMobileClose?: () => void;
}

/**
 * Application left navigation, built on the C3 Design System {@link SideNavPanelV2} and driven by
 * {@link navigationConfig}. Responsive:
 * - at 1024px and wider it is the 256px labeled panel (collapsible, choice persisted);
 * - from 768px to 1023px it is the 48px icon rail (it can be expanded for the session);
 * - below 768px it is hidden and opens as an overlay drawer from the TopNav menu button, closing on navigation.
 * The theme toggle lives in the panel footer.
 */
export default function SideNav({ mobileOpen = false, onMobileClose }: SideNavProps) {
  const { currentTheme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [expanded, setExpanded] = useState<boolean>(readStoredExpanded);
  const [railExpanded, setRailExpanded] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDENAV_EXPANDED_KEY, String(expanded));
    } catch {
      // Ignore storage failures; the toggle still works for this session.
    }
  }, [expanded]);

  // Close the phone drawer on every route change.
  useEffect(() => {
    onMobileClose?.();
  }, [location.pathname, onMobileClose]);

  // Escape closes the phone drawer.
  useEffect(() => {
    if (!isPhone || !mobileOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onMobileClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPhone, mobileOpen, onMobileClose]);

  const isActiveRoute = (item: NavigationItem): boolean => {
    if (item.path === '/') {
      return location.pathname === '/';
    }
    return location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
  };

  // Only the current view's items (lab view or Research Computing view).
  const section = sectionForPath(location.pathname);
  const items = navigationConfig.filter((item) => item.section === section);

  // Longest matching path wins, so `/sites/map` selects "Sites Map" rather than "Sites".
  const activeItem = items
    .filter(isActiveRoute)
    .sort((a, b) => b.path.length - a.path.length)[0];
  const activeValue = activeItem?.path ?? '';

  const ThemeIcon = currentTheme === 'dark' ? Sun : Moon;

  const panel = (isExpanded: boolean, onExpandedChange: (next: boolean) => void, className: string) => (
    <SideNavPanelV2
      expanded={isExpanded}
      onExpandedChange={onExpandedChange}
      value={activeValue}
      onValueChange={(path) => navigate(path)}
      className={className}
      footer={
        <SideNavPanelV2Item
          value="__theme-toggle"
          icon={<ThemeIcon />}
          label={`${currentTheme === 'dark' ? 'Light' : 'Dark'} mode`}
          onClick={(event) => {
            // An action, not a route: toggle the theme and keep the selection.
            event.preventDefault();
            toggleTheme();
          }}
        />
      }
    >
      {items.map((item) => (
        <SideNavPanelV2Item
          key={item.id}
          value={item.path}
          icon={<item.icon />}
          label={item.label}
          disabled={item.disabled}
          trailing={
            item.badge ? (
              <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--c3-style-basic-bg-danger-inverse)] px-1 text-[11px] font-medium text-[var(--c3-style-basic-fg-inverse)]">
                {item.badge}
              </span>
            ) : undefined
          }
        />
      ))}
    </SideNavPanelV2>
  );

  const surface = 'shrink-0 border-r border-[var(--c3-style-basic-border-border)] bg-[var(--c3-style-basic-bg-primary)]';

  if (isPhone) {
    if (!mobileOpen) return null;
    return (
      <div className="app-drawer fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Navigation">
        <button type="button" aria-label="Close navigation" className="app-drawer__backdrop absolute inset-0" onClick={onMobileClose} />
        <div className="app-drawer__panel relative h-full">
          {panel(true, () => onMobileClose?.(), `${surface} h-full`)}
        </div>
      </div>
    );
  }

  return isDesktop ? panel(expanded, setExpanded, surface) : panel(railExpanded, setRailExpanded, surface);
}
