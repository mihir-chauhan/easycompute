/*
 * EasyCompute roles and permissions (UI side). Three roles:
 *   UNIVERSITY_ADMIN  RCAC staff: everything, every lab, the Research Computing section.
 *   PI                PI / Lab admin: their lab's members, budgets, context, approvals and guardrails.
 *   MEMBER            Student / lab member: plan and submit runs within limits, act on their own runs.
 * Backend AppUser.role (API.md section 5): UNIVERSITY_ADMIN | PI | STUDENT | STAFF; STUDENT and STAFF are lab members.
 * LabMember.role maps the same way: PI -> PI; POSTDOC, STAFF, STUDENT -> MEMBER.
 * Pages gate actions with `useAppShell().can('approve_requests')`; the shell hides nav items whose `roles` exclude
 * the current role and shows an access notice on /admin pages for non-admins.
 */

export type EcRole = 'UNIVERSITY_ADMIN' | 'PI' | 'MEMBER';

export const ROLE_LABEL: Record<EcRole, string> = {
  UNIVERSITY_ADMIN: 'University Admin',
  PI: 'PI / Lab Admin',
  MEMBER: 'Student / Lab Member',
};

export const ROLE_SHORT: Record<EcRole, string> = {
  UNIVERSITY_ADMIN: 'RCAC staff',
  PI: 'Lab admin',
  MEMBER: 'Member',
};

export const ROLE_DESCRIPTION: Record<EcRole, string> = {
  UNIVERSITY_ADMIN: 'RCAC staff. Every lab, cluster, rule and data pipeline; university dashboards and user management.',
  PI: 'Their lab: members and roles, budgets and allocations, lab context and rules, approvals, guardrails.',
  MEMBER: 'Plan and submit runs within the lab’s limits; see and act on their own runs.',
};

/** Map an AppUser.role or LabMember.role (UNIVERSITY_ADMIN, PI, POSTDOC, STUDENT, STAFF) to an app role. */
export const roleFromMember = (memberRole?: string | null): EcRole =>
  memberRole === 'UNIVERSITY_ADMIN' || memberRole === 'RCAC' ? 'UNIVERSITY_ADMIN' : memberRole === 'PI' ? 'PI' : 'MEMBER';

export type Permission =
  | 'view_university'
  | 'manage_policies'
  | 'manage_data'
  | 'manage_all_users'
  | 'manage_lab_members'
  | 'manage_lab_context'
  | 'manage_budgets'
  | 'approve_requests'
  | 'edit_guardrails'
  | 'view_lab_runs'
  | 'plan_submit_runs'
  | 'act_own_runs';

export interface PermissionRow {
  id: Permission;
  label: string;
  detail: string;
  /** Per role: true, false, or a qualifier shown in the matrix ("own lab", "own runs", "read-only"). */
  grants: Record<EcRole, boolean | string>;
}

export const PERMISSIONS: PermissionRow[] = [
  { id: 'view_university', label: 'University dashboards', detail: 'Research Computing overview, clusters, all labs', grants: { UNIVERSITY_ADMIN: true, PI: false, MEMBER: false } },
  { id: 'manage_policies', label: 'University & cluster rules', detail: 'Edit Purdue, cluster and partition policies', grants: { UNIVERSITY_ADMIN: true, PI: 'read-only', MEMBER: 'read-only' } },
  { id: 'manage_data', label: 'Data pipelines', detail: 'Data Fusion feeds, loads, rejections', grants: { UNIVERSITY_ADMIN: true, PI: false, MEMBER: false } },
  { id: 'manage_all_users', label: 'All users & roles', detail: 'Invite anyone, grant University Admin', grants: { UNIVERSITY_ADMIN: true, PI: false, MEMBER: false } },
  { id: 'manage_lab_members', label: 'Lab members', detail: 'Invite, change role, remove', grants: { UNIVERSITY_ADMIN: true, PI: 'own lab', MEMBER: false } },
  { id: 'manage_lab_context', label: 'Lab context & lab rules', detail: 'Context dump, deadlines, lab policies', grants: { UNIVERSITY_ADMIN: true, PI: 'own lab', MEMBER: 'read-only' } },
  { id: 'manage_budgets', label: 'Budgets & allocations', detail: 'Allocations, budget alerts', grants: { UNIVERSITY_ADMIN: true, PI: 'own lab', MEMBER: 'read-only' } },
  { id: 'approve_requests', label: 'Approve requests', detail: 'Walltime extensions, large runs, guardrail actions', grants: { UNIVERSITY_ADMIN: true, PI: 'own lab', MEMBER: false } },
  { id: 'edit_guardrails', label: 'Guardrails / autopilot', detail: 'Auto-cancel idle, checkpoint, notify PI', grants: { UNIVERSITY_ADMIN: true, PI: 'own lab', MEMBER: 'read-only' } },
  { id: 'view_lab_runs', label: 'All lab runs', detail: 'Every member’s runs and alerts', grants: { UNIVERSITY_ADMIN: true, PI: 'own lab', MEMBER: 'own runs' } },
  { id: 'plan_submit_runs', label: 'Plan & submit runs', detail: 'Launch planner, within limits', grants: { UNIVERSITY_ADMIN: true, PI: true, MEMBER: true } },
  { id: 'act_own_runs', label: 'Act on own runs', detail: 'Checkpoint, cancel, request extension', grants: { UNIVERSITY_ADMIN: true, PI: true, MEMBER: true } },
];

/** True when the role has the permission at all (qualified grants such as "own lab" count; "read-only" does not). */
export function roleCan(role: EcRole, permission: Permission): boolean {
  const g = PERMISSIONS.find((p) => p.id === permission)?.grants[role];
  return g === true || (typeof g === 'string' && g !== 'read-only');
}
