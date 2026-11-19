/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

var log = Logger.for('Advisor');

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers. Tool results are compact JSON text (agent tool results must be simple values) and every tool call
// is recorded as an Advisor.ToolCall row so the Assistant page can show which tools an answer used.
// ---------------------------------------------------------------------------------------------------------------

var WORKLOAD_TYPES = ['TRAINING', 'FINETUNE', 'INFERENCE', 'SIMULATION', 'DATA_PROCESSING', 'INTERACTIVE'];
var JOB_ACTIONS = ['EXTEND_WALLTIME', 'CANCEL', 'CHECKPOINT_NOW', 'REQUEUE_STANDBY', 'SCALE_DOWN', 'NOTIFY_PI', 'HOLD'];
var JOB_STATES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'OUT_OF_MEMORY', 'PREEMPTED'];
var MAX_RESULT = 7000;
var DAY_MS = 86400000;

/** C3 arrays and JS arrays to a plain JS array. */
function arr(x) {
  var out = [];
  if (x === null || x === undefined) return out;
  for (var i = 0; i < x.length; i++) out.push(x[i]);
  return out;
}

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function round(v, d) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  var f = Math.pow(10, d === undefined ? 1 : d);
  return Math.round(v * f) / f;
}

/** ISO text of a C3 DateTime / string, or null. */
function iso(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

function ms(v) {
  var s = iso(v);
  if (!s) return null;
  var t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function daysUntil(v) {
  var t = ms(v);
  return t === null ? null : round((t - Date.now()) / DAY_MS, 1);
}

function ref(v) {
  return v && v.id ? String(v.id) : null;
}

/** Converts a C3 value (obj, array, json) to plain JSON data. */
function plain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  try {
    if (typeof v.toJson === 'function') return v.toJson();
  } catch (e) {
    // fall through
  }
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (e2) {
    return String(v);
  }
}

/** JSON text of a tool result, cut to MAX_RESULT characters so the agent context stays small. */
function out(data) {
  var s = JSON.stringify(data);
  if (s.length > MAX_RESULT) s = s.substring(0, MAX_RESULT) + '... (truncated)';
  return s;
}

function canonicalOf(value, allowed, param) {
  var v = str(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (!v) return null;
  for (var i = 0; i < allowed.length; i++) {
    if (allowed[i] === v) return allowed[i];
  }
  throw new Error('Unknown ' + param + ' "' + value + '". Use one of: ' + allowed.join(', '));
}

/** Runs one tool body, records an Advisor.ToolCall row and returns the JSON text (or a JSON error the agent can read). */
function traced(tool, labId, args, summaryFn, body, render) {
  var started = Date.now();
  var ok = true;
  var data;
  try {
    data = body();
  } catch (e) {
    ok = false;
    data = { error: String(e && e.message ? e.message : e) };
  }
  var summary = ok ? summaryFn(data) : 'Error: ' + data.error;
  try {
    Advisor.ToolCall.make({
      name: tool,
      labId: labId || null,
      args: JSON.stringify(args),
      summary: str(summary).substring(0, 300),
      ok: ok,
      millis: Date.now() - started,
      calledAt: DateTime.now(),
    }).create();
  } catch (e3) {
    log.warn('Could not record tool call {}: {}', tool, e3);
  }
  return ok && render ? render(data) : out(data);
}

function requireLab(labId) {
  var id = str(labId);
  if (!id) throw new Error('labId is required. Known labs: ' + knownLabs());
  var found = Lab.fetch({
    filter: Filter.eq('id', id),
    include: 'id, name, piName, piEmail, department, researchArea, contextDump, slurmAccounts, fairShareTarget, preferredClusters, notes',
    limit: 1,
  }).objs;
  if (!found || found.length === 0) throw new Error('No lab with id "' + id + '". Known labs: ' + knownLabs());
  return found[0];
}

function knownLabs() {
  return arr(Lab.fetch({ include: 'id, name', limit: 50 }).objs)
    .map(function (l) {
      return l.id + ' (' + l.name + ')';
    })
    .join(', ');
}

function allocationsOf(labId) {
  return arr(
    Allocation.fetch({
      filter: Filter.eq('lab.id', labId),
      include: 'id, source, grantName, totalUnits, usedUnits, unitName, startDate, endDate, cluster.id, cluster.name, cluster.usdPerUnit',
      limit: 50,
    }).objs
  ).map(function (a) {
    var total = num(a.totalUnits) || 0;
    var used = num(a.usedUnits) || 0;
    var usd = a.cluster ? num(a.cluster.usdPerUnit) : null;
    return {
      allocationId: a.id,
      cluster: ref(a.cluster),
      source: str(a.source),
      grant: str(a.grantName),
      unit: str(a.unitName),
      total: round(total, 1),
      used: round(used, 1),
      remaining: round(total - used, 1),
      usedPct: total > 0 ? round((100 * used) / total, 1) : null,
      remainingUsd: usd !== null ? round((total - used) * usd, 0) : null,
      endDate: iso(a.endDate),
      daysLeft: daysUntil(a.endDate),
    };
  });
}

function projectsOf(labId) {
  return arr(
    Project.fetch({
      filter: Filter.eq('lab.id', labId),
      include: 'id, name, description, deadline, deadlineLabel, priority, workloadType',
      order: 'ascending(deadline)',
      limit: 50,
    }).objs
  ).map(function (p) {
    return {
      projectId: p.id,
      name: str(p.name),
      deadlineLabel: str(p.deadlineLabel),
      deadline: iso(p.deadline),
      daysToDeadline: daysUntil(p.deadline),
      priority: num(p.priority),
      workloadType: str(p.workloadType),
      description: str(p.description).substring(0, 240),
    };
  });
}

/** Finds a lab project by id or by a word of its name / deadline label (e.g. "NeurIPS"). */
function findProject(labId, key) {
  var k = str(key).toLowerCase();
  if (!k) return null;
  var ps = projectsOf(labId);
  for (var i = 0; i < ps.length; i++) if (ps[i].projectId.toLowerCase() === k) return ps[i];
  for (var j = 0; j < ps.length; j++) {
    var hay = (ps[j].name + ' ' + ps[j].deadlineLabel + ' ' + ps[j].description).toLowerCase();
    if (hay.indexOf(k) >= 0) return ps[j];
  }
  var words = k.split(/[^a-z0-9]+/).filter(function (w) {
    return w.length > 2;
  });
  var best = null;
  var bestScore = 0;
  ps.forEach(function (p) {
    var hay2 = (p.name + ' ' + p.deadlineLabel + ' ' + p.description).toLowerCase();
    var score = words.filter(function (w) {
      return hay2.indexOf(w) >= 0;
    }).length;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic constraint parser (used when no LLM is available, and as the base the LLM result is merged onto).
// ---------------------------------------------------------------------------------------------------------------

var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
var WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
var CLUSTER_WORDS = [
  { id: 'anvil', re: /\banvil\b/i },
  { id: 'gilbreth', re: /\bgilbreth\b/i },
  { id: 'gautschi', re: /\bgautschi\b/i },
  { id: 'negishi', re: /\bnegishi\b/i },
  { id: 'bell', re: /\bbell\b/i },
  { id: 'aws-p4d', re: /\b(aws|p4d|ec2|amazon)\b/i },
];
var GPU_WORDS = [
  { id: 'H200', re: /\bh200\b/i },
  { id: 'H100-80GB', re: /\bh100s?\b/i },
  { id: 'A100-80GB', re: /\ba100[- ]?80(gb)?\b/i },
  { id: 'A100-40GB', re: /\ba100[- ]?40(gb)?\b/i },
  { id: 'A100', re: /\ba100s?\b(?![- ]?[48]0)/i },
  { id: 'A30', re: /\ba30s?\b/i },
  { id: 'A10', re: /\ba10s?\b/i },
  { id: 'L40S', re: /\bl40s\b/i },
  { id: 'V100', re: /\bv100s?\b/i },
  { id: 'T4', re: /\bt4s?\b/i },
  { id: 'MI250', re: /\bmi250x?\b/i },
];
var RESTRICTIONS = [
  { kind: 'HIPAA', re: /\b(hipaa|phi|protected health|patient|clinical|medical record|ehr)\b/i, text: 'Protected health data (HIPAA): keep on approved on-prem storage; no third-party cloud.' },
  { kind: 'EXPORT_CONTROL', re: /\b(itar|ear\b|export[- ]controlled|export control)/i, text: 'Export-controlled (ITAR/EAR) work: US-person access only, approved clusters only.' },
  { kind: 'CUI', re: /\b(cui|controlled unclassified|nist 800-171)\b/i, text: 'Controlled Unclassified Information: NIST 800-171 environment required.' },
  { kind: 'FERPA', re: /\b(ferpa|student records?)\b/i, text: 'Student records (FERPA): restricted handling.' },
  { kind: 'PII', re: /\b(pii|personally identifiable|human subjects?|irb)\b/i, text: 'Personal / human-subjects data: IRB protocol limits where data may live.' },
  { kind: 'NO_CLOUD', re: /\b(no|never|not|avoid|cannot|can't|must not)\b[^.;\n]{0,40}\b(cloud|aws|ec2|off[- ]?prem|off[- ]?campus)\b|\b(on[- ]?prem(ise)?s?( only)?|stay(s)? on campus|must stay at purdue|not leave purdue)\b/i, text: 'Data must stay on Purdue (on-prem) resources: no third-party cloud.' },
  { kind: 'DATA_RESIDENCY', re: /\b(data residency|must reside|stay in the us|us[- ]only|on depot only)\b/i, text: 'Data residency requirement.' },
  { kind: 'LICENSED_DATA', re: /\b(licen[cs]ed data|data use agreement|dua)\b/i, text: 'Licensed data under a data use agreement.' },
];

function nextWeekday(dow, ref) {
  var d = new Date(ref);
  var diff = (dow - d.getUTCDay() + 7) % 7;
  if (diff === 0) diff = 7;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(23, 59, 0, 0);
  return d;
}

/** Parses one date mention ("May 15", "2027-06-30", "15 May 2027", "Friday", "end of June") relative to `refMs`. */
function parseDateText(text, refMs) {
  var s = str(text).toLowerCase();
  if (!s) return null;
  var ref0 = refMs || Date.now();
  var m = s.match(/\b(20\d\d)-(\d\d)-(\d\d)/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59));
  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d\d|\d\d))?\b/);
  if (m) return fixYear(+m[1] - 1, +m[2], m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null, ref0);
  var monRe = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  m = s.match(new RegExp('\\b' + monRe + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?'));
  if (m) return fixYear(MONTHS.indexOf(m[1].substring(0, 3)), +m[2], m[3] ? +m[3] : null, ref0);
  m = s.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + monRe + '(?:,?\\s+(20\\d\\d))?'));
  if (m) return fixYear(MONTHS.indexOf(m[2].substring(0, 3)), +m[1], m[3] ? +m[3] : null, ref0);
  m = s.match(new RegExp('\\b(?:end of|through|thru|until|by)\\s+' + monRe + '(?:\\s+(20\\d\\d))?'));
  if (m) {
    var mon = MONTHS.indexOf(m[1].substring(0, 3));
    var d0 = fixYear(mon, 1, m[2] ? +m[2] : null, ref0);
    return new Date(Date.UTC(d0.getUTCFullYear(), mon + 1, 0, 23, 59));
  }
  for (var i = 0; i < WEEKDAYS.length; i++) {
    if (new RegExp('\\b' + WEEKDAYS[i].substring(0, 3) + '(' + WEEKDAYS[i].substring(3) + ')?\\b').test(s)) return nextWeekday(i, ref0);
  }
  if (/\btomorrow\b/.test(s)) return new Date(ref0 + DAY_MS);
  m = s.match(/\bin (\d+) (day|week)s?\b/);
  if (m) return new Date(ref0 + +m[1] * (m[2] === 'week' ? 7 : 1) * DAY_MS);
  return null;
}

/** A month/day without a year means the next occurrence on or after today. */
function fixYear(month, day, year, ref0) {
  if (month < 0 || day < 1 || day > 31) return null;
  if (year) return new Date(Date.UTC(year, month, day, 23, 59));
  var y = new Date(ref0).getUTCFullYear();
  var d = new Date(Date.UTC(y, month, day, 23, 59));
  if (d.getTime() < ref0 - DAY_MS) d = new Date(Date.UTC(y + 1, month, day, 23, 59));
  return d;
}

function amountOf(numText, suffix) {
  var n = parseFloat(String(numText).replace(/,/g, ''));
  var sfx = str(suffix).toLowerCase();
  if (sfx === 'k') n *= 1e3;
  else if (sfx === 'm' || sfx === 'million') n *= 1e6;
  return n;
}

function sentencesOf(text) {
  return str(text)
    .replace(/([.!?;])\s+/g, '$1\n')
    .split(/\n+/)
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return s.length > 0;
    });
}

/**
 * Rules-based constraint extraction. Returns the same shape as Advisor.extractConstraints:
 * { source, budgets[], deadlines[], preferences{}, dataRestrictions[], memberCaps[], approvals[], summary, warnings[] }.
 */
function parseConstraintsText(text, refMs) {
  var ref0 = refMs || Date.now();
  var res = {
    source: 'rules',
    budgets: [],
    deadlines: [],
    preferences: { clusters: [], gpuTypes: [], avoid: [], preemptibleOk: null, maxWalltimeHours: null, quietHours: null, notes: [] },
    dataRestrictions: [],
    memberCaps: [],
    approvals: [],
    summary: '',
    warnings: [],
  };
  var seenDeadline = {};
  var seenRestriction = {};
  sentencesOf(text).forEach(function (s) {
    var low = s.toLowerCase();
    var negative = /\b(no|never|not|avoid|don't|do not|without|can't|cannot|must not|hate|stay off)\b/.test(low);

    // budgets: dollars, SUs, GPU-hours, GPU-years
    var m;
    var reUsd = /\$\s?([\d,.]+)\s?(k|m|million)?\b/gi;
    while ((m = reUsd.exec(s)) !== null) {
      var perUnit = /^\s*(\/|per)\s*(gpu|hour|hr|su|node)/i.test(s.substring(m.index + m[0].length));
      if (perUnit) continue;
      res.budgets.push({ kind: 'USD', amount: round(amountOf(m[1], m[2]), 0), period: periodOf(low), scope: scopeOf(s), evidence: s });
    }
    var reUnits = /([\d][\d,.]*)\s?(k|m|million)?\s*(sus?|service units|gpu[- ]?hours?|gpu[- ]?hrs?|node[- ]?hours?|gpu[- ]?years?)\b/gi;
    while ((m = reUnits.exec(s)) !== null) {
      var unit = m[3].toLowerCase();
      var kind = /^su|service/.test(unit) ? 'SU' : /node/.test(unit) ? 'NODE_HOURS' : /year/.test(unit) ? 'GPU_YEARS' : 'GPU_HOURS';
      var amt = amountOf(m[1], m[2]);
      var b = { kind: kind, amount: round(amt, 1), period: periodOf(low), scope: scopeOf(s), evidence: s };
      if (kind === 'GPU_YEARS') b.gpuHoursEquivalent = round(amt * 8760, 0);
      if (/\b(approv\w*|threshold|sign[- ]off)\b/.test(low) || (/\b(limit|cap|max|maximum|at most|no more than)\b/.test(low) && /\b(job|run)\b/.test(low))) {
        continue; // per-job limits / approval thresholds are handled below
      }
      res.budgets.push(b);
    }

    // per-member caps ("Maya's cap 20%", "students capped at 15% of the budget")
    var reCap = /([A-Z][a-z]+|students?|postdocs?|undergrads?|each member|members?)(?:'s)?\s+(?:is\s+)?(?:cap(?:ped)?|limit(?:ed)?|max(?:imum)?)\s*(?:at|of|to|is)?\s*(\d{1,3})\s?%/g;
    while ((m = reCap.exec(s)) !== null) res.memberCaps.push({ who: m[1], pct: +m[2], evidence: s });

    // PI approval thresholds
    m = low.match(/(?:pi|advisor|professor)\s+(?:must\s+)?(?:approv\w*|sign[- ]off)[^.]*?(?:above|over|more than|>)\s*\$?\s?([\d,.]+)\s?(k)?\s*(gpu[- ]?hours?|gpu[- ]?hrs?|sus?|dollars|usd)?/);
    if (!m) m = low.match(/(?:above|over|more than|>)\s*\$?\s?([\d,.]+)\s?(k)?\s*(gpu[- ]?hours?|gpu[- ]?hrs?|sus?|dollars|usd)?[^.]*?(?:need|require)s?\s+(?:pi\s+)?approv/);
    if (m) {
      res.approvals.push({
        threshold: round(amountOf(m[1], m[2]), 0),
        unit: m[3] ? (/su/.test(m[3]) ? 'SU' : /gpu/.test(m[3]) ? 'GPU_HOURS' : 'USD') : /\$/.test(s) ? 'USD' : 'GPU_HOURS',
        evidence: s,
      });
    }

    // deadlines: a date mention in a sentence that talks about a deadline / venue / defense / report
    if (/\b(deadline|due|submission|submit|camera[- ]ready|rebuttal|defen[cs]e|report|neurips|icml|iclr|cvpr|aaai|kdd|acl|emnlp|sc\d\d|review|demo|by)\b/.test(low)) {
      var dt = parseDateText(s, ref0);
      if (dt) {
        var label = deadlineLabel(s);
        var key = label + '|' + dt.toISOString().substring(0, 10);
        if (!seenDeadline[key]) {
          seenDeadline[key] = true;
          res.deadlines.push({ label: label, date: dt.toISOString(), daysAway: round((dt.getTime() - ref0) / DAY_MS, 1), evidence: s });
        }
      }
    }

    // preferences
    CLUSTER_WORDS.forEach(function (c) {
      if (!c.re.test(s)) return;
      if (negative && clauseNegates(low, c.re)) pushUnique(res.preferences.avoid, c.id);
      else if (/\b(prefer\w*|like|want|favou?r\w*|usually|mostly|default|best|first choice)\b/.test(low)) pushUnique(res.preferences.clusters, c.id);
    });
    GPU_WORDS.forEach(function (g) {
      if (!g.re.test(s)) return;
      if (negative && clauseNegates(low, g.re)) pushUnique(res.preferences.avoid, g.id);
      else if (/\b(prefer|like|want|use|favor|favour|best|fastest|our|own|bought|purchased)\b/.test(low)) pushUnique(res.preferences.gpuTypes, g.id);
    });
    if (/\b(preempt\w*|standby|spot)\b/.test(low)) {
      if (negative) {
        res.preferences.preemptibleOk = false;
        pushUnique(res.preferences.avoid, 'preemptible/standby');
      } else if (/\b(ok|fine|happy|prefer|use|cheap|accept)\b/.test(low)) res.preferences.preemptibleOk = true;
    }
    m = low.match(/(?:max(?:imum)?|no more than|at most|cap|limit)\s*(?:walltime|wall time|runtime|jobs?)?\s*(?:of|at|to)?\s*(\d+(?:\.\d+)?)\s*(h|hours?|hrs?|days?)\b/);
    if (m && /wall|runtime|job|run/.test(low)) res.preferences.maxWalltimeHours = round(+m[1] * (/^d/.test(m[2]) ? 24 : 1), 1);
    m = low.match(/quiet hours?[^0-9]*(\d{1,2}(?::\d\d)?\s*(?:am|pm)?)\s*(?:-|to|–)\s*(\d{1,2}(?::\d\d)?\s*(?:am|pm)?)/);
    if (m) res.preferences.quietHours = m[1].trim() + '-' + m[2].trim();
    if (/\b(checkpoint\w*)\b/.test(low)) pushUnique(res.preferences.notes, s);
    else if (/\b(prefer|always|never|only|must|should)\b/.test(low) && res.preferences.notes.length < 8 && !/\$|\bsu\b|gpu[- ]?hours?/.test(low)) {
      pushUnique(res.preferences.notes, s);
    }

    // data restrictions
    RESTRICTIONS.forEach(function (r) {
      if (r.re.test(s) && !seenRestriction[r.kind]) {
        seenRestriction[r.kind] = true;
        res.dataRestrictions.push({ kind: r.kind, description: r.text, evidence: s });
      }
    });
  });
  if (seenRestriction.HIPAA || seenRestriction.EXPORT_CONTROL || seenRestriction.CUI || seenRestriction.NO_CLOUD) {
    pushUnique(res.preferences.avoid, 'aws-p4d');
    res.preferences.clusters = res.preferences.clusters.filter(function (c) {
      return c !== 'aws-p4d';
    });
  }
  res.deadlines.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  res.summary = summarize(res);
  if (!str(text)) res.warnings.push('The lab has not pasted any context yet.');
  else if (!res.budgets.length && !res.deadlines.length && !res.dataRestrictions.length) res.warnings.push('No budget, deadline or data restriction found in the text.');
  return res;
}

function pushUnique(list, v) {
  if (list.indexOf(v) < 0) list.push(v);
}

/** True when a negation word appears in the same clause before the match. */
function clauseNegates(low, re) {
  var clauses = low.split(/[,;:]|\bbut\b|\bwhile\b|\bhowever\b/);
  for (var i = 0; i < clauses.length; i++) {
    if (re.test(clauses[i]) && /\b(no|never|not|avoid|don't|do not|without|can't|cannot|must not|stay off)\b/.test(clauses[i])) return true;
  }
  return false;
}

function periodOf(low) {
  if (/\b(per|a|each|every)\s+month|monthly\b/.test(low)) return 'MONTH';
  if (/\b(per|a|each|every)\s+week|weekly\b/.test(low)) return 'WEEK';
  if (/\b(per|a|each|every)\s+(year|fy)|annual|yearly|fiscal year\b/.test(low)) return 'YEAR';
  if (/\bsemester\b/.test(low)) return 'SEMESTER';
  if (/\b(left|remaining|remain)\b/.test(low)) return 'REMAINING';
  return 'TOTAL';
}

function scopeOf(s) {
  var m = s.match(/\b(NSF|NIH|DOE|DARPA|ONR|AFOSR|ARL|USDA|NASA|ACCESS|startup|department|industry)\b(?:\s+(?!through|thru|on|for|until|gives|is|of|ends|expires)[A-Za-z][\w-]*){0,3}/i);
  if (m) return m[0].trim();
  for (var i = 0; i < CLUSTER_WORDS.length; i++) if (CLUSTER_WORDS[i].re.test(s)) return CLUSTER_WORDS[i].id;
  return null;
}

function deadlineLabel(s) {
  var m = s.match(/\b(NeurIPS|ICML|ICLR|CVPR|ECCV|ICCV|AAAI|IJCAI|KDD|ACL|EMNLP|NAACL|SC\d\d|SIGGRAPH|MICCAI|ISMB|RECOMB)\b[^,.;]{0,30}/i);
  if (m) return m[0].replace(/\s+(is|on|by|due|deadline)\b.*$/i, '').trim();
  m = s.match(/\b(thesis defen[cs]e|defen[cs]e|grant report|annual report|progress report|camera[- ]ready|rebuttal|renewal|proposal|demo)\b/i);
  if (m) return m[0];
  return s.length > 60 ? s.substring(0, 57) + '...' : s;
}

function summarize(r) {
  var parts = [];
  if (r.budgets.length) {
    parts.push(
      r.budgets
        .slice(0, 3)
        .map(function (b) {
          return (b.kind === 'USD' ? '$' + b.amount : b.amount + ' ' + b.kind.replace('_', '-').toLowerCase()) + (b.scope ? ' (' + b.scope + ')' : '');
        })
        .join(', ')
    );
  }
  if (r.deadlines.length) {
    parts.push(
      'deadlines: ' +
        r.deadlines
          .slice(0, 3)
          .map(function (d) {
            return d.label + ' ' + d.date.substring(0, 10);
          })
          .join(', ')
    );
  }
  if (r.preferences.clusters.length) parts.push('prefers ' + r.preferences.clusters.join('/'));
  if (r.preferences.avoid.length) parts.push('avoids ' + r.preferences.avoid.join('/'));
  if (r.dataRestrictions.length) {
    parts.push(
      'data: ' +
        r.dataRestrictions
          .map(function (d) {
            return d.kind;
          })
          .join(', ')
    );
  }
  return parts.join('; ');
}

/** Stable 32-bit hash of the context text (cache key for Advisor.ConstraintSet). */
function textHash(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8) + '-' + s.length;
}

function parseConstraintsRules(labId, text) {
  var t = str(text);
  var lab = null;
  if (str(labId)) lab = requireLab(labId);
  if (!t && lab) t = str(lab.contextDump);
  var res = parseConstraintsText(t, Date.now());
  res.labId = lab ? lab.id : null;
  res.inputText = t;
  res.textHash = textHash(t);
  return JSON.stringify(res);
}

/** Best constraints known for the lab: the cached LLM parse of the current context text, else the rules parse. */
function constraintsFor(lab) {
  var t = str(lab.contextDump);
  var h = textHash(t);
  try {
    var c = Advisor.ConstraintSet.fetch({ filter: Filter.eq('id', lab.id), include: 'id, textHash, result', limit: 1 }).objs;
    if (c && c.length && c[0].textHash === h && c[0].result) return JSON.parse(c[0].result);
  } catch (e) {
    log.warn('constraint cache read failed: {}', e);
  }
  return parseConstraintsText(t, Date.now());
}

/** Writes the constraint cache row (called by extractConstraints in Python). */
function saveConstraints(labId, hash, resultJson, source) {
  Advisor.ConstraintSet.make({ id: labId, textHash: hash, result: resultJson, source: source, parsedAt: DateTime.now() }).merge();
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Read-only agent tools.
// ---------------------------------------------------------------------------------------------------------------

function labContext(labId) {
  return traced(
    'labContext',
    labId,
    { labId: labId },
    function (d) {
      return d.lab.name + ': ' + d.allocations.length + ' allocations, ' + d.projects.length + ' projects';
    },
    function () {
      var lab = requireLab(labId);
      var c = constraintsFor(lab);
      delete c.inputText;
      return {
        lab: {
          labId: lab.id,
          name: str(lab.name),
          pi: str(lab.piName),
          department: str(lab.department),
          researchArea: str(lab.researchArea),
          slurmAccounts: str(lab.slurmAccounts),
          fairShareTarget: num(lab.fairShareTarget),
          preferredClusters: str(lab.preferredClusters),
          notes: str(lab.notes).substring(0, 400),
        },
        today: new Date().toISOString(),
        allocations: allocationsOf(lab.id),
        projects: projectsOf(lab.id),
        constraints: c,
        contextDump: str(lab.contextDump).substring(0, 1500),
      };
    }
  );
}

function labSummary(labId) {
  return traced(
    'labSummary',
    labId,
    { labId: labId },
    function () {
      return 'Lab dashboard numbers';
    },
    function () {
      requireLab(labId);
      return plain(Insights.labSummary(str(labId)));
    }
  );
}

function listPolicies(labId, clusterId, kind) {
  return traced(
    'listPolicies',
    labId,
    { labId: labId, clusterId: clusterId, kind: kind },
    function (d) {
      return d.count + ' policies';
    },
    function () {
      var k = kind ? canonicalOf(kind, ['MAX_WALLTIME', 'MAX_GPUS_PER_JOB', 'MAX_NODES_PER_JOB', 'MAX_JOBS_PER_USER', 'ALLOWED_GPU_TYPES', 'BUDGET_REMAINING', 'DEADLINE_FEASIBLE', 'FAIRSHARE_CAP', 'PREEMPTIBLE_ONLY', 'DATA_RESIDENCY', 'EXPORT_CONTROL', 'MIN_GPU_UTIL', 'QUIET_HOURS'], 'kind') : null;
      var cl = str(clusterId).toLowerCase();
      var lab = str(labId);
      var rows = arr(
        Policy.fetch({
          filter: Filter.eq('active', true),
          include: 'id, scope, kind, severity, title, description, limitValue, limitText, sourceUrl, cluster.id, partition.id, lab.id',
          order: 'ascending(id)',
          limit: 200,
        }).objs
      )
        .filter(function (p) {
          if (k && str(p.kind) !== k) return false;
          var pl = ref(p.lab);
          if (pl && lab && pl !== lab) return false;
          if (pl && !lab) return false;
          var pc = ref(p.cluster) || (p.partition ? String(ref(p.partition)).split('-')[0] : null);
          if (cl && pc && pc.toLowerCase() !== cl) return false;
          return true;
        })
        .map(function (p) {
          return {
            policyId: p.id,
            scope: str(p.scope),
            kind: str(p.kind),
            severity: str(p.severity),
            title: str(p.title),
            description: str(p.description).substring(0, 220),
            cluster: ref(p.cluster),
            partition: ref(p.partition),
            limitValue: num(p.limitValue),
            limitText: str(p.limitText) || null,
            sourceUrl: str(p.sourceUrl) || null,
          };
        });
      return { count: rows.length, policies: rows.slice(0, 40) };
    }
  );
}

function predictDuration(workloadType, gpuTypeId, gpus, modelParamsB) {
  return traced(
    'predictDuration',
    null,
    { workloadType: workloadType, gpuTypeId: gpuTypeId, gpus: gpus, modelParamsB: modelParamsB },
    function () {
      return 'Duration estimate from history';
    },
    function () {
      var wt = canonicalOf(workloadType || 'TRAINING', WORKLOAD_TYPES, 'workloadType');
      return plain(Insights.predictDuration(wt, str(gpuTypeId) || 'A100-40GB', num(gpus) || 1, num(modelParamsB) || 0));
    }
  );
}

/** Reads an estimated GPU-hours figure out of an Insights.predictDuration result, whatever its exact keys. */
function gpuHoursFrom(pred, gpus) {
  if (!pred) return null;
  var keys = ['estGpuHours', 'gpuHours', 'expectedGpuHours'];
  for (var i = 0; i < keys.length; i++) if (num(pred[keys[i]]) !== null) return num(pred[keys[i]]);
  var hk = ['estDurationHours', 'durationHours', 'expectedHours', 'hours', 'p50Hours', 'medianHours'];
  for (var j = 0; j < hk.length; j++) if (num(pred[hk[j]]) !== null) return num(pred[hk[j]]) * (gpus || 1);
  return null;
}

// c3-analysis-disable c3-excessive-method-params -- flat optional arguments are easier for an LLM tool caller than a spec object.
function evaluateRun(labId, name, description, workloadType, project, gpuTypeId, gpus, walltimeHours, clusterId, modelParamsB, datasetGb, deadline) {
  return traced(
    'evaluateRun',
    labId,
    { labId: labId, name: name, workloadType: workloadType, project: project, gpuTypeId: gpuTypeId, gpus: gpus, walltimeHours: walltimeHours, clusterId: clusterId, modelParamsB: modelParamsB, deadline: deadline },
    function (d) {
      return d.checks.fail + ' FAIL / ' + d.checks.warn + ' WARN / ' + d.checks.pass + ' PASS; ' + d.plans.length + ' plans';
    },
    function () {
      var lab = requireLab(labId);
      var proj = project ? findProject(lab.id, project) : null;
      var wt = workloadType ? canonicalOf(workloadType, WORKLOAD_TYPES, 'workloadType') : proj && proj.workloadType ? proj.workloadType : 'TRAINING';
      var dl = null;
      if (str(deadline)) {
        dl = parseDateText(deadline, Date.now());
        if (!dl) throw new Error('Could not read deadline "' + deadline + '"; use YYYY-MM-DD or a weekday name.');
      } else if (proj && proj.deadline) dl = new Date(Date.parse(proj.deadline));
      var g = num(gpus);
      var gt = str(gpuTypeId);
      var est = null;
      try {
        est = gpuHoursFrom(plain(Insights.predictDuration(wt, gt || 'A100-40GB', g || 1, num(modelParamsB) || 0)), g || 1);
      } catch (e) {
        log.warn('predictDuration failed: {}', e);
      }
      var spec = {
        lab: { id: lab.id },
        name: '[Advisor] ' + (str(name) || (proj ? proj.name : wt.toLowerCase() + ' run')),
        description: str(description) || (proj ? proj.description : ''),
        workloadType: wt,
        status: 'DRAFT',
        createdAt: DateTime.now(),
      };
      if (proj) spec.project = { id: proj.projectId };
      if (num(modelParamsB) !== null) spec.modelParamsB = num(modelParamsB);
      if (num(datasetGb) !== null) spec.datasetGb = num(datasetGb);
      if (est !== null) spec.estGpuHours = round(est, 1);
      if (g !== null) spec.requestedGpus = Math.round(g);
      if (gt) spec.requestedGpuType = { id: gt };
      if (num(walltimeHours) !== null) spec.requestedWalltimeHours = num(walltimeHours);
      if (str(clusterId)) spec.requestedCluster = { id: str(clusterId).toLowerCase() };
      if (dl) spec.deadline = DateTime.fromString(dl.toISOString());
      var rr = RunRequest.make(spec).create();
      var rrId = rr.id;
      RunRequest.forId(rrId).get().checkRules();
      var planError = null;
      try {
        RunRequest.forId(rrId).get().recommendPlans();
      } catch (e2) {
        planError = String(e2 && e2.message ? e2.message : e2);
      }
      var checks = arr(
        RuleCheck.fetch({
          filter: Filter.eq('runRequest.id', rrId),
          include: 'id, outcome, message, title, ruleKind, severity, scope, policy.id',
          limit: 200,
        }).objs
      );
      var counts = { pass: 0, warn: 0, fail: 0 };
      checks.forEach(function (c) {
        var o = str(c.outcome).toLowerCase();
        if (counts[o] !== undefined) counts[o]++;
      });
      var order = { FAIL: 0, WARN: 1, PASS: 2 };
      var items = checks
        .sort(function (a, b) {
          return (order[str(a.outcome)] || 3) - (order[str(b.outcome)] || 3);
        })
        .filter(function (c) {
          return str(c.outcome) !== 'PASS';
        })
        .slice(0, 12)
        .map(function (c) {
          return {
            outcome: str(c.outcome),
            rule: (ref(c.policy) ? ref(c.policy) + ' ' : '') + str(c.title),
            kind: str(c.ruleKind),
            severity: str(c.severity),
            message: str(c.message).substring(0, 240),
          };
        });
      var plans = arr(
        RunPlan.fetch({
          filter: Filter.eq('runRequest.id', rrId),
          include: 'id, rank, label, cluster.id, partition.id, gpuType.id, gpus, nodes, walltimeHours, estWaitHours, estDurationHours, estCostUnits, estCostUsd, meetsDeadline, score, rationale, finishBy, deadlineSlackHours, qos, waitBucket, chainedJobs, preemptionRisk',
          order: 'ascending(rank)',
          limit: 5,
        }).objs
      ).map(function (p) {
        return {
          planId: p.id,
          rank: num(p.rank),
          label: str(p.label),
          cluster: ref(p.cluster),
          partition: ref(p.partition),
          gpuType: ref(p.gpuType),
          gpus: num(p.gpus),
          nodes: num(p.nodes),
          walltimeHours: num(p.walltimeHours),
          estWaitHours: round(num(p.estWaitHours), 1),
          estDurationHours: round(num(p.estDurationHours), 1),
          estFinish: iso(p.finishBy) || new Date(Date.now() + ((num(p.estWaitHours) || 0) + (num(p.estDurationHours) || 0)) * 3600000).toISOString(),
          deadlineSlackHours: round(num(p.deadlineSlackHours), 1),
          qos: str(p.qos) || null,
          waitBucket: str(p.waitBucket) || null,
          chainedJobs: num(p.chainedJobs),
          preemptionRisk: round(num(p.preemptionRisk), 2),
          estCostUnits: round(num(p.estCostUnits), 1),
          estCostUsd: round(num(p.estCostUsd), 0),
          meetsDeadline: p.meetsDeadline === true,
          score: round(num(p.score), 2),
          rationale: str(p.rationale).substring(0, 300),
        };
      });
      var status = RunRequest.fetch({ filter: Filter.eq('id', rrId), include: 'id, status, estGpuHours', limit: 1 }).objs[0];
      return {
        runRequestId: rrId,
        status: str(status.status),
        project: proj ? proj.name + (proj.deadlineLabel ? ' (' + proj.deadlineLabel + ')' : '') : null,
        workloadType: wt,
        estGpuHours: num(status.estGpuHours),
        deadline: dl ? dl.toISOString() : null,
        hoursToDeadline: dl ? round((dl.getTime() - Date.now()) / 3600000, 1) : null,
        checks: { pass: counts.pass, warn: counts.warn, fail: counts.fail, items: items },
        plans: plans,
        planError: planError,
        allocations: allocationsOf(lab.id),
        note: 'Draft only; nothing was submitted. To submit, call proposeRunSubmission(runRequestId, planId) and ask the user to confirm.',
      };
    }
  );
}
// c3-analysis-enable c3-excessive-method-params

function latestMetric(jobId) {
  var m = JobMetric.fetch({
    filter: Filter.eq('job.id', jobId),
    include: 'ts, gpuUtilPct, gpuMemPct, cpuUtilPct, memPct, powerW, checkpointAgeMin, trainingLoss',
    order: 'descending(ts)',
    limit: 1,
  }).objs;
  return m && m.length ? m[0] : null;
}

function openAlerts(filter) {
  return arr(
    JobAlert.fetch({
      filter: filter,
      include: 'id, job.id, alertType, severity, status, message, recommendedAction, detectedAt',
      order: 'descending(detectedAt)',
      limit: 200,
    }).objs
  ).filter(function (a) {
    return str(a.status) === 'OPEN' || str(a.status) === 'ACKED';
  });
}

function jobRow(j, metric, alerts) {
  var left = num(j.timelimitHours) !== null && num(j.elapsedHours) !== null ? round(num(j.timelimitHours) - num(j.elapsedHours), 1) : null;
  return {
    jobId: j.id,
    name: str(j.jobName),
    user: str(j.user),
    lab: ref(j.lab),
    project: ref(j.project),
    cluster: ref(j.cluster),
    partition: ref(j.partition),
    state: str(j.state),
    gpus: num(j.allocGpus),
    gpuType: ref(j.gpuType),
    elapsedHours: round(num(j.elapsedHours), 1),
    timelimitHours: num(j.timelimitHours),
    walltimeLeftHours: left,
    costUsd: round(num(j.costUsd), 0),
    latest: metric
      ? {
          at: iso(metric.ts),
          gpuUtilPct: round(num(metric.gpuUtilPct), 0),
          gpuMemPct: round(num(metric.gpuMemPct), 0),
          cpuUtilPct: round(num(metric.cpuUtilPct), 0),
          memPct: round(num(metric.memPct), 0),
          powerW: round(num(metric.powerW), 0),
          checkpointAgeMin: round(num(metric.checkpointAgeMin), 0),
        }
      : null,
    alerts: alerts.map(function (a) {
      return { alertId: a.id, alertType: str(a.alertType), severity: str(a.severity), message: str(a.message).substring(0, 200), recommendedAction: str(a.recommendedAction) };
    }),
  };
}

var JOB_INCLUDE = 'id, jobName, user, lab.id, project.id, cluster.id, partition.id, state, allocGpus, gpuType.id, elapsedHours, timelimitHours, costUsd, gpuUtilAvg, isLive';

function liveJobs(labId, state) {
  return traced(
    'liveJobs',
    labId,
    { labId: labId, state: state },
    function (d) {
      return d.count + ' live jobs, ' + d.withAlerts + ' with alerts';
    },
    function () {
      var st = state ? canonicalOf(state, JOB_STATES, 'state') : null;
      var f = Filter.eq('isLive', true);
      if (str(labId)) f = f.and().eq('lab.id', str(labId));
      if (st) f = f.and().eq('state', st);
      var jobs = arr(Job.fetch({ filter: f, include: JOB_INCLUDE, order: 'descending(submitTime)', limit: 40 }).objs);
      var af = Filter.eq('job.isLive', true);
      if (str(labId)) af = af.and().eq('lab.id', str(labId));
      var byJob = {};
      openAlerts(af).forEach(function (a) {
        var id = ref(a.job);
        (byJob[id] = byJob[id] || []).push(a);
      });
      var rows = jobs.map(function (j) {
        return jobRow(j, latestMetric(j.id), byJob[j.id] || []);
      });
      return {
        count: rows.length,
        withAlerts: rows.filter(function (r) {
          return r.alerts.length > 0;
        }).length,
        jobs: rows,
      };
    }
  );
}

function jobHealth(jobId) {
  return traced(
    'jobHealth',
    null,
    { jobId: jobId },
    function (d) {
      return d.job.jobId + ': ' + d.job.state + ', ' + d.job.alerts.length + ' alerts';
    },
    function () {
      var id = str(jobId);
      if (!id) throw new Error('jobId is required (see liveJobs).');
      var found = Job.fetch({ filter: Filter.eq('id', id), include: JOB_INCLUDE, limit: 1 }).objs;
      if (!found || found.length === 0) throw new Error('No job with id "' + id + '". Use liveJobs to list job ids.');
      var j = found[0];
      try {
        Job.forId(id).get().evaluateHealth();
      } catch (e) {
        log.warn('evaluateHealth failed for {}: {}', id, e);
      }
      var metrics = arr(
        JobMetric.fetch({
          filter: Filter.eq('job.id', id),
          include: 'ts, gpuUtilPct, gpuMemPct, cpuUtilPct, memPct, ioReadMBps, powerW, checkpointAgeMin, trainingLoss',
          order: 'descending(ts)',
          limit: 12,
        }).objs
      );
      function stat(field) {
        var vals = metrics
          .map(function (m) {
            return num(m[field]);
          })
          .filter(function (v) {
            return v !== null;
          });
        if (!vals.length) return null;
        var sum = vals.reduce(function (a, b) {
          return a + b;
        }, 0);
        return { latest: round(vals[0], 1), avg: round(sum / vals.length, 1), min: round(Math.min.apply(null, vals), 1), max: round(Math.max.apply(null, vals), 1) };
      }
      var actions = arr(
        ActionLogEntry.fetch({
          filter: Filter.eq('job.id', id),
          include: 'actionType, actor, actedAt, detail, outcome',
          order: 'descending(actedAt)',
          limit: 5,
        }).objs
      ).map(function (a) {
        return { actionType: str(a.actionType), actor: str(a.actor), at: iso(a.actedAt), outcome: str(a.outcome), detail: str(a.detail).substring(0, 160) };
      });
      var row = jobRow(j, metrics.length ? metrics[0] : null, openAlerts(Filter.eq('job.id', id)));
      return {
        job: row,
        window: { samples: metrics.length, gpuUtilPct: stat('gpuUtilPct'), gpuMemPct: stat('gpuMemPct'), cpuUtilPct: stat('cpuUtilPct'), memPct: stat('memPct'), checkpointAgeMin: stat('checkpointAgeMin'), trainingLoss: stat('trainingLoss') },
        recentActions: actions,
        suggestedActions: row.alerts
          .map(function (a) {
            return a.recommendedAction;
          })
          .filter(function (v, i, all) {
            return v && all.indexOf(v) === i;
          }),
      };
    }
  );
}

function universityOverview() {
  return traced(
    'universityOverview',
    null,
    {},
    function () {
      return 'University-wide utilization, cost and fairness';
    },
    function () {
      return plain(Insights.universityOverview());
    }
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Propose-only write tools. The agent never changes a run or job: it records an Advisor.Proposal and the user applies
// it with Confirm on the Assistant page (confirmProposal), which calls RunRequest.submit / Job.applyAction.
// ---------------------------------------------------------------------------------------------------------------

function newProposal(fields) {
  fields.state = 'PENDING';
  return Advisor.Proposal.make(fields).create();
}

function proposedText(p, summary) {
  return out({
    proposalId: p.id,
    state: 'PENDING',
    summary: summary,
    note: 'PROPOSED, NOT APPLIED. The user must click Confirm on the proposal card in the chat. Tell the user it awaits their confirmation; never say it was done.',
  });
}

function proposeRunSubmission(runRequestId, planId, reason) {
  return traced(
    'proposeRunSubmission',
    null,
    { runRequestId: runRequestId, planId: planId, reason: reason },
    function (d) {
      return d.error ? d.error : 'Proposed: ' + d.summary;
    },
    function () {
      var rrs = RunRequest.fetch({ filter: Filter.eq('id', str(runRequestId)), include: 'id, name, status, lab.id', limit: 1 }).objs;
      if (!rrs || rrs.length === 0) throw new Error('No run request "' + runRequestId + '". Call evaluateRun first.');
      var rr = rrs[0];
      if (str(rr.status) === 'SUBMITTED') throw new Error('Run request ' + rr.id + ' is already submitted.');
      var ps = RunPlan.fetch({
        filter: Filter.eq('id', str(planId)),
        include: 'id, runRequest.id, label, cluster.id, partition.id, gpuType.id, gpus, nodes, walltimeHours, estDurationHours, estWaitHours, estCostUsd, estCostUnits, meetsDeadline, sbatchScript',
        limit: 1,
      }).objs;
      if (!ps || ps.length === 0 || ref(ps[0].runRequest) !== rr.id) throw new Error('Plan "' + planId + '" is not a plan of run request ' + rr.id + '.');
      var p = ps[0];
      var summary =
        'Submit "' + str(rr.name).replace(/^\[Advisor\]\s*/, '') + '" with the ' + str(p.label) + ' plan: ' + num(p.gpus) + 'x ' + (ref(p.gpuType) || 'GPU') + ' on ' + ref(p.partition) +
        ', ' + num(p.walltimeHours) + ' h walltime, ~$' + round(num(p.estCostUsd), 0) + (p.meetsDeadline === true ? ', meets deadline' : p.meetsDeadline === false ? ', MISSES deadline' : '');
      var prop = newProposal({
        name: summary,
        kind: 'SUBMIT_RUN',
        labId: ref(rr.lab),
        runRequestId: rr.id,
        planId: p.id,
        actionType: 'SUBMIT',
        reason: str(reason) || null,
        details: JSON.stringify({
          label: str(p.label),
          cluster: ref(p.cluster),
          partition: ref(p.partition),
          gpuType: ref(p.gpuType),
          gpus: num(p.gpus),
          nodes: num(p.nodes),
          walltimeHours: num(p.walltimeHours),
          estWaitHours: round(num(p.estWaitHours), 1),
          estDurationHours: round(num(p.estDurationHours), 1),
          estCostUsd: round(num(p.estCostUsd), 0),
          estCostUnits: round(num(p.estCostUnits), 1),
          meetsDeadline: p.meetsDeadline,
          sbatchScript: str(p.sbatchScript).substring(0, 3000),
        }),
      });
      return { proposalId: prop.id, summary: summary, text: proposedText(prop, summary) };
    },
    function (d) {
      return d.text;
    }
  );
}

var ACTION_LABEL = {
  EXTEND_WALLTIME: 'Extend walltime of',
  CANCEL: 'Cancel',
  CHECKPOINT_NOW: 'Checkpoint now:',
  REQUEUE_STANDBY: 'Requeue to standby:',
  SCALE_DOWN: 'Scale down GPUs of',
  NOTIFY_PI: 'Notify the PI about',
  HOLD: 'Hold',
};

function proposeJobAction(jobId, actionType, reason) {
  return traced(
    'proposeJobAction',
    null,
    { jobId: jobId, actionType: actionType, reason: reason },
    function (d) {
      return d.error ? d.error : 'Proposed: ' + d.summary;
    },
    function () {
      var at = canonicalOf(actionType, JOB_ACTIONS, 'actionType');
      if (!at) throw new Error('actionType is required: ' + JOB_ACTIONS.join(', '));
      var found = Job.fetch({ filter: Filter.eq('id', str(jobId)), include: 'id, jobName, state, lab.id, allocGpus, timelimitHours, elapsedHours', limit: 1 }).objs;
      if (!found || found.length === 0) throw new Error('No job "' + jobId + '". Use liveJobs to list job ids.');
      var j = found[0];
      if (['RUNNING', 'PENDING'].indexOf(str(j.state)) < 0 && at !== 'NOTIFY_PI') throw new Error('Job ' + j.id + ' is ' + str(j.state) + '; only running or pending jobs can be changed.');
      var summary = ACTION_LABEL[at] + ' job ' + j.id + ' (' + str(j.jobName) + ')';
      var prop = newProposal({
        name: summary,
        kind: 'JOB_ACTION',
        labId: ref(j.lab),
        jobId: j.id,
        actionType: at,
        reason: str(reason) || null,
        details: JSON.stringify({ state: str(j.state), gpus: num(j.allocGpus), timelimitHours: num(j.timelimitHours), elapsedHours: round(num(j.elapsedHours), 1) }),
      });
      return { proposalId: prop.id, summary: summary, text: proposedText(prop, summary) };
    },
    function (d) {
      return d.text;
    }
  );
}

function pendingProposal(proposalId) {
  var ps = Advisor.Proposal.fetch({
    filter: Filter.eq('id', str(proposalId)),
    include: 'id, name, kind, labId, jobId, runRequestId, planId, actionType, state',
    limit: 1,
  }).objs;
  if (!ps || ps.length === 0) throw new Error('Unknown proposal ' + proposalId);
  var p = ps[0];
  if (str(p.state) !== 'PENDING') throw new Error('Proposal ' + p.id + ' is already ' + str(p.state));
  return p;
}

function confirmProposal(proposalId) {
  var p = pendingProposal(proposalId);
  var result = { proposalId: p.id, kind: str(p.kind) };
  try {
    if (str(p.kind) === 'SUBMIT_RUN') {
      var job = RunRequest.forId(p.runRequestId).get().submit(p.planId);
      result.jobId = job ? String(job.id) : null;
      result.message = 'Submitted: ' + p.name + (result.jobId ? ' -> job ' + result.jobId : '');
    } else {
      var logRow = Job.forId(p.jobId).get().applyAction(p.actionType, 'USER');
      result.jobId = p.jobId;
      result.message = 'Applied: ' + p.name + (logRow && logRow.outcome ? ' (' + logRow.outcome + ')' : '');
    }
    result.state = 'APPLIED';
  } catch (e) {
    result.state = 'FAILED';
    result.message = 'Failed: ' + p.name + ': ' + String(e && e.message ? e.message : e);
  }
  Advisor.Proposal.make({ id: p.id, state: result.state, resultText: result.message, resultJobId: result.jobId || null, decidedAt: DateTime.now() }).merge();
  log.info('Proposal {} {}', p.id, result.state);
  return result;
}

function discardProposal(proposalId) {
  var p = pendingProposal(proposalId);
  Advisor.Proposal.make({ id: p.id, state: 'DISCARDED', resultText: 'Discarded by the user', decidedAt: DateTime.now() }).merge();
  return { proposalId: p.id, state: 'DISCARDED', message: 'Discarded: ' + p.name };
}

// ---------------------------------------------------------------------------------------------------------------
// Turn bookkeeping for Advisor.ask (Python) and the deterministic offline advisor.
// ---------------------------------------------------------------------------------------------------------------

function beginTurn() {
  return DateTime.now().minusSeconds(1).toString();
}

function turnTrace(since, labId) {
  var start = DateTime.fromString(str(since));
  var calls = arr(
    Advisor.ToolCall.fetch({
      filter: Filter.ge('calledAt', start),
      include: 'id, name, labId, args, summary, ok, millis, calledAt',
      order: 'ascending(calledAt)',
      limit: 50,
    }).objs
  ).map(function (c) {
    return { tool: str(c.name), args: str(c.args), summary: str(c.summary), ok: c.ok !== false, millis: num(c.millis) };
  });
  var props = arr(
    Advisor.Proposal.fetch({
      filter: Filter.ge('meta.created', start),
      include: 'id, name, kind, labId, jobId, runRequestId, planId, actionType, reason, details, state',
      order: 'ascending(meta.created)',
      limit: 10,
    }).objs
  )
    .filter(function (p) {
      return !str(labId) || !p.labId || p.labId === str(labId);
    })
    .map(proposalJson);
  return JSON.stringify({ toolCalls: calls, proposals: props });
}

function proposalJson(p) {
  var details = null;
  try {
    details = p.details ? JSON.parse(p.details) : null;
  } catch (e) {
    details = null;
  }
  return {
    id: p.id,
    summary: str(p.name),
    kind: str(p.kind),
    labId: str(p.labId) || null,
    jobId: str(p.jobId) || null,
    runRequestId: str(p.runRequestId) || null,
    planId: str(p.planId) || null,
    actionType: str(p.actionType) || null,
    reason: str(p.reason) || null,
    details: details,
    state: str(p.state),
    resultText: str(p.resultText) || null,
    resultJobId: str(p.resultJobId) || null,
  };
}

function pendingProposals(labId) {
  var f = Filter.eq('state', 'PENDING');
  if (str(labId)) f = f.and().eq('labId', str(labId));
  return arr(
    Advisor.Proposal.fetch({
      filter: f,
      include: 'id, name, kind, labId, jobId, runRequestId, planId, actionType, reason, details, state, resultText, resultJobId',
      order: 'descending(meta.created)',
      limit: 20,
    }).objs
  ).map(proposalJson);
}

/** Starter questions personalised with the lab's nearest deadline and live-job alerts. */
function suggestedPrompts(labId) {
  var out0 = [];
  try {
    if (str(labId)) {
      var lab = requireLab(labId);
      var next = projectsOf(lab.id).filter(function (p) {
        return p.daysToDeadline !== null && p.daysToDeadline > 0;
      })[0];
      if (next) {
        var dlText = next.daysToDeadline <= 10 ? 'by ' + WEEKDAYS[new Date(Date.parse(next.deadline)).getUTCDay()].replace(/^./, function (c) {
          return c.toUpperCase();
        }) : 'by ' + next.deadline.substring(0, 10);
        out0.push('Can we finish the ' + (next.deadlineLabel || next.name) + ' ' + (next.workloadType === 'FINETUNE' ? 'fine-tune' : 'run') + ' ' + dlText + ' within budget?');
      }
      var alerts = openAlerts(Filter.eq('lab.id', lab.id));
      if (alerts.length) out0.push('Which of our running jobs need attention right now, and what should we do?');
    }
  } catch (e) {
    log.warn('suggestedPrompts: {}', e);
  }
  var base = [
    'Can we finish the NeurIPS fine-tune by Friday within budget?',
    'Which of our running jobs are wasting GPUs?',
    'How much of our allocation is left, and when does it expire?',
    'What rules apply to an 8-GPU H100 run on Gautschi?',
    'Where is Purdue short on GPUs right now?',
  ];
  base.forEach(function (b) {
    if (out0.length < 5 && out0.indexOf(b) < 0 && !(out0.length && /^Can we finish/.test(b) && /^Can we finish/.test(out0[0]))) out0.push(b);
  });
  return out0;
}

/**
 * Deterministic advisor used when the LLM agent is unavailable: routes the question by keywords to the same tools and
 * writes a short markdown answer from their results.
 */
function offlineAnswer(question, labId) {
  var q = str(question).toLowerCase();
  var lines = [];
  var lab = null;
  try {
    lab = str(labId) ? requireLab(labId) : null;
  } catch (e) {
    lab = null;
  }
  var wantsUniversity = /\b(university|purdue|campus|all labs|fairness|short on|where .*need|demand|clusters?)\b/.test(q) && !/\bour\b/.test(q);
  var wantsJobs = /\b(running|live|jobs?|idle|wast|util|alert|oom|walltime|checkpoint|cancel|extend)\b/.test(q);
  var wantsPlan = /\b(finish|deadline|plan|launch|submit|fine-?tune|train|run .* by|within budget|feasible|neurips|icml|iclr|cvpr)\b/.test(q);
  var wantsRules = /\b(rule|polic|allowed|limit|max)\b/.test(q);
  var wantsBudget = /\b(budget|allocation|left|remaining|spend|cost|expire)\b/.test(q);

  if (wantsUniversity) {
    var u = JSON.parse(universityOverview());
    lines.push('**University overview** (live data):');
    lines.push('```json\n' + JSON.stringify(u, null, 1).substring(0, 1500) + '\n```');
  }
  if (lab && wantsPlan) {
    var proj = null;
    var m = q.match(/\b(neurips|icml|iclr|cvpr|eccv|aaai|kdd|thesis|defen[cs]e|report)\b/);
    proj = findProject(lab.id, m ? m[1] : '');
    if (!proj) {
      proj = projectsOf(lab.id).filter(function (p) {
        return p.daysToDeadline !== null && p.daysToDeadline > 0;
      })[0];
    }
    var wt = /fine-?tun/.test(q) ? 'FINETUNE' : null;
    var dl = parseDateText(q, Date.now());
    var ev = JSON.parse(evaluateRun(lab.id, proj ? proj.name : 'Planned run', question, wt, proj ? proj.projectId : null, null, null, null, null, null, null, dl ? dl.toISOString().substring(0, 10) : null));
    if (ev.error) lines.push('I could not evaluate the run: ' + ev.error);
    else {
      var best = ev.plans.filter(function (p) {
        return p.meetsDeadline;
      });
      var remainingUsd = ev.allocations.reduce(function (s, a) {
        return s + (a.remainingUsd || 0);
      }, 0);
      var cheapestOk = best.slice().sort(function (a, b) {
        return (a.estCostUsd || 0) - (b.estCostUsd || 0);
      })[0];
      var verdict = cheapestOk && ev.checks.fail === 0 && (!remainingUsd || (cheapestOk.estCostUsd || 0) <= remainingUsd);
      lines.push(
        (verdict ? '**Yes, it looks feasible.** ' : '**Not as requested.** ') +
          (ev.project ? 'For ' + ev.project + ' ' : '') +
          (ev.deadline ? '(deadline ' + ev.deadline.substring(0, 10) + ', ' + ev.hoursToDeadline + ' h away)' : '') +
          ': ' + best.length + ' of ' + ev.plans.length + ' plans meet the deadline; rule checks ' + ev.checks.fail + ' FAIL / ' + ev.checks.warn + ' WARN.'
      );
      if (ev.plans.length) {
        lines.push('\n| Plan | Where | GPUs | Finish (est.) | Cost | Deadline |\n|---|---|---|---|---|---|');
        ev.plans.forEach(function (p) {
          lines.push('| ' + p.label + ' | ' + p.partition + ' | ' + p.gpus + 'x ' + (p.gpuType || '') + ' | ' + p.estFinish.substring(0, 16).replace('T', ' ') + ' | $' + p.estCostUsd + ' | ' + (p.meetsDeadline ? 'meets' : 'misses') + ' |');
        });
      }
      ev.checks.items.slice(0, 4).forEach(function (c) {
        lines.push('- ' + c.outcome + ': ' + c.message);
      });
      if (remainingUsd) lines.push('\nRemaining allocation value: about $' + Math.round(remainingUsd) + '.');
      if (cheapestOk) {
        JSON.parse(proposeRunSubmission(ev.runRequestId, cheapestOk.planId, 'Cheapest plan that meets the deadline (offline advisor)'));
        lines.push('\nI prepared the **' + cheapestOk.label + '** plan for submission. It is not submitted until you click **Confirm** on the card below.');
      }
    }
  }
  if (wantsJobs) {
    var lj = JSON.parse(liveJobs(lab ? lab.id : null, null));
    var flagged = (lj.jobs || []).filter(function (j) {
      return j.alerts.length > 0;
    });
    lines.push('**Live jobs' + (lab ? ' for ' + lab.name : '') + ':** ' + lj.count + ' running or pending, ' + flagged.length + ' with open alerts.');
    flagged.slice(0, 6).forEach(function (j) {
      lines.push('- `' + j.jobId + '` ' + j.name + ' (' + j.gpus + 'x ' + (j.gpuType || 'GPU') + ', GPU util ' + (j.latest ? j.latest.gpuUtilPct + '%' : 'n/a') + '): ' + j.alerts.map(function (a) {
        return a.severity + ' ' + a.alertType + (a.recommendedAction ? ' -> ' + a.recommendedAction : '');
      }).join('; '));
    });
  }
  if (lab && wantsRules) {
    var cl = (q.match(/\b(anvil|gilbreth|gautschi|negishi|bell)\b/) || [])[1];
    var pol = JSON.parse(listPolicies(lab.id, cl || null, null));
    lines.push('**Rules that apply' + (cl ? ' on ' + cl : '') + ':** ' + pol.count + ' active.');
    (pol.policies || []).slice(0, 8).forEach(function (p) {
      lines.push('- ' + p.severity + ' ' + p.policyId + ' ' + p.title + (p.limitValue !== null ? ' (limit ' + p.limitValue + ')' : ''));
    });
  }
  if (lab && (wantsBudget || lines.length === 0)) {
    var ctx = JSON.parse(labContext(lab.id));
    lines.push('**' + ctx.lab.name + '** allocations:');
    ctx.allocations.forEach(function (a) {
      lines.push('- ' + a.cluster + ' ' + a.source + (a.grant ? ' (' + a.grant + ')' : '') + ': ' + a.remaining + ' of ' + a.total + ' ' + a.unit + ' left' + (a.daysLeft !== null ? ', ends in ' + Math.round(a.daysLeft) + ' days' : ''));
    });
    var next = ctx.projects.filter(function (p) {
      return p.daysToDeadline !== null && p.daysToDeadline > 0;
    })[0];
    if (next) lines.push('Next deadline: **' + (next.deadlineLabel || next.name) + '** on ' + next.deadline.substring(0, 10) + ' (' + Math.round(next.daysToDeadline) + ' days).');
  }
  if (!lines.length) lines.push('Pick a lab in the header, then ask about deadlines, budget, rules or running jobs.');
  return lines.join('\n');
}
