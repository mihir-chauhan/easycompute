/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

/** One tool call recorded during an ask turn (Advisor.Reply.toolCalls). */
export interface ToolCall {
  tool: string;
  args?: string;
  summary?: string;
  ok?: boolean;
  millis?: number | null;
}

/** Plan or job details shown on a proposal card (Advisor.Proposal.details). */
export interface ProposalDetails {
  label?: string;
  cluster?: string;
  partition?: string;
  gpuType?: string;
  gpus?: number;
  nodes?: number;
  walltimeHours?: number;
  estWaitHours?: number;
  estDurationHours?: number;
  estCostUsd?: number;
  estCostUnits?: number;
  meetsDeadline?: boolean | null;
  sbatchScript?: string;
  state?: string;
  timelimitHours?: number;
  elapsedHours?: number;
}

/** An action the advisor proposed; applied only when the user confirms (Advisor.pendingProposals). */
export interface Proposal {
  id: string;
  summary: string;
  kind: 'SUBMIT_RUN' | 'JOB_ACTION' | string;
  labId?: string | null;
  jobId?: string | null;
  runRequestId?: string | null;
  planId?: string | null;
  actionType?: string | null;
  reason?: string | null;
  details?: ProposalDetails | null;
  state: 'PENDING' | 'APPLIED' | 'FAILED' | 'DISCARDED' | string;
  resultText?: string | null;
  resultJobId?: string | null;
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
  proposals?: Proposal[];
}

/** Advisor.confirmProposal / discardProposal result. */
export interface ProposalDecision {
  proposalId: string;
  state: string;
  message: string;
  jobId?: string | null;
}

/** Advisor.extractConstraints result. */
export interface LabConstraints {
  source: 'llm' | 'rules' | string;
  model?: string;
  cached?: boolean;
  llmError?: string;
  summary?: string;
  warnings?: string[];
  budgets: { kind: string; amount: number; period?: string; scope?: string | null; evidence?: string }[];
  deadlines: { label: string; date: string; daysAway?: number | null; evidence?: string }[];
  preferences: {
    clusters?: string[];
    gpuTypes?: string[];
    avoid?: string[];
    preemptibleOk?: boolean | null;
    maxWalltimeHours?: number | null;
    quietHours?: string | null;
    notes?: string[];
  };
  dataRestrictions: { kind: string; description?: string; evidence?: string }[];
  memberCaps?: { who: string; pct: number; evidence?: string }[];
  approvals?: { threshold: number; unit: string; evidence?: string }[];
}
