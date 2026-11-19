/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { type ReactNode } from 'react';
import { AlertTriangle, Inbox, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import type { BreadcrumbItemData } from '@/components/ui/breadcrumbs';
import { Spinner } from '@/components/ui/spinner';

interface PageFrameProps {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: BreadcrumbItemData[];
  badges?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  /** One-row filter toolbar rendered between the header and the content (search, filters, result count). */
  toolbar?: ReactNode;
  children: ReactNode;
}

/**
 * Standard page frame (EasyCompute design system): the PageHeader (breadcrumb, 24px semibold title, muted one-line
 * description, actions right) over a content stack; everything is centred at max-width 1440px with 24px padding and
 * 16px gaps (16px gutters on phones). Every page uses it.
 */
export default function PageFrame({ title, description, breadcrumbs, badges, actions, tabs, toolbar, children }: PageFrameProps) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col c3-page-content-enter">
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={breadcrumbs}
        badges={badges}
        actions={actions}
        tabs={tabs}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 pb-8 pt-2 md:px-6">
        {toolbar ? <div className="flex flex-wrap items-center gap-2">{toolbar}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-12 text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-secondary)]">
      <Spinner size="lg" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-sm border border-[var(--c3-style-basic-border-danger)] bg-[var(--c3-style-basic-bg-danger)] p-4 text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-danger)]"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
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
        <div className="flex flex-col items-center gap-2 text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-secondary)]">
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
