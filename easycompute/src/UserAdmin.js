/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('UserAdmin');

var DAY_MS = 24 * 3600 * 1000;
var ROLES = ['UNIVERSITY_ADMIN', 'PI', 'STUDENT', 'STAFF'];
/** Research Computing staff created with the user directory (fictional people). */
var ADMINS = [
  { id: 'admin-rcac-1', name: 'Dana Whitfield', username: 'dwhitfield', email: 'dwhitfield@example.edu' },
  { id: 'admin-rcac-2', name: 'Marco Ruiz', username: 'mruiz', email: 'mruiz@example.edu' },
];

function ms(v) {
  return v == null ? null : Date.parse(String(v));
}

function iso(v) {
  var t = ms(v);
  return t == null || isNaN(t) ? null : new Date(t).toISOString();
}

function toDt(millis) {
  return DateTime.fromString(new Date(millis).toISOString());
}

function round(v, digits) {
  var f = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(Number(v || 0) * f) / f;
}

function list(arr) {
  var out = [];
  if (arr == null) return out;
  for (var i = 0; i < arr.length; i++) out.push(arr[i]);
  return out;
}

/** Deterministic number in [0, 1) from a string, for demo last-active times. */
function hash01(key) {
  var h = 2166136261;
  for (var i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return (h % 100000) / 100000;
}

function platformUserId() {
  try {
    var u = User.myUser();
    return u == null ? 'anonymous' : String(u.id);
  } catch (e) {
    return 'anonymous';
  }
}

// ---------------------------------------------------------------- directory

/** Creates AppUser rows for LabMembers that have none yet, plus the Research Computing admins (idempotent). */
function ensureDirectory() {
  var have = {};
  AppUser.fetchObjStream({ include: 'id' }).each(function (u) {
    have[u.id] = true;
  });
  var now = Date.now();
  var rows = [];
  ADMINS.forEach(function (a) {
    if (have[a.id]) return;
    rows.push(AppUser.make({ id: a.id, name: a.name, username: a.username, email: a.email, role: 'UNIVERSITY_ADMIN', status: 'ACTIVE', lastActive: toDt(now - hash01(a.id) * 2 * DAY_MS) }));
  });
  LabMember.fetchObjStream({ include: 'id, name, username, role, lab' }).each(function (m) {
    if (have[m.id]) return;
    var r = String(m.role || 'STUDENT');
    var role = r == 'PI' ? 'PI' : r == 'STUDENT' ? 'STUDENT' : 'STAFF';
    var username = m.username ? String(m.username) : String(m.id);
    rows.push(
      AppUser.make({
        id: m.id,
        name: m.name,
        username: username,
        email: username + '@purdue.example.edu',
        lab: m.lab ? { id: m.lab.id } : null,
        labMember: { id: m.id },
        role: role,
        status: 'ACTIVE',
        lastActive: toDt(now - hash01(m.id) * 14 * DAY_MS),
      })
    );
  });
  if (rows.length) {
    AppUser.upsertBatch(rows);
    log.info('ensureDirectory: created {} app users', rows.length);
  }
}

function labNames() {
  var out = {};
  list(Lab.fetch({ include: 'id, name', limit: 500 }).objs).forEach(function (l) {
    out[l.id] = l.name;
  });
  return out;
}

function row(u, names, usage) {
  var labId = u.lab ? String(u.lab.id) : null;
  var use = (usage && usage[String(u.username)]) || { jobs: 0, gpuHours: 0 };
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    username: u.username,
    role: u.role,
    status: u.status,
    labId: labId,
    labName: labId ? names[labId] || labId : null,
    lastActive: iso(u.lastActive),
    invitedBy: u.invitedBy || null,
    invitedAt: iso(u.invitedAt),
    jobs30d: use.jobs,
    gpuHours30d: round(use.gpuHours, 1),
  };
}

function capabilities(role) {
  return {
    manageUsers: role == 'UNIVERSITY_ADMIN' || role == 'PI',
    approve: role == 'UNIVERSITY_ADMIN' || role == 'PI',
    adminView: role == 'UNIVERSITY_ADMIN',
    submitRuns: true,
  };
}

/** The acting AppUser as a plain object: demo override, else platform user match, else synthetic admin. */
function actor() {
  ensureDirectory();
  var pid = platformUserId();
  var demo = DemoIdentity.make({ id: pid }).get('appUser');
  var u = null;
  var isDemo = false;
  if (demo != null && demo.appUser != null) {
    u = AppUser.make({ id: demo.appUser.id }).get('this');
    isDemo = u != null;
  }
  if (u == null && pid != 'anonymous') {
    u = list(AppUser.fetch({ filter: Filter.eq('username', pid).or().eq('email', pid), limit: 1 }).objs)[0] || null;
  }
  var names = labNames();
  if (u == null) {
    return { user: { id: 'app-owner', name: 'App owner', email: null, username: pid, role: 'UNIVERSITY_ADMIN', status: 'ACTIVE', labId: null, labName: null }, isDemo: false, platformUser: pid };
  }
  return { user: row(u, names, null), isDemo: isDemo, platformUser: pid };
}

function requireManager(me, labId) {
  var r = me.user.role;
  if (r == 'UNIVERSITY_ADMIN') return;
  if (r == 'PI' && labId != null && labId == me.user.labId) return;
  throw new Error(me.user.name + ' (' + r + ') may not manage ' + (labId ? 'lab ' + labId : 'users outside a lab') + '; only Research Computing admins and the lab PI can.');
}

function getUser(id) {
  ensureDirectory();
  var u = AppUser.make({ id: id }).get('this');
  if (u == null) throw new Error('AppUser ' + id + ' not found');
  return u;
}

// ---------------------------------------------------------------- API

function whoAmI() {
  var me = actor();
  me.can = capabilities(me.user.role);
  return me;
}

function setDemoUser(appUserId) {
  var pid = platformUserId();
  if (appUserId == null || appUserId === '') {
    DemoIdentity.make({ id: pid }).remove();
  } else {
    var u = getUser(appUserId);
    if (u.status == 'DISABLED') throw new Error(u.name + ' is disabled');
    DemoIdentity.make({ id: pid, appUser: { id: u.id } }).upsert();
    AppUser.make({ id: u.id, lastActive: toDt(Date.now()) }).merge();
  }
  return whoAmI();
}

function listUsers(labId) {
  var me = actor();
  var scope = labId || null;
  if (me.user.role != 'UNIVERSITY_ADMIN') {
    if (scope != null && scope != me.user.labId) throw new Error(me.user.name + ' can only list users of their own lab');
    scope = me.user.labId;
  }
  var names = labNames();
  var since = new Date(Date.now() - 30 * DAY_MS).toISOString().substring(0, 10);
  var usage = {};
  Job.fetchObjStream({
    filter: (scope ? Filter.eq('lab.id', scope).and("submitTime >= dateTime('" + since + "')") : "submitTime >= dateTime('" + since + "')"),
    include: 'user, allocGpus, elapsedHours',
  }).each(function (j) {
    var k = String(j.user);
    var e = (usage[k] = usage[k] || { jobs: 0, gpuHours: 0 });
    e.jobs++;
    e.gpuHours += Number(j.allocGpus || 0) * Number(j.elapsedHours || 0);
  });
  var users = [];
  AppUser.fetchObjStream({ filter: scope ? Filter.eq('lab.id', scope) : null, include: 'this' }).each(function (u) {
    users.push(row(u, names, usage));
  });
  var order = { UNIVERSITY_ADMIN: 0, PI: 1, STAFF: 2, STUDENT: 3 };
  users.sort(function (a, b) {
    return (a.labName || '').localeCompare(b.labName || '') || order[a.role] - order[b.role] || String(a.name).localeCompare(String(b.name));
  });
  var byRole = {};
  var byStatus = {};
  users.forEach(function (u) {
    byRole[u.role] = (byRole[u.role] || 0) + 1;
    byStatus[u.status] = (byStatus[u.status] || 0) + 1;
  });
  return { users: users, counts: { total: users.length, byRole: byRole, byStatus: byStatus } };
}

function inviteUser(email, name, role, labId) {
  var me = actor();
  var r = String(role || '').toUpperCase();
  if (ROLES.indexOf(r) < 0) throw new Error('Unknown role ' + role + '; use one of ' + ROLES.join(', '));
  var lab = labId || (r == 'UNIVERSITY_ADMIN' ? null : me.user.labId);
  if (r == 'UNIVERSITY_ADMIN') {
    if (me.user.role != 'UNIVERSITY_ADMIN') throw new Error('Only Research Computing admins can invite admins');
    lab = null;
  } else {
    if (lab == null) throw new Error('labId is required for role ' + r);
    if (Lab.make({ id: lab }).get('id') == null) throw new Error('Lab ' + lab + ' not found');
    requireManager(me, lab);
  }
  var mail = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('Invalid email ' + email);
  if (AppUser.fetchCount({ filter: Filter.eq('email', mail) }) > 0) throw new Error(mail + ' is already a user');
  var id = 'user-' + mail.replace(/[^a-z0-9]+/g, '-');
  var now = Date.now();
  AppUser.make({ id: id, name: String(name).trim(), email: mail, username: mail.split('@')[0], lab: lab ? { id: lab } : null, role: r, status: 'INVITED', invitedBy: me.user.name, invitedAt: toDt(now) }).create();
  log.info('inviteUser {} as {} in {} by {}', mail, r, lab, me.user.id);
  return row(AppUser.make({ id: id }).get('this'), labNames(), null);
}

function setRole(userId, role) {
  var me = actor();
  var r = String(role || '').toUpperCase();
  if (ROLES.indexOf(r) < 0) throw new Error('Unknown role ' + role + '; use one of ' + ROLES.join(', '));
  var u = getUser(userId);
  var labId = u.lab ? String(u.lab.id) : null;
  if (r == 'UNIVERSITY_ADMIN' && me.user.role != 'UNIVERSITY_ADMIN') throw new Error('Only Research Computing admins can grant UNIVERSITY_ADMIN');
  requireManager(me, labId);
  if (u.id == me.user.id && me.user.role == 'PI' && r != 'PI') throw new Error('A PI cannot demote themselves; ask Research Computing');
  AppUser.make({ id: u.id, role: r }).merge();
  return row(AppUser.make({ id: u.id }).get('this'), labNames(), null);
}

function removeUser(userId) {
  var me = actor();
  var u = getUser(userId);
  requireManager(me, u.lab ? String(u.lab.id) : null);
  if (u.id == me.user.id) throw new Error('You cannot remove yourself');
  AppUser.make({ id: u.id, status: 'DISABLED' }).merge();
  return row(AppUser.make({ id: u.id }).get('this'), labNames(), null);
}

// ---------------------------------------------------------------- approvals

/** A PENDING_APPROVAL action-log row: a walltime extension request, or an action proposed by autopilot / AI triage. */
function walltimeItem(e, names) {
  var labId = e.lab ? String(e.lab.id) : null;
  var isExt = String(e.actionType) == 'EXTEND_WALLTIME';
  var m = isExt ? String(e.detail || '').match(/from ([\d.]+) h to ([\d.]+) h/) : null;
  var decided = e.outcome != 'PENDING_APPROVAL';
  return {
    id: 'ALE:' + e.id,
    kind: isExt ? 'WALLTIME_EXTENSION' : 'ACTION_CONFIRMATION',
    actionType: String(e.actionType),
    actor: String(e.actor),
    status: !decided ? 'PENDING' : e.outcome == 'DONE' ? 'APPROVED' : 'REJECTED',
    labId: labId,
    labName: labId ? names[labId] || labId : null,
    jobId: e.job ? e.job.id : null,
    runRequestId: null,
    requestedBy: e.job && e.job.user ? String(e.job.user) : String(e.actor),
    requestedAt: iso(e.actedAt),
    title: isExt ? 'Extend walltime of ' + (e.job ? e.job.jobName || e.job.id : 'job') + (m ? ' to ' + m[2] + ' h' : '') : 'Confirm ' + e.actionType + ' on ' + (e.job ? e.job.jobName || e.job.id : 'job') + ' (proposed by ' + String(e.actor).toLowerCase() + ')',
    detail: e.detail,
    amount: m ? round(Number(m[2]) - Number(m[1]), 2) : null,
    unit: isExt ? 'hours' : null,
  };
}

function runItem(r, names) {
  var labId = r.lab ? String(r.lab.id) : null;
  var st = String(r.approvalStatus || 'PENDING');
  return {
    id: 'RR:' + r.id,
    kind: 'RUN_APPROVAL',
    status: st == 'NOT_REQUIRED' ? 'APPROVED' : st,
    labId: labId,
    labName: labId ? names[labId] || labId : null,
    jobId: null,
    runRequestId: r.id,
    requestedBy: r.submittedBy && r.submittedBy.name ? String(r.submittedBy.name) : 'lab member',
    requestedAt: iso(r.createdAt),
    title: 'Approve run "' + r.name + '"',
    detail: r.approvalReason || 'A lab rule requires PI approval for this run.',
    amount: r.estGpuHours != null ? Number(r.estGpuHours) : null,
    unit: 'GPU-hours',
  };
}

function pendingApprovals(labId) {
  var me = actor();
  var scope = labId || null;
  if (me.user.role != 'UNIVERSITY_ADMIN') {
    if (scope != null && scope != me.user.labId) throw new Error(me.user.name + ' can only see approvals of their own lab');
    scope = me.user.labId;
  }
  var names = labNames();
  var items = [];
  var f = Filter.eq('outcome', 'PENDING_APPROVAL');
  if (scope) f = f.and().eq('lab.id', scope);
  ActionLogEntry.fetchObjStream({ filter: f, include: 'this, job.user, job.jobName' }).each(function (e) {
    items.push(walltimeItem(e, names));
  });
  var rf = Filter.eq('approvalStatus', 'PENDING');
  if (scope) rf = rf.and().eq('lab.id', scope);
  RunRequest.fetchObjStream({ filter: rf, include: 'this, submittedBy.name' }).each(function (r) {
    items.push(runItem(r, names));
  });
  items.sort(function (a, b) {
    return String(b.requestedAt).localeCompare(String(a.requestedAt));
  });
  var count = function (k) {
    return items.filter(function (i) {
      return i.kind == k;
    }).length;
  };
  return { items: items, counts: { total: items.length, walltime: count('WALLTIME_EXTENSION'), run: count('RUN_APPROVAL'), confirmation: count('ACTION_CONFIRMATION') } };
}

function decide(id, note, approve) {
  var me = actor();
  var parts = String(id || '').split(':');
  var kind = parts.shift();
  var key = parts.join(':');
  var names = labNames();
  var now = Date.now();
  var who = me.user.name + (me.user.role == 'UNIVERSITY_ADMIN' ? ' (Research Computing)' : me.user.role == 'PI' ? ' (PI)' : ' (job owner)');
  var suffix = note ? ' Note: ' + note : '';
  if (kind == 'ALE') {
    var e = ActionLogEntry.make({ id: key }).get('this, job.user, job.jobName');
    if (e == null) throw new Error('Approval ' + id + ' not found');
    if (e.outcome != 'PENDING_APPROVAL') throw new Error('Approval ' + id + ' was already decided');
    var ownJob = e.job && e.job.user != null && String(e.job.user) == String(me.user.username) && (me.user.role == 'STUDENT' || me.user.role == 'STAFF');
    if (ownJob && String(e.actionType) != 'EXTEND_WALLTIME') {
      // the job owner confirms (or declines) an action proposed for their own job
    } else {
      if (!capabilities(me.user.role).approve) throw new Error(me.user.name + ' (' + me.user.role + ') cannot approve or reject; ask the lab PI.');
      requireManager(me, e.lab ? String(e.lab.id) : null);
    }
    if (approve && e.job && String(e.actionType) != 'EXTEND_WALLTIME') {
      var done = Job.make({ id: e.job.id }).applyAction(String(e.actionType), 'ADMIN');
      ActionLogEntry.make({ id: e.id, outcome: done.outcome == 'DONE' ? 'DONE' : 'FAILED', detail: e.detail + ' — Confirmed by ' + who + '; ' + done.detail + suffix }).merge();
    } else if (approve && e.job) {
      var applied = Job.make({ id: e.job.id }).applyAction('EXTEND_WALLTIME', 'ADMIN');
      ActionLogEntry.make({ id: e.id, outcome: applied.outcome == 'DONE' ? 'DONE' : 'FAILED', detail: e.detail + ' — Approved by ' + who + '; ' + applied.detail + suffix }).merge();
    } else {
      ActionLogEntry.make({ id: e.id, outcome: 'FAILED', detail: e.detail + ' — ' + (approve ? 'Approved' : 'Declined') + ' by ' + who + '.' + suffix }).merge();
    }
    log.info('{} {} by {}', approve ? 'approve' : 'reject', id, me.user.id);
    return walltimeItem(ActionLogEntry.make({ id: e.id }).get('this, job.user, job.jobName'), names);
  }
  if (kind == 'RR') {
    if (!capabilities(me.user.role).approve) throw new Error(me.user.name + ' (' + me.user.role + ') cannot approve or reject; ask the lab PI.');
    var r = RunRequest.make({ id: key }).get('this, submittedBy.name');
    if (r == null) throw new Error('Approval ' + id + ' not found');
    if (r.approvalStatus != 'PENDING') throw new Error('Approval ' + id + ' is not pending');
    requireManager(me, r.lab ? String(r.lab.id) : null);
    var upd = { id: r.id, approvalStatus: approve ? 'APPROVED' : 'REJECTED', approvedBy: me.user.name, approvedAt: toDt(now), approvalReason: (r.approvalReason || '') + ' — ' + (approve ? 'Approved' : 'Rejected') + ' by ' + who + '.' + suffix };
    if (!approve) upd.status = 'REJECTED';
    RunRequest.make(upd).merge();
    log.info('{} {} by {}', approve ? 'approve' : 'reject', id, me.user.id);
    return runItem(RunRequest.make({ id: r.id }).get('this, submittedBy.name'), names);
  }
  throw new Error('Unknown approval id ' + id + '; expected ALE:<id> or RR:<id>');
}

function approve(id, note) {
  return decide(id, note, true);
}

function reject(id, note) {
  return decide(id, note, false);
}
