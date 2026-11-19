/*
 * User Management. /admin/users (University Admin: every lab) and /members (lab view: the current lab).
 * Tabs: Members (table, invite, change role, remove), Roles & permissions (matrix), Approvals (pending requests).
 * Roles: University Admin / PI-Lab Admin / Student-Lab Member (components/app/roles.ts). LabMember CRUD + pending
 * ActionLogEntry approvals via c3Call; platform-level access lives in C3's native User Management.
 */

import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ExternalLink, Minus, Trash2, UserPlus } from 'lucide-react';

import {
  AttentionItem,
  ClearFilters,
  DataTable,
  EmptyState,
  ErrorState,
  KpiRow,
  KpiRowSkeleton,
  KpiTile,
  ModelComputing,
  ModelProvenance,
  Note,
  provenanceFor,
  PageFrame,
  PageTabs,
  Pill,
  ResultCount,
  SearchBox,
  SectionCard,
  Segmented,
  SelectPill,
  TableSkeleton,
  errorMessage,
  humanize,
  useAppShell,
  useC3Data,
  type Column,
  type Tone,
} from '@/components/app';
import { nativeToolUrl } from '@/components/app/nativeTools';
import { PERMISSIONS, ROLE_DESCRIPTION, ROLE_LABEL, roleFromMember, type EcRole } from '@/components/app/roles';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalContent, ModalFooter, ModalFooterActions, ModalHeader, ModalTitle } from '@/components/ui/modal';
import {
  decideApproval,
  inviteUser,
  isUserAdminDeployed,
  listLabs,
  listUsers,
  pendingApprovals,
  removeUser,
  setUserRole,
  type AppRole,
  type AppUserRow,
  type ApprovalItem,
} from '@/features/admin/api';
import { cn } from '@/lib/utils';

const ROLE_TONE: Record<EcRole, Tone> = { UNIVERSITY_ADMIN: 'pink', PI: 'info', MEMBER: 'neutral' };
const TITLE_OPTIONS: Array<{ value: AppRole; label: string }> = [
  { value: 'PI', label: 'PI' },
  { value: 'STAFF', label: 'Staff / postdoc' },
  { value: 'STUDENT', label: 'Student' },
];
const titleLabel = (r: AppRole) => (r === 'UNIVERSITY_ADMIN' ? 'RCAC staff' : TITLE_OPTIONS.find((o) => o.value === r)?.label ?? humanize(r));
const appRoleOf = (u: AppUserRow): EcRole => roleFromMember(u.role);
/** MODEL_MAP component that raised an approval request. */
const modelFor = (a: ApprovalItem): string =>
  a.kind === 'RUN_APPROVAL' ? 'ClusterPolicyEngine' : a.kind === 'WALLTIME_EXTENSION' ? 'GuardrailRuleEngine' : /SCALE|IDLE|UNDER/i.test(a.kind) ? 'GPUUnderuseDetector' : 'GuardrailRuleEngine';
const STATUS_TONE: Record<string, Tone> = { ACTIVE: 'good', INVITED: 'info', DISABLED: 'neutral' };

const timeAgo = (iso?: string) => {
  if (!iso) return '—';
  const h = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (Number.isNaN(h)) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w) && !/^(Dr|Prof)\.?$/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';

export default function AdminUsers() {
  const { view, labId, lab, labs, can, role, user } = useAppShell();
  const { reportError } = useErrorBoundary();
  const scopeLab = view === 'admin' ? null : labId;
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'members';
  const setTab = (t: string) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (t === 'members') n.delete('tab');
    else n.set('tab', t);
    return n;
  }, { replace: true });

  const { data, loading, error, reload } = useC3Data(async () => {
    const [users, approvals, labRows] = await Promise.all([listUsers(scopeLab), pendingApprovals(scopeLab), view === 'admin' ? listLabs() : Promise.resolve([])]);
    return { users, approvals, labRows };
  }, [scopeLab, view]);

  const canManage = can('manage_lab_members');
  const canApprove = can('approve_requests');
  const approver = user?.name ?? ROLE_LABEL[role];

  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [labFilter, setLabFilter] = useState('ALL');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const all = useMemo(() => (data?.users ?? []).filter((u) => u.status !== 'DISABLED'), [data]);
  const deployed = isUserAdminDeployed();
  const rows = useMemo(
    () =>
      all.filter(
        (m) =>
          (roleFilter === 'ALL' || appRoleOf(m) === roleFilter) &&
          (labFilter === 'ALL' || m.labId === labFilter) &&
          (!q || `${m.name} ${m.username ?? ''} ${m.email ?? ''} ${m.labName ?? ''}`.toLowerCase().includes(q.toLowerCase())),
      ),
    [all, roleFilter, labFilter, q],
  );
  const countRole = (r: string) => all.filter((m) => r === 'ALL' || appRoleOf(m) === r).length;
  const filtered = Boolean(q) || roleFilter !== 'ALL' || labFilter !== 'ALL';
  const labOptions = useMemo(() => {
    const m = new Map<string, string>();
    (data?.labRows ?? []).forEach((l) => m.set(l.id, l.name));
    (data?.users ?? []).forEach((x) => x.labId && !m.has(x.labId) && m.set(x.labId, x.labName ?? x.labId));
    return [...m.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const canEditRow = (m: AppUserRow) => m.role !== 'UNIVERSITY_ADMIN' && canManage && (view === 'admin' || m.labId === labId) && m.id !== user?.id;

  const columns: Column<AppUserRow>[] = [
    {
      key: 'name',
      header: 'User',
      render: (m) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className={cn('grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold', m.role === 'UNIVERSITY_ADMIN' ? 'bg-[var(--ec-pink-bg)] text-[var(--ec-pink)]' : 'bg-[var(--ec-card-2)] text-[var(--ec-fg)]')}>
            {initialsOf(m.name)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-[var(--ec-fg-hi)]">
              {m.name}
              {m.id === user?.id ? <span className="ml-2 text-xs font-normal text-[var(--ec-fg-3)]">you</span> : null}
            </span>
            <span className="truncate font-mono text-xs text-[var(--ec-fg-2)]">{m.username ?? m.email ?? m.id}</span>
          </span>
        </span>
      ),
      sortValue: (m) => m.name,
      className: 'max-w-72',
    },
    { key: 'lab', header: 'Lab', render: (m) => (m.role === 'UNIVERSITY_ADMIN' ? <span className="text-[var(--ec-fg-2)]">All labs</span> : m.labName ?? m.labId ?? '—'), sortValue: (m) => m.labName ?? '', className: 'max-w-64 truncate', hideBelow: 'md' },
    {
      key: 'role',
      header: 'Role',
      render: (m) => <Pill tone={ROLE_TONE[appRoleOf(m)]}>{ROLE_LABEL[appRoleOf(m)]}</Pill>,
      sortValue: (m) => ['UNIVERSITY_ADMIN', 'PI', 'MEMBER'].indexOf(appRoleOf(m)),
    },
    {
      key: 'title',
      header: 'Lab title',
      render: (m) =>
        m.role === 'UNIVERSITY_ADMIN' ? (
          <span className="text-[var(--ec-fg-2)]">RCAC staff</span>
        ) : canEditRow(m) ? (
          <label className="inline-flex">
            <span className="sr-only">Lab title for {m.name}</span>
            <select
              value={m.role}
              disabled={busy === m.id}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => run(m.id, () => setUserRole(m.id, e.target.value as AppRole))}
              className="h-7 cursor-pointer rounded-md border border-[var(--ec-line-2)] bg-transparent px-2 text-[13px] text-[var(--ec-fg-hi)] [&>option]:bg-[var(--ec-card)]"
            >
              {TITLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          titleLabel(m.role)
        ),
      sortValue: (m) => m.role,
    },
    { key: 'status', header: 'Status', render: (m) => <Pill tone={STATUS_TONE[m.status] ?? 'neutral'} dot>{humanize(m.status)}</Pill>, sortValue: (m) => m.status, hideBelow: 'lg' },
    {
      key: 'activity',
      header: 'GPU-h (30 d)',
      align: 'right',
      render: (m) => (m.gpuHours30d != null ? Math.round(m.gpuHours30d).toLocaleString('en-US') : <span className="text-[var(--ec-fg-3)]">—</span>),
      sortValue: (m) => m.gpuHours30d ?? -1,
      hideBelow: 'lg',
    },
    {
      key: 'since',
      header: 'Last active',
      align: 'right',
      render: (m) => <span className="text-[var(--ec-fg-2)]">{m.status === 'INVITED' ? `invited ${timeAgo(m.invitedAt ?? undefined)}` : timeAgo(m.lastActive ?? m.invitedAt ?? undefined)}</span>,
      sortValue: (m) => m.lastActive ?? m.invitedAt ?? '',
      hideBelow: 'lg',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (m) =>
        canEditRow(m) ? (
          <button
            type="button"
            aria-label={`Remove ${m.name}`}
            disabled={busy === m.id}
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Remove ${m.name} from ${m.labName ?? 'the lab'}? Their past jobs stay in history.`)) run(m.id, () => removeUser(m.id));
            }}
            className="grid size-7 place-items-center rounded-md text-[var(--ec-fg-2)] hover:bg-[var(--ec-crit-bg)] hover:text-[var(--ec-crit-fg)] disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null,
    },
  ];

  const approvals = data?.approvals ?? [];
  const pis = all.filter((m) => appRoleOf(m) === 'PI').length;
  const memberCount = all.filter((m) => appRoleOf(m) === 'MEMBER').length;

  return (
    <PageFrame
      title={view === 'admin' ? 'Users & roles' : 'Members & roles'}
      description={
        view === 'admin'
          ? 'Everyone with access to EasyCompute: University Admins (RCAC staff), PI / Lab Admins and lab members, plus requests waiting for approval.'
          : `Who can plan and submit runs for ${lab?.name ?? 'your lab'}, what each role may do, and requests waiting for approval.`
      }
      breadcrumbs={view === 'admin' ? [{ label: 'Research Computing', href: '#/admin' }, { label: 'Users' }] : undefined}
      actions={
        <>
          <Button variant="outline" appearance="secondary" trailingIcon={<ExternalLink />} onClick={() => window.open(nativeToolUrl('user-management'), '_blank', 'noopener')}>
            C3 User Management
          </Button>
          {canManage ? (
            <Button leadingIcon={<UserPlus />} onClick={() => setInviteOpen(true)}>
              Invite member
            </Button>
          ) : null}
        </>
      }
      tabs={
        <PageTabs
          value={tab}
          onChange={setTab}
          label="User management sections"
          tabs={[
            { value: 'members', label: `Members` },
            { value: 'roles', label: 'Roles & permissions' },
            {
              value: 'approvals',
              label: (
                <span className="inline-flex items-center gap-2">
                  Approvals
                  {approvals.length ? <span className="rounded-full bg-[var(--ec-warn-bg)] px-[7px] text-xs leading-5 text-[var(--ec-warn-fg)]">{approvals.length}</span> : null}
                </span>
              ),
            },
          ]}
        />
      }
    >
      {error ? <ErrorState message={`Could not load users: ${error}`} onRetry={reload} /> : null}
      {actionError ? <ErrorState message={actionError} /> : null}

      {loading && !data ? (
        <KpiRowSkeleton />
      ) : (
        <KpiRow>
          <KpiTile label="Users" value={all.length.toLocaleString('en-US')} caption={view === 'admin' ? `${labOptions.length} labs · ${countRole('UNIVERSITY_ADMIN')} RCAC staff` : lab?.name ?? ''} />
          <KpiTile label="PI / Lab admins" value={pis} caption="manage members, budgets, approvals" />
          <KpiTile label="Lab members" value={memberCount} caption="plan & submit within limits" />
          <KpiTile label="Pending approvals" value={approvals.length} tone={approvals.length ? 'warn' : 'good'} caption="walltime extensions, scale-downs, large runs" onClick={() => setTab('approvals')} />
        </KpiRow>
      )}

      {tab === 'members' ? (
        <>
          <div className="flex flex-wrap items-center gap-2.5">
            <SearchBox value={q} onChange={setQ} label="Search users" placeholder="Search name or username" />
            <Segmented
              label="Role"
              value={roleFilter}
              onChange={setRoleFilter}
              options={[
                { value: 'ALL', label: 'All', count: countRole('ALL') },
                ...(view === 'admin' ? [{ value: 'UNIVERSITY_ADMIN', label: 'University Admin', count: countRole('UNIVERSITY_ADMIN') }] : []),
                { value: 'PI', label: 'PI / Lab Admin', count: countRole('PI') },
                { value: 'MEMBER', label: 'Members', count: countRole('MEMBER') },
              ]}
            />
            {view === 'admin' ? <SelectPill label="Lab" value={labFilter} onChange={setLabFilter} options={[{ value: 'ALL', label: 'All' }, ...labOptions]} /> : null}
            {filtered ? (
              <ClearFilters
                onClick={() => {
                  setQ('');
                  setRoleFilter('ALL');
                  setLabFilter('ALL');
                }}
              />
            ) : null}
            <ResultCount>{`${rows.length} ${rows.length === 1 ? 'user' : 'users'}`}</ResultCount>
          </div>
          <SectionCard flush>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(m) => m.id}
              loading={loading && !data}
              initialSort={{ key: 'role', dir: 'asc' }}
              pageSize={25}
              emptyLabel={filtered ? 'No users match these filters' : 'No members yet'}
              emptyAction={canManage && !filtered ? <Button size="sm" leadingIcon={<UserPlus />} onClick={() => setInviteOpen(true)}>Invite member</Button> : undefined}
            />
          </SectionCard>
          <Note title="Platform access is managed in C3">
            EasyCompute roles decide what people can do in this app. Platform roles (for example C3.DataIntegrator for the Data Fusion pipelines) and
            Okta sign-in are granted in{' '}
            <a href={nativeToolUrl('user-management')} target="_blank" rel="noreferrer" className="text-[var(--ec-accent-text)] hover:underline">
              C3 User Management
            </a>
            .
          </Note>
        </>
      ) : null}

      {tab === 'roles' ? (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {(['UNIVERSITY_ADMIN', 'PI', 'MEMBER'] as EcRole[]).map((r) => (
              <div key={r} className={cn('flex flex-col gap-2 rounded-lg bg-[var(--ec-card)] p-4', r === role && 'ring-1 ring-[var(--ec-accent-line)]')}>
                <div className="flex items-center justify-between gap-2">
                  <Pill tone={ROLE_TONE[r]}>{ROLE_LABEL[r]}</Pill>
                  {r === role ? <span className="text-xs text-[var(--ec-accent-text)]">your role</span> : null}
                </div>
                <p className="m-0 text-[13px] text-[var(--ec-fg-2)]">{ROLE_DESCRIPTION[r]}</p>
                <p className="m-0 text-xs text-[var(--ec-fg-3)] tabular-nums">{countRole(r)} users</p>
              </div>
            ))}
          </div>
          <SectionCard flush title="Permission matrix" actions={<span className="text-[13px] text-[var(--ec-fg-2)]">Enforced in the app shell and pages</span>}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm tabular-nums">
                <thead>
                  <tr>
                    <th className="border-b border-[var(--ec-line)] px-4 py-2.5 text-left text-xs font-medium text-[var(--ec-fg-2)]">Capability</th>
                    {(['UNIVERSITY_ADMIN', 'PI', 'MEMBER'] as EcRole[]).map((r) => (
                      <th key={r} className={cn('border-b border-[var(--ec-line)] px-4 py-2.5 text-center text-xs font-medium whitespace-nowrap', r === role ? 'text-[var(--ec-fg-hi)]' : 'text-[var(--ec-fg-2)]')}>
                        {ROLE_LABEL[r]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERMISSIONS.map((p) => (
                    <tr key={p.id} className="hover:bg-[#1d1d1d]">
                      <td className="border-b border-[var(--ec-line)] px-4 py-3">
                        <div className="font-medium text-[var(--ec-fg-hi)]">{p.label}</div>
                        <div className="text-xs text-[var(--ec-fg-2)]">{p.detail}</div>
                      </td>
                      {(['UNIVERSITY_ADMIN', 'PI', 'MEMBER'] as EcRole[]).map((r) => {
                        const g = p.grants[r];
                        return (
                          <td key={r} className={cn('border-b border-[var(--ec-line)] px-4 py-3 text-center', r === role && 'bg-[var(--ec-strip)]')}>
                            {g === true ? (
                              <Check className="mx-auto size-4 text-[var(--ec-accent-hi)]" aria-label="Allowed" />
                            ) : g === false ? (
                              <Minus className="mx-auto size-4 text-[var(--ec-fg-3)]" aria-label="Not allowed" />
                            ) : (
                              <Pill tone={g === 'read-only' ? 'neutral' : 'good'}>{g}</Pill>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      ) : null}

      {tab === 'approvals' ? (
        <SectionCard
          title="Waiting for approval"
          actions={<span className="text-[13px] text-[var(--ec-fg-2)]">{canApprove ? `Approving as ${approver}` : 'PI / Lab Admin decides'}</span>}
        >
          {loading && !data ? (
            <TableSkeleton rows={4} />
          ) : approvals.length === 0 ? (
            <EmptyState icon={<Check />} title="Nothing waiting" hint="Walltime extensions, scale-downs and large runs that need a PI appear here." />
          ) : (
            <div className="flex flex-col">
              {approvals.map((a: ApprovalItem) => (
                <AttentionItem
                  key={a.id}
                  tone={a.kind === 'WALLTIME_EXTENSION' ? 'warn' : a.kind === 'RUN_APPROVAL' ? 'pink' : 'info'}
                  glyph={a.kind === 'WALLTIME_EXTENSION' ? '⏱' : a.kind === 'RUN_APPROVAL' ? '$' : '!'}
                  title={
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {a.title}
                      <Pill tone={a.kind === 'RUN_APPROVAL' ? 'pink' : 'warn'}>{a.kind === 'RUN_APPROVAL' ? 'PI approval' : a.kind === 'WALLTIME_EXTENSION' ? 'Walltime' : humanize(a.kind)}</Pill>
                    </span>
                  }
                  action={
                    busy === a.id ? (
                      <ModelComputing component={modelFor(a)} verb={a.kind === 'RUN_APPROVAL' ? 'is re-checking the plan' : 'is applying the decision'} />
                    ) : canApprove ? (
                      <>
                        <Button size="sm" disabled={busy === a.id} onClick={() => run(a.id, () => decideApproval(a, true, `Approved by ${approver}`))}>
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" appearance="secondary" disabled={busy === a.id} onClick={() => run(a.id, () => decideApproval(a, false, `Denied by ${approver}`))}>
                          Deny
                        </Button>
                      </>
                    ) : (
                      <Pill tone="warn">Needs approval</Pill>
                    )
                  }
                >
                  {a.detail}
                  {a.amount != null ? <span className="ml-1 tabular-nums text-[var(--ec-fg)]">({a.amount.toLocaleString('en-US')} {a.unit})</span> : null}
                  <span className="mt-1.5 flex">
                    <ModelProvenance component={modelFor(a)} provenance={provenanceFor(a, modelFor(a))} compact />
                  </span>
                  <span className="mt-1 block text-xs text-[var(--ec-fg-3)]">
                    {[a.labName, a.requestedBy && `requested by ${a.requestedBy}`, a.jobId ?? a.runRequestId, timeAgo(a.requestedAt ?? undefined)].filter(Boolean).join(' · ')}
                  </span>
                </AttentionItem>
              ))}
            </div>
          )}
        </SectionCard>
      ) : null}

      <InviteModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        labs={view === 'admin' ? labOptions : labs.filter((l) => l.id === labId).map((l) => ({ value: l.id, label: l.name }))}
        defaultLab={view === 'admin' ? labOptions[0]?.value : labId ?? undefined}
        canInviteAdmin={view === 'admin' && can('manage_all_users') && deployed === true}
        onCreate={(m) => run('invite', () => inviteUser(m.email, m.name, m.role, m.labId)).then(() => setInviteOpen(false))}
        busy={busy === 'invite'}
      />
    </PageFrame>
  );
}

function InviteModal({
  open,
  onOpenChange,
  labs,
  defaultLab,
  onCreate,
  busy,
  canInviteAdmin,
}: {
  canInviteAdmin: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  labs: Array<{ value: string; label: string }>;
  defaultLab?: string;
  onCreate: (m: { email: string; name: string; role: AppRole; labId: string | null }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [memberRole, setMemberRole] = useState<string>('STUDENT');
  const [labPick, setLabPick] = useState<string | undefined>(undefined);
  const labId = labPick ?? defaultLab ?? labs[0]?.value;
  const isAdmin = memberRole === 'UNIVERSITY_ADMIN';
  const valid = name.trim().length > 1 && /^[a-z0-9_.-]{2,}$/i.test(username.trim()) && (isAdmin || Boolean(labId));
  const field = 'h-[34px] w-full rounded-lg border border-[var(--ec-line-2)] bg-transparent px-2.5 text-sm text-[var(--ec-fg-hi)] outline-none focus-visible:border-[var(--ec-fg-3)]';
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent width={460} className="border border-[var(--ec-line-2)] bg-[var(--ec-card)]!">
        <ModalHeader>
          <ModalTitle>Invite a lab member</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <form
            id="ec-invite"
            className="flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) onCreate({ email: `${username.trim().toLowerCase()}@purdue.edu`, name: name.trim(), role: memberRole as AppRole, labId: isAdmin ? null : labId ?? null });
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ec-invite-name" className="text-[13px] font-medium text-[var(--ec-fg)]">
                Full name
              </label>
              <input id="ec-invite-name" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Lee" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ec-invite-user" className="text-[13px] font-medium text-[var(--ec-fg)]">
                Purdue career account
              </label>
              <input id="ec-invite-user" className={cn(field, 'font-mono')} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="jlee42" />
              <span className="text-xs text-[var(--ec-fg-3)]">Invite goes to &lt;account&gt;@purdue.edu; must match the Slurm username so their jobs are attributed.</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {labs.length > 1 && !isAdmin ? <SelectPill label="Lab" value={labId ?? ''} onChange={setLabPick} options={labs} /> : null}
              <SelectPill
                label="Role"
                value={memberRole}
                onChange={setMemberRole}
                options={[...TITLE_OPTIONS, ...(canInviteAdmin ? [{ value: 'UNIVERSITY_ADMIN' as AppRole, label: 'University Admin' }] : [])]}
              />
            </div>
            <p className="m-0 text-xs text-[var(--ec-fg-2)]">
              App role: <span className="text-[var(--ec-fg-hi)]">{ROLE_LABEL[roleFromMember(memberRole)]}</span>
            </p>
          </form>
        </ModalBody>
        <ModalFooter>
          <ModalFooterActions className="gap-2">
            <Button variant="outline" appearance="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="ec-invite" disabled={!valid || busy}>
              {busy ? 'Adding…' : 'Add member'}
            </Button>
          </ModalFooterActions>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
