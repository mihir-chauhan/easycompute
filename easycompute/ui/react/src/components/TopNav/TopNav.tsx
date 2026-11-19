/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';

import { TopNavBar } from '@/components/ui/top-nav-bar';

/** A single tab in the {@link TopNav} section-navigation strip. */
export interface TopNavTab {
  title: string;
  path: string;
}

/** The square C3 logomark (`currentColor`, so it follows the theme). Swap it for your own brand mark. */
const C3Logo = (
  <svg viewBox="0 0 72 72" fill="currentColor" aria-hidden="true" role="img">
    <polygon points="0,0 0,8 64,8 64,32 16,32 16,40 64,40 64,64 0,64 0,72 72,72 72,0" />
    <polygon points="56,48 8,48 8,24 56,24 56,16 0,16 0,56 56,56" />
  </svg>
);

interface TopNavProps {
  /** Application (or section) name shown at the far left of the bar. */
  title?: string;
  /** Brand mark in the bar's 20px logo slot; `null` hides it. */
  logo?: React.ReactNode;
  /** Optional section-navigation tabs rendered in the bar's center slot. */
  tabs?: TopNavTab[];
  /** Optional right-aligned actions (icon buttons, avatar, …). */
  actions?: React.ReactNode;
  /** Opens the side-nav drawer; the menu button is shown only at phone width (below 768px). */
  onMenuClick?: () => void;
}

/**
 * Application top bar, built on the C3 Design System {@link TopNavBar}. At phone width it shows a menu button
 * left of the logo that opens the side-nav drawer.
 */
export default function TopNav({ title, logo = C3Logo, tabs, actions, onMenuClick }: TopNavProps) {
  const location = useLocation();
  const hasTabs = Boolean(tabs && tabs.length > 0);

  const brand = onMenuClick ? (
    <span className="flex items-center gap-2">
      <button
        type="button"
        aria-label="Open navigation"
        className="app-menu-button inline-flex size-8 items-center justify-center rounded-[var(--c3-style-border-radius-6)] text-[var(--c3-style-basic-fg-primary)] hover:bg-[var(--c3-style-basic-bg-secondary)] md:hidden"
        onClick={onMenuClick}
      >
        <Menu />
      </button>
      {logo}
    </span>
  ) : (
    logo
  );

  return (
    <TopNavBar
      logo={brand}
      appName={title}
      actions={actions}
      center={
        hasTabs && tabs ? (
          <nav className="flex flex-wrap items-center gap-4" aria-label="Section navigation">
            {tabs.map((tab) => {
              const active = location.pathname === tab.path;
              return (
                <Link
                  key={tab.path}
                  to={tab.path}
                  aria-current={active ? 'page' : undefined}
                  className={
                    active
                      ? 'text-c3-bold-label-l2 border-b-2 border-[var(--c3-style-basic-border-accent)] pb-1 text-[var(--c3-style-basic-fg-primary)]'
                      : 'text-c3-regular-label-l2 border-b-2 border-transparent pb-1 text-[var(--c3-style-basic-fg-neutral)] hover:text-[var(--c3-style-basic-fg-primary)]'
                  }
                >
                  {tab.title}
                </Link>
              );
            })}
          </nav>
        ) : undefined
      }
    />
  );
}
