/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import type { Provenance } from '@/components/app';

/** One tool call recorded during an ask turn (Advisor.Reply.toolCalls). */
export interface ToolCall {
  tool: string;
  args?: string;
  summary?: string;
  ok?: boolean;
  millis?: number | null;
}

/** A source the answer may cite inline as [id] (Advisor.Reply.citations). */
export interface Citation {
  id: string;
  kind: 'DOC' | 'POLICY' | 'LAB' | 'PROJECT' | 'JOB' | 'DATA' | string;
  title: string;
  url?: string | null;
  version?: string;
  severity?: string;
  outcome?: string;
  quote?: string;
}

/** Next-step deep link (Advisor.Reply.links): the user acts on the Launch planner / run page, never in the chat. */
export interface NextLink {
  kind: 'PLAN' | 'RUN' | string;
  label: string;
  title: string;
  href: string;
}

/** Advisor.ask result. */
export interface AdvisorReply {
  answer?: string;
  sessionId?: string;
  runId?: string;
  status?: string;
  mode?: 'agent' | 'offline' | string;
  fallbackReason?: string;
  seconds?: number;
  toolCalls?: ToolCall[];
  citations?: Citation[];
  links?: NextLink[];
  provenance?: Provenance;
}

/** Evidence span: exact quote of the lab text and its character offsets. */
export interface Evidence {
  quote: string;
  start: number;
  end: number;
}

/** Advisor.extractConstraints result (LabContextExtractor). */
export interface LabConstraints {
  component?: string;
  version?: string;
  status: 'UNCONFIRMED' | 'CONFIRMED' | string;
  source: 'llm' | 'rules' | string;
  model?: string | null;
  cached?: boolean;
  confirmedAt?: string | null;
  llmError?: string;
  summary?: string;
  warnings?: string[];
  budgets: { kind: string; amount: number; period?: string; scope?: string | null; evidence?: Evidence }[];
  deadlines: { label: string; date: string; daysAway?: number | null; evidence?: Evidence }[];
  preferences: {
    clusters?: string[];
    gpuTypes?: string[];
    avoid?: string[];
    preemptibleOk?: boolean | null;
    maxWalltimeHours?: number | null;
    quietHours?: string | null;
    notes?: string[];
    evidence?: (Evidence & { field: string; value: unknown })[];
  };
  dataRestrictions: { kind: string; description?: string; evidence?: Evidence }[];
  memberCaps?: { who: string; pct: number; evidence?: Evidence }[];
  approvals?: { threshold: number; unit: string; evidence?: Evidence }[];
  validation?: { valid: boolean; errors: string[]; dropped: number };
  provenance?: Provenance;
}
