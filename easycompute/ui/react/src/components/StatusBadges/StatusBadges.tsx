/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React from 'react';

import { Badge, type BadgeAppearance } from '@/components/ui/badge';

/** Soft badge for an enum value; one style for every enum so status columns read consistently. */
export function EnumBadge({ value, appearance }: { value?: string; appearance?: BadgeAppearance }) {
  if (!value) return <span>—</span>;
  return (
    <Badge variant="soft" appearance={appearance ?? 'secondary'} size="sm" shape="rounded">
      {value}
    </Badge>
  );
}
