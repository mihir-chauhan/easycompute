/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import { useAppShell } from '@/components/app';
import type { Actor } from './types';

/**
 * Role gates for the lab pages (demo role from the shell's avatar menu, see components/app/roles.ts):
 * PIs and RCAC staff approve, edit lab context and guardrails; members plan/submit and act on their own runs.
 */
export function useLabRole() {
  const { role, can, user } = useAppShell();
  const isOwn = (jobUser?: string | null) => Boolean(user && jobUser && user.username === jobUser);
  return {
    role,
    user,
    isMember: role === 'MEMBER',
    canApprove: can('approve_requests'),
    canEditContext: can('manage_lab_context'),
    canEditGuardrails: can('edit_guardrails'),
    /** Act on a run: approvers on any lab run, members only on their own. */
    canActOn: (jobUser?: string | null) => can('approve_requests') || isOwn(jobUser),
    isOwn,
    /** Actor recorded on ActionLogEntry rows. */
    actor: (role === 'UNIVERSITY_ADMIN' ? 'ADMIN' : 'USER') as Actor,
  };
}
