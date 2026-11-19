/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React, { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { Bot, RotateCcw, Send, ShieldCheck, Sparkles, Zap } from 'lucide-react';

import { c3Call } from '@/c3Action';
import { CardGrid, ModelComputing, ModelProvenance, PageFrame, SectionCard, Segmented, ToneBadge, errorMessage, useAppShell, type Provenance } from '@/components/app';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

import Citations from './Citations';
import LabKnowledge from './LabKnowledge';
import NextSteps from './NextSteps';
import ToolChips from './ToolChips';
import { SOFT } from './tones';
import type { AdvisorReply, Citation, NextLink, ToolCall } from './types';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'error';
  text: string;
  mode?: string;
  fallbackReason?: string;
  seconds?: number;
  toolCalls?: ToolCall[];
  citations?: Citation[];
  links?: NextLink[];
  provenance?: Provenance;
  question?: string;
}

const FALLBACK_PROMPTS = [
  'Can we finish our next deadline run by Friday within budget?',
  'Can thesis runs use preemptible or standby on Gautschi?',
  'Which of our running jobs are wasting GPUs?',
  'How much of our allocation is left, and when does it expire?',
  'Where is Purdue short on GPUs right now?',
];

/** Client-side wait before offering the quick (no-LLM) answer; the agent keeps running server-side. */
const SLOW_MS = 45000;

// Markdown answers: no typography plugin in the template, so style the elements the agent uses.
const MD_CLASS =
  'min-w-0 text-sm leading-6 text-[var(--c3-style-basic-fg-primary)] [&_p]:my-2 [&_p:first-child]:mt-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_strong]:font-semibold [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_code]:rounded-sm [&_code]:bg-[var(--c3-style-basic-bg-secondary)] [&_code]:px-1 [&_code]:text-[13px] [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-[var(--c3-style-basic-bg-secondary)] [&_pre]:p-2 [&_pre]:text-xs [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[13px] [&_th]:border-b [&_th]:border-[var(--c3-style-basic-border-border)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_td]:border-b [&_td]:border-[var(--c3-style-basic-border-border)] [&_td]:px-2 [&_td]:py-1 [&_td]:tabular-nums';

/** Turns inline citations "[D-01]" into markdown links to the source (external URL or in-app page). */
const linkCitations = (text: string, citations: Citation[]): string => {
  const byId = new Map(citations.filter((c) => c.url).map((c) => [c.id, c.url as string]));
  return text.replace(/\[([^\]\s][^\]]{0,60})\](?!\()/g, (all, id: string) => (byId.has(id) ? `[\\[${id}\\]](${byId.get(id)})` : all));
};

/** Markdown link: in-app paths go through the router (HashRouter), external ones open a new tab. */
function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href && href.startsWith('/')) {
    return (
      <Link to={href} className="font-mono text-[12px] text-[var(--c3-style-basic-fg-accent)] hover:underline">
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-[var(--c3-style-basic-fg-accent)] hover:underline">
      {children}
    </a>
  );
}

/**
 * AI Advisor chat with PolicyRAGAdvisor. Each question goes to the server-side `Advisor.ask`, which runs the agent
 * inside this app with retrieval over versioned Purdue / ACCESS policy documents, lab rules and context, and live job
 * evidence (or the deterministic quick mode). Answers cite their sources as chips and end with deep links to the
 * Launch planner and run pages; the advisor itself never submits, cancels or overrides anything.
 */
const AssistantPage: React.FC = () => {
  const { labId, lab } = useAppShell();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [mode, setMode] = useState<'agent' | 'offline'>('agent');
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

  // Warm-up: wakes the Python worker and makes sure the agent is current before the first question (idempotent, ~0.3 s
  // when warm; a cold worker otherwise adds 20-60 s to the first answer).
  useEffect(() => {
    c3Call('Advisor', 'ensureAgent', null, [false]).catch(() => undefined);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, pending]);

  const addMessage = useCallback((m: Omit<ChatMessage, 'id'>) => {
    const id = nextId.current++;
    setMessages((prev) => [...prev, { ...m, id }]);
  }, []);

  // New lab = new conversation and fresh suggestions.
  useEffect(() => {
    turn.current += 1;
    setMessages([]);
    setSessionId(null);
    setPending(false);
    setSlow(false);
    if (!labId) return;
    c3Call('Advisor', 'suggestedPrompts', null, [labId])
      .then((list: unknown) => {
        if (mounted.current && Array.isArray(list) && list.length) setPrompts(list as string[]);
      })
      .catch(() => undefined);
  }, [labId]);

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
      addMessage({
        role: reply.status === 'completed' || reply.mode === 'offline' ? 'assistant' : 'error',
        text: reply.answer || 'The advisor returned no answer.',
        mode: reply.mode,
        fallbackReason: reply.fallbackReason,
        seconds: reply.seconds,
        toolCalls: reply.toolCalls ?? [],
        citations: reply.citations ?? [],
        links: reply.links ?? [],
        provenance: reply.provenance,
        question: q,
      });
    } catch (err: unknown) {
      if (mounted.current && turn.current === myTurn) addMessage({ role: 'error', text: errorMessage(err), question: q });
    } finally {
      window.clearTimeout(slowTimer);
      if (mounted.current && turn.current === myTurn) {
        setPending(false);
        setSlow(false);
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
      description="PolicyRAGAdvisor answers from versioned Purdue policies, your lab's rules and context, and live job evidence, and cites every source. It explains; you act in the Launch planner and run pages."
      breadcrumbs={[{ label: 'Lab' }, { label: 'AI Advisor' }]}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Answer mode"
            value={mode}
            onChange={(v) => setMode(v as 'agent' | 'offline')}
            options={[
              { value: 'agent', label: 'PolicyRAGAdvisor' },
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
        <SectionCard
          title={lab ? `Advisor for ${lab.name}` : 'Advisor'}
          subtitle="PolicyRAGAdvisor · retrieval-augmented, cites sources, read-only"
          actions={<ModelProvenance component="PolicyRAGAdvisor" />}
        >
          <div className="flex min-h-[420px] flex-col gap-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-start gap-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`grid size-8 place-items-center rounded-lg ${SOFT.accent}`}>
                    <Sparkles className="size-5" aria-hidden />
                  </span>
                  <div>
                    <div className="text-sm font-semibold">What do you want to know?</div>
                    <div className="text-xs text-[var(--c3-style-basic-fg-secondary)]">
                      Answers cite Purdue RCAC / ACCESS documents, policy rules, your lab context and live jobs.
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
              const citations = m.citations ?? [];
              return (
                <div key={m.id} className="flex gap-3" data-testid="assistant-answer">
                  <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-md ${SOFT.accent}`}>
                    <Bot className="size-3.5" aria-hidden />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                    <div className={MD_CLASS}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <MdLink href={href}>{children}</MdLink> }}>
                        {linkCitations(m.text, citations)}
                      </ReactMarkdown>
                    </div>
                    <Citations citations={citations} text={m.text} />
                    <NextSteps links={m.links ?? []} />
                    <ToolChips calls={m.toolCalls ?? []} />
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--c3-style-basic-fg-secondary)]">
                      <ModelProvenance component="PolicyRAGAdvisor" provenance={m.provenance} compact />
                      {m.mode === 'offline' && (
                        <span title={m.fallbackReason}>
                          <ToneBadge tone="neutral">Quick answer · no LLM</ToneBadge>
                        </span>
                      )}
                      {m.seconds !== undefined && <span className="font-mono tabular-nums">{m.seconds.toFixed(1)} s</span>}
                    </div>
                  </div>
                </div>
              );
            })}

            {pending && (
              <div className="flex flex-wrap items-center gap-3" aria-live="polite">
                <ModelComputing component="PolicyRAGAdvisor" verb={mode === 'offline' ? 'is looking up your data' : 'is retrieving sources and computing'} />
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
                placeholder={labId ? 'Ask about rules, deadlines, budget or running jobs… (Enter to send)' : 'Pick a lab in the header first'}
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
          <SectionCard title="How the advisor works" subtitle="Grounded, cited, read-only">
            <ul className="flex flex-col gap-2 text-[13px] text-[var(--c3-style-basic-fg-secondary)]">
              <li className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-basic-fg-accent)]" aria-hidden />
                <span>
                  Rules are enforced by <span className="font-mono text-[var(--c3-style-basic-fg-primary)]">ClusterPolicyEngine</span>; the advisor explains them and never waives,
                  submits or cancels anything.
                </span>
              </li>
              <li className="flex gap-2">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-basic-fg-accent)]" aria-hidden />
                <span>Every answer cites versioned Purdue RCAC / ACCESS documents, policy ids, your lab context, projects or live jobs.</span>
              </li>
              <li className="flex gap-2">
                <Zap className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-basic-fg-accent)]" aria-hidden />
                <span>Next steps open the Launch planner or the run page, where you review and confirm.</span>
              </li>
            </ul>
          </SectionCard>
        </div>
      </CardGrid>
    </PageFrame>
  );
};

export default AssistantPage;
