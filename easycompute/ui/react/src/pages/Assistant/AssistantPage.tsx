/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, RotateCcw, Send, Sparkles, Zap } from 'lucide-react';

import { c3Call } from '@/c3Action';
import { CardGrid, PageFrame, SectionCard, Segmented, ToneBadge, errorMessage, useAppShell } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

import LabKnowledge from './LabKnowledge';
import ProposalCard from './ProposalCard';
import ToolChips from './ToolChips';
import type { AdvisorReply, Proposal, ProposalDecision, ToolCall } from './types';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'error' | 'system';
  text: string;
  mode?: string;
  fallbackReason?: string;
  seconds?: number;
  toolCalls?: ToolCall[];
  proposalIds?: string[];
  question?: string;
}

const FALLBACK_PROMPTS = [
  'Can we finish the NeurIPS fine-tune by Friday within budget?',
  'Which of our running jobs are wasting GPUs?',
  'How much of our allocation is left, and when does it expire?',
  'What rules apply to an 8-GPU H100 run on Gautschi?',
  'Where is Purdue short on GPUs right now?',
];

/** Client-side wait before offering the quick (no-LLM) answer; the agent keeps running server-side. */
const SLOW_MS = 45000;

// Markdown answers: no typography plugin in the template, so style the elements the agent uses.
const MD_CLASS =
  'min-w-0 text-sm leading-6 text-[var(--c3-style-basic-fg-primary)] [&_p]:my-2 [&_p:first-child]:mt-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_strong]:font-semibold [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_code]:rounded-sm [&_code]:bg-[var(--c3-style-basic-bg-secondary)] [&_code]:px-1 [&_code]:text-[13px] [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-[var(--c3-style-basic-bg-secondary)] [&_pre]:p-2 [&_pre]:text-xs [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px] [&_th]:border-b [&_th]:border-[var(--c3-style-basic-border-border)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_td]:border-b [&_td]:border-[var(--c3-style-basic-border-border)] [&_td]:px-2 [&_td]:py-1 [&_td]:tabular-nums';

/**
 * AI Advisor chat. Each question goes to the server-side `Advisor.ask`, which runs the "EasyCompute Advisor" GenaiCore
 * agent inside this app (or the deterministic offline advisor in quick mode / when no LLM is available). Answers show
 * the tools they used; actions the advisor proposes appear as cards that change nothing until the user confirms.
 */
const AssistantPage: React.FC = () => {
  const { labId, lab } = useAppShell();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [mode, setMode] = useState<'agent' | 'offline'>('agent');
  const [proposals, setProposals] = useState<Record<string, Proposal>>({});
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<string[]>(FALLBACK_PROMPTS);
  const nextId = useRef(1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const turn = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, pending]);

  const addMessage = useCallback((m: Omit<ChatMessage, 'id'>) => {
    const id = nextId.current++;
    setMessages((prev) => [...prev, { ...m, id }]);
  }, []);

  const mergeProposals = useCallback((list: Proposal[]) => {
    if (!list.length) return;
    setProposals((prev) => {
      const next = { ...prev };
      list.forEach((p) => {
        next[p.id] = p;
      });
      return next;
    });
  }, []);

  const loadPending = useCallback(async () => {
    if (!labId) return;
    try {
      const list = ((await c3Call('Advisor', 'pendingProposals', null, [labId])) ?? []) as Proposal[];
      if (!mounted.current) return;
      mergeProposals(list);
      setPendingIds(list.map((p) => p.id));
    } catch {
      // The pending list is a convenience; the chat still works without it.
    }
  }, [labId, mergeProposals]);

  // New lab = new conversation, fresh suggestions and pending approvals.
  useEffect(() => {
    turn.current += 1;
    setMessages([]);
    setSessionId(null);
    setPending(false);
    setSlow(false);
    setPendingIds([]);
    void loadPending();
    if (!labId) return;
    c3Call('Advisor', 'suggestedPrompts', null, [labId])
      .then((list: unknown) => {
        if (mounted.current && Array.isArray(list) && list.length) setPrompts(list as string[]);
      })
      .catch(() => undefined);
  }, [labId, loadPending]);

  const send = async (question: string, askMode: 'agent' | 'offline' = mode) => {
    const q = question.trim();
    if (!q || pending) return;
    const myTurn = turn.current;
    addMessage({ role: 'user', text: q });
    setInput('');
    setPending(true);
    setSlow(false);
    const slowTimer = window.setTimeout(() => {
      if (mounted.current && turn.current === myTurn) setSlow(true);
    }, SLOW_MS);
    try {
      const reply = (await c3Call('Advisor', 'ask', null, [q, sessionId, labId, askMode])) as AdvisorReply;
      if (!mounted.current || turn.current !== myTurn) return;
      if (reply.sessionId) setSessionId(reply.sessionId);
      const props = reply.proposals ?? [];
      mergeProposals(props);
      addMessage({
        role: reply.status === 'completed' || reply.mode === 'offline' ? 'assistant' : 'error',
        text: reply.answer || 'The advisor returned no answer.',
        mode: reply.mode,
        fallbackReason: reply.fallbackReason,
        seconds: reply.seconds,
        toolCalls: reply.toolCalls ?? [],
        proposalIds: props.map((p) => p.id),
        question: q,
      });
    } catch (err: unknown) {
      if (mounted.current && turn.current === myTurn) addMessage({ role: 'error', text: errorMessage(err), question: q });
    } finally {
      window.clearTimeout(slowTimer);
      if (mounted.current && turn.current === myTurn) {
        setPending(false);
        setSlow(false);
        void loadPending();
      }
    }
  };

  /** Gives up waiting for the LLM agent (it finishes server-side) and answers the same question deterministically. */
  const quickAnswer = (q: string) => {
    turn.current += 1;
    setPending(false);
    setSlow(false);
    window.setTimeout(() => void send(q, 'offline'), 0);
  };

  const decide = async (p: Proposal, action: 'confirmProposal' | 'discardProposal') => {
    setDeciding(p.id);
    try {
      const res = (await c3Call('Advisor', action, null, [p.id])) as ProposalDecision;
      if (!mounted.current) return;
      mergeProposals([{ ...p, state: res.state, resultText: res.message, resultJobId: res.jobId ?? p.jobId }]);
      addMessage({ role: 'system', text: res.message });
    } catch (err: unknown) {
      if (mounted.current) addMessage({ role: 'error', text: errorMessage(err) });
    } finally {
      if (mounted.current) setDeciding(null);
      void loadPending();
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const newConversation = () => {
    turn.current += 1;
    setMessages([]);
    setSessionId(null);
    setInput('');
    setPending(false);
    setSlow(false);
  };

  const lastQuestion = [...messages].reverse().find((m) => m.role === 'user')?.text ?? '';

  return (
    <PageFrame
      title="AI Advisor"
      description="Ask about budgets, deadlines, rules, run plans and live jobs. Answers come from live app data; actions wait for your confirmation."
      breadcrumbs={[{ label: 'Lab' }, { label: 'AI Advisor' }]}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Answer mode"
            value={mode}
            onChange={(v) => setMode(v as 'agent' | 'offline')}
            options={[
              { value: 'agent', label: 'AI agent' },
              { value: 'offline', label: 'Quick (no LLM)' },
            ]}
          />
          <Button variant="outline" appearance="secondary" leadingIcon={<RotateCcw />} onClick={newConversation} disabled={messages.length === 0}>
            New conversation
          </Button>
        </div>
      }
    >
      <CardGrid layout="two-one">
        <SectionCard title={lab ? `Advisor for ${lab.name}` : 'Advisor'} subtitle="EasyCompute Advisor · GenAI agent with read-only tools over this app">
          <div className="flex min-h-[420px] flex-col gap-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-start gap-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex size-9 items-center justify-center rounded-full bg-[var(--c3-style-basic-bg-secondary)] text-[var(--c3-style-basic-fg-accent)]">
                    <Sparkles className="size-5" aria-hidden />
                  </span>
                  <div>
                    <div className="text-sm font-semibold">What do you want to know?</div>
                    <div className="text-xs text-[var(--c3-style-basic-fg-secondary)]">
                      The advisor checks university and cluster rules, your budget and deadlines, and live job health.
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2" data-testid="suggested-prompts">
                  {prompts.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      disabled={pending || !labId}
                      className="rounded-full border border-[var(--c3-style-basic-border-border)] px-3 py-1.5 text-left text-[13px] hover:border-[var(--c3-style-basic-border-accent)] hover:bg-[var(--c3-style-basic-bg-secondary)] disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => {
              if (m.role === 'user') {
                return (
                  <div key={m.id} className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-[var(--c3-style-basic-bg-secondary)] px-3.5 py-2 text-sm">{m.text}</div>
                  </div>
                );
              }
              if (m.role === 'error') {
                return (
                  <div
                    key={m.id}
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--c3-style-basic-border-danger)] px-3 py-2 text-sm text-[var(--c3-style-basic-fg-danger)]"
                  >
                    <span className="min-w-0 flex-1">{m.text}</span>
                    {m.question && (
                      <Button size="sm" variant="outline" appearance="secondary" leadingIcon={<Zap />} disabled={pending} onClick={() => void send(m.question ?? '', 'offline')}>
                        Retry in quick mode
                      </Button>
                    )}
                  </div>
                );
              }
              if (m.role === 'system') {
                return (
                  <div key={m.id} className="text-center text-xs text-[var(--c3-style-basic-fg-secondary)]">
                    {m.text}
                  </div>
                );
              }
              return (
                <div key={m.id} className="flex gap-3" data-testid="assistant-answer">
                  <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--c3-style-basic-bg-secondary)] text-[var(--c3-style-basic-fg-accent)]">
                    <Bot className="size-4" aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className={MD_CLASS}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                    </div>
                    {(m.proposalIds ?? []).map((id) =>
                      proposals[id] ? <ProposalCard key={id} proposal={proposals[id]} busy={deciding === id} onDecide={(p, a) => void decide(p, a)} /> : null,
                    )}
                    <ToolChips calls={m.toolCalls ?? []} />
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--c3-style-basic-fg-secondary)]">
                      {m.mode === 'offline' ? (
                        <span title={m.fallbackReason}>
                          <ToneBadge tone="neutral">Quick answer · no LLM</ToneBadge>
                        </span>
                      ) : (
                        <ToneBadge tone="accent">AI agent</ToneBadge>
                      )}
                      {m.seconds !== undefined && <span className="tabular-nums">{m.seconds.toFixed(1)} s</span>}
                    </div>
                  </div>
                </div>
              );
            })}

            {pending && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--c3-style-basic-fg-secondary)]" aria-live="polite">
                <Spinner size="sm" />
                {mode === 'offline' ? 'Looking at the data…' : 'The advisor is checking rules, plans and live data…'}
                {slow && (
                  <Button size="sm" variant="ghost" appearance="accent" leadingIcon={<Zap />} onClick={() => quickAnswer(lastQuestion)}>
                    Taking long — get a quick answer
                  </Button>
                )}
              </div>
            )}
            <div ref={bottomRef} />

            <form onSubmit={onSubmit} className="mt-auto flex items-end gap-2 border-t border-[var(--c3-style-basic-border-border)] pt-3">
              <label htmlFor="advisor-input" className="sr-only">
                Ask the advisor
              </label>
              <Textarea
                id="advisor-input"
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={labId ? 'Ask about deadlines, budget, rules or running jobs… (Enter to send)' : 'Pick a lab in the header first'}
                disabled={pending || !labId}
                className="min-h-10 flex-1 resize-none"
              />
              <Button type="submit" variant="solid" appearance="accent" leadingIcon={<Send />} disabled={pending || !input.trim() || !labId}>
                Send
              </Button>
            </form>
          </div>
        </SectionCard>

        <div className="flex min-w-0 flex-col gap-4">
          <LabKnowledge labId={labId} labName={lab?.name} />
          <SectionCard title="Awaiting your confirmation" subtitle="Actions the advisor proposed for this lab">
            {pendingIds.length === 0 ? (
              <p className="text-sm text-[var(--c3-style-basic-fg-secondary)]">Nothing pending. The advisor never acts without your confirmation.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {pendingIds
                  .map((id) => proposals[id])
                  .filter((p): p is Proposal => Boolean(p))
                  .map((p) => (
                    <ProposalCard key={p.id} proposal={p} compact busy={deciding === p.id} onDecide={(pp, a) => void decide(pp, a)} />
                  ))}
              </div>
            )}
          </SectionCard>
        </div>
      </CardGrid>
    </PageFrame>
  );
};

export default AssistantPage;
