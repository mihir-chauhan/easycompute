/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { type ReactNode } from 'react';
import { AlertTriangle, Inbox, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { BreadcrumbItemData } from '@/components/ui/breadcrumbs';
import { Spinner } from '@/components/ui/spinner';

interface PageFrameProps {
  title: ReactNode;
  description?: ReactNode;
  /** All but the last crumb render as a muted "Parent /" prefix inside the title (mockup style). */
  breadcrumbs?: BreadcrumbItemData[];
  /** Pills next to the title. */
  badges?: ReactNode;
  actions?: ReactNode;
  /** Tab strip under the header (use `PageTabs` from components/app). */
  tabs?: ReactNode;
  /** One-row filter toolbar rendered between the header and the content (search, filters, result count). */
  toolbar?: ReactNode;
  children: ReactNode;
}

/**
 * Standard page frame (EasyCompute / "Gantry" design): 24px/500 title with optional muted crumb prefix and pills,
 * 16px description, actions right; content column max-width 1180px with 24px gaps; 28/32px page padding
 * (16px on phones). Every page uses it.
 */
export default function PageFrame({ title, description, breadcrumbs, badges, actions, tabs, toolbar, children }: PageFrameProps) {
  const parents = (breadcrumbs ?? []).slice(0, -1);
  return (
    <div className="px-4 pt-7 pb-12 md:px-8">
      <div className="flex w-full max-w-[1180px] flex-col gap-6">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="m-0 flex flex-wrap items-center gap-2.5 text-2xl leading-8 font-medium tracking-[-0.01em] text-[var(--ec-fg)]">
                {parents.map((c, i) =>
                  c.href ? (
                    <a key={i} href={c.href} className="text-[var(--ec-fg-2)] hover:text-[var(--ec-fg-hi)]">
                      {c.label}
                      <span className="ml-2.5 text-[var(--ec-fg-3)]">/</span>
                    </a>
                  ) : null,
                )}
                <span className="min-w-0 text-[var(--ec-fg-hi)]">{title}</span>
                {badges}
              </h1>
              {description ? <p className="mt-1.5 mb-0 text-base leading-6 text-[var(--ec-fg)]">{description}</p> : null}
            </div>
            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          </div>
          {tabs}
        </div>
        {toolbar ? <div className="flex flex-wrap items-center gap-2.5">{toolbar}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-12 text-sm text-[var(--ec-fg-2)]">
      <Spinner size="lg" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-[#5a302c] bg-[var(--ec-crit-bg)] px-3.5 py-3 text-sm text-[var(--ec-fg)]">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--ec-crit-fg)]" aria-hidden />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <Button variant="outline" appearance="danger" size="sm" leadingIcon={<RotateCw />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Empty table body: icon, message and an optional action (e.g. "Clear filters"). */
export function EmptyRows({ colSpan, label, action }: { colSpan: number; label: string; action?: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center">
        <div className="flex flex-col items-center gap-2 text-sm text-[var(--ec-fg-2)]">
          <Inbox className="size-6" aria-hidden />
          <span>{label}</span>
          {action}
        </div>
      </td>
    </tr>
  );
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unexpected error';
