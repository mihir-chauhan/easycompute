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

/** Largest array inside a value (depth <= 3), as { arr }, or null. */
function largestArray(v, depth) {
  var best = null;
  var visit = function (x, d) {
    if (!x || typeof x !== 'object' || d > 3) return;
    if (Array.isArray(x)) {
      if (x.length > 1 && (!best || JSON.stringify(x).length > JSON.stringify(best).length)) best = x;
      x.forEach(function (y) {
        visit(y, d + 1);
      });
      return;
    }
    Object.keys(x).forEach(function (k) {
      visit(x[k], d + 1);
    });
  };
  visit(v, depth || 0);
  return best;
}

/**
 * JSON text of a tool result, kept under MAX_RESULT characters so the agent context stays small: the largest array is
 * halved until it fits (the text stays valid JSON and says it was shortened).
 */
function out(data) {
  var s = JSON.stringify(data);
  var guard = 0;
  while (s.length > MAX_RESULT && data && typeof data === 'object' && guard++ < 20) {
    var a = largestArray(data, 0);
    if (!a) break;
    a.splice(Math.ceil(a.length / 2));
    data.truncated = 'Result shortened; ask a narrower question for the full list.';
    s = JSON.stringify(data);
  }
  return s.length > MAX_RESULT ? JSON.stringify({ error: 'Result too large; narrow the question.' }) : s;
}

function canonicalOf(value, allowed, param) {
  var v = str(value).toUpperCase().replace(/[\s-]+/g, '_');
  if (!v) return null;
  for (var i = 0; i < allowed.length; i++) {
    if (allowed[i] === v) return allowed[i];
  }
  throw new Error('Unknown ' + param + ' "' + value + '". Use one of: ' + allowed.join(', '));
}

/**
 * Runs one tool body, records an Advisor.ToolCall row (with the citations and deep links the body returned) and returns
 * the JSON text for the agent (or a JSON error it can read). Bodies may return `citations` (kept in the result so the
 * agent can cite them by id) and `_links` (deep links for the page only, stripped from the result).
 */
function traced(tool, labId, args, summaryFn, body) {
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
  var links = (data && data._links) || [];
  if (data && data._links) delete data._links;
  var citations = (data && data.citations) || [];
  try {
    Advisor.ToolCall.make({
      name: tool,
      labId: labId || null,
      args: JSON.stringify(args),
      summary: str(summary).substring(0, 300),
      ok: ok,
      millis: Date.now() - started,
      calledAt: DateTime.now(),
      evidence: citations.length || links.length ? JSON.stringify({ citations: citations.slice(0, 20), links: links.slice(0, 10) }) : null,
    }).create();
  } catch (e3) {
    log.warn('Could not record tool call {}: {}', tool, e3);
  }
  return out(data);
}

/** A citation the agent can quote by id and the page shows as a chip. kind: DOC, POLICY, LAB, PROJECT, JOB, DATA. */
function cite(kind, id, title, url, extra) {
  var c = { id: String(id), kind: kind, title: str(title).substring(0, 140), url: url || null };
  if (extra) Object.keys(extra).forEach(function (k) {
    if (extra[k] !== null && extra[k] !== undefined) c[k] = extra[k];
  });
  return c;
}

/** Demo default lab (owner): Aniket Bera's IDEAS Lab, used when a call has no labId. */
var DEFAULT_LAB_ID = 'lab-cv';

function requireLab(labId) {
  var id = str(labId) || DEFAULT_LAB_ID;
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

/** Finds the first date mention in a text: { date, index, length } or null. See parseDateText. */
function findDate(text, refMs) {
  var s = str(text).toLowerCase();
  if (!s) return null;
  var ref0 = refMs || Date.now();
  var hit = function (m, d) {
    return m && d ? { date: d, index: m.index, length: m[0].length } : null;
  };
  var m = s.match(/\b(20\d\d)-(\d\d)-(\d\d)/);
  if (m) return hit(m, new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59)));
  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d\d|\d\d))?\b/);
  if (m) return hit(m, fixYear(+m[1] - 1, +m[2], m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null, ref0));
  var monRe = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  m = s.match(new RegExp('\\b(?:end of|through|thru|until|by|early|mid|late)[- ]+' + monRe + '(?:\\s+(20\\d\\d))?'));
  if (m && !/^\s*\d/.test(s.substring(m.index + m[0].length))) {
    var mon = MONTHS.indexOf(m[1].substring(0, 3));
    var day = /^early/.test(m[0]) ? 5 : /^mid/.test(m[0]) ? 15 : /^late/.test(m[0]) ? 25 : 1;
    var d0 = fixYear(mon, day, m[2] ? +m[2] : null, ref0);
    if (day === 1 && d0) d0 = new Date(Date.UTC(d0.getUTCFullYear(), mon + 1, 0, 23, 59));
    return hit(m, d0);
  }
  m = s.match(new RegExp('\\b' + monRe + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d\\d))?'));
  if (m) return hit(m, fixYear(MONTHS.indexOf(m[1].substring(0, 3)), +m[2], m[3] ? +m[3] : null, ref0));
  m = s.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + monRe + '(?:,?\\s+(20\\d\\d))?'));
  if (m) return hit(m, fixYear(MONTHS.indexOf(m[2].substring(0, 3)), +m[1], m[3] ? +m[3] : null, ref0));
  for (var i = 0; i < WEEKDAYS.length; i++) {
    m = s.match(new RegExp('\\b' + WEEKDAYS[i].substring(0, 3) + '(' + WEEKDAYS[i].substring(3) + ')?\\b'));
    if (m) return hit(m, nextWeekday(i, ref0));
  }
  m = s.match(/\btomorrow\b/);
  if (m) return hit(m, new Date(ref0 + DAY_MS));
  m = s.match(/\bin (\d+) (day|week)s?\b/);
  if (m) return hit(m, new Date(ref0 + +m[1] * (m[2] === 'week' ? 7 : 1) * DAY_MS));
  return null;
}

/** Parses one date mention ("May 15", "2027-06-30", "15 May 2027", "Friday", "end of June", "mid-February"). */
function parseDateText(text, refMs) {
  var f = findDate(text, refMs);
  return f ? f.date : null;
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
    var m;

    // budgets: dollars and units (SUs / ACCESS credits, GPU-hours, H100-hours, GPU-years, node/core-hours)
    var reAmt = /(^|[^A-Za-z0-9.,$])(\$)?\s?~?(\d[\d,]*(?:\.\d+)?)\s?(k|m|million)?\b\s*(?:x\s*)?((?:(?:h100|a100(?:-80gb)?|a30)\s)?gpu[- ]?years?|(?:h100|a100|gpu)[- ]?hours?|gpu[- ]?hrs?|hours (?:left|remaining)|sus?\b|service units|credits|node[- ]?hours?|core[- ]?hours?)?/gi;
    while ((m = reAmt.exec(s)) !== null) {
      var isUsd = m[2] === '$';
      var unit = str(m[5]).toLowerCase();
      if (!isUsd && !unit) continue;
      var at = m.index + m[1].length;
      var before = low.substring(Math.max(0, at - 28), at);
      var after = low.substring(at + m[0].length - m[1].length, at + m[0].length - m[1].length + 45);
      if (isUsd && /^\s*(\/|per)\s*(gpu|hour|hr|su|node)/.test(after)) continue;
      if (/\b(under|below|drop|over|above|more than|exceed\w*|at most|no more than|limit|cap)\s*~?\$?$|>\s*$/.test(before)) continue; // thresholds, handled below
      var kind = isUsd ? 'USD' : /^su|service|credit/.test(unit) ? 'SU' : /node|core/.test(unit) ? 'NODE_HOURS' : /year/.test(unit) ? 'GPU_YEARS' : 'GPU_HOURS';
      var amt = amountOf(m[3], m[4]);
      var b = {
        kind: kind,
        amount: round(amt, kind === 'USD' ? 0 : 1),
        period: /^[^.;]{0,25}\b(left|remaining|remain)\b/.test(after) || /hours (left|remaining)/.test(unit) ? 'REMAINING' : periodOf(after + ' ' + before),
        scope: scopeNear(s, at, at + m[0].length - m[1].length),
        evidence: s,
      };
      if (kind === 'GPU_YEARS') b.gpuHoursEquivalent = round(amt * 8760, 0);
      res.budgets.push(b);
    }

    // per-member caps ("Maya's cap 20%", "students capped at 15% of the budget")
    var reCap = /([A-Z][a-z]+|students?|postdocs?|undergrads?|each member|members?)(?:'s)?\s+(?:is\s+)?(?:cap(?:ped)?|limit(?:ed)?|max(?:imum)?)\s*(?:at|of|to|is)?\s*(\d{1,3})\s?%/g;
    while ((m = reCap.exec(s)) !== null) res.memberCaps.push({ who: m[1], pct: +m[2], evidence: s });

    // PI approval thresholds ("over 500 GPU-hours needs my OK", ">8 GPUs without asking me", "PI approval above $2k")
    if (/\b(approv\w*|my ok|ok from|ask(?:ing)? me|permission|sign[- ]?off|check with me)\b/.test(low)) {
      m = low.match(/(?:over|above|more than|exceed\w*|>)\s*(\$)?\s?~?(\d[\d,]*(?:\.\d+)?)\s?(k)?\s*(gpu[- ]?hours?|gpu[- ]?hrs?|gpus?|sus?|credits|usd|dollars)?/);
      if (m) {
        var u = str(m[4]);
        res.approvals.push({
          threshold: round(amountOf(m[2], m[3]), 0),
          unit: m[1] || /usd|dollar/.test(u) ? 'USD' : /^gpus?$/.test(u) ? 'GPUS' : /su|credit/.test(u) ? 'SU' : 'GPU_HOURS',
          evidence: s,
        });
      }
    }

    // deadlines: every date mention in a sentence that talks about a deadline / venue / deliverable
    if (/\b(deadlines?|due|submission|submit|camera[- ]ready|rebuttal|revision|defen[cs]e|report|deliverable|milestone|posters?|demo|release|paper|finish by|neurips|icml|iclr|cvpr|eccv|iccv|aaai|kdd|acl|emnlp|recomb|rss|corl|icra|agu|sc\d\d)\b/.test(low)) {
      s.split(/[,;(]|\s[-–]\s/).forEach(function (clause) {
        var f = findDate(clause, ref0);
        if (!f || !f.date) return;
        var label = deadlineLabel(clause, f, s);
        var key = f.date.toISOString().substring(0, 10) + '|' + label;
        if (seenDeadline[key]) return;
        seenDeadline[key] = true;
        res.deadlines.push({ label: label, date: f.date.toISOString(), daysAway: round((f.date.getTime() - ref0) / DAY_MS, 1), evidence: s });
      });
    }

    // preferences: a negation within 4 words before the mention means "avoid"
    var preferVerb = new RegExp(PREF).test(low);
    CLUSTER_WORDS.forEach(function (c) {
      if (!c.re.test(s)) return;
      if (negatedBefore(low, c.re)) pushUnique(res.preferences.avoid, c.id);
      else if (preferredNear(low, c.re)) pushUnique(res.preferences.clusters, c.id);
    });
    GPU_WORDS.forEach(function (g) {
      if (!g.re.test(s)) return;
      if (negatedBefore(low, g.re)) pushUnique(res.preferences.avoid, g.id);
      else if (preferVerb || /\b(use|fastest|our|own|bought|purchased)\b/.test(low)) pushUnique(res.preferences.gpuTypes, g.id);
    });
    var preRe = /\b(preempt\w*|standby|spot)\b/;
    if (preRe.test(low)) {
      if (negatedBefore(low, preRe)) {
        res.preferences.preemptibleOk = false;
        pushUnique(res.preferences.avoid, 'preemptible/standby');
      } else if (res.preferences.preemptibleOk !== false && /\b(ok|fine|happy|prefer|use|cheap|accept|go|run|stretch\w*)\b/.test(low)) {
        res.preferences.preemptibleOk = true;
      }
    }
    m = low.match(/(?:max(?:imum)?|no more than|at most|cap|limit)\s*(?:walltime|wall time|runtime|jobs?)?\s*(?:of|at|to)?\s*(\d+(?:\.\d+)?)\s*(h|hours?|hrs?|days?)\b/);
    if (m && /wall|runtime|job|run/.test(low)) res.preferences.maxWalltimeHours = round(+m[1] * (/^d/.test(m[2]) ? 24 : 1), 1);
    m = s.match(/quiet hours?:?\s*([^.;]{0,30}?\d{1,2}(?::\d\d)?\s*(?:am|pm)?\s*(?:-|to|–)\s*\d{1,2}(?::\d\d)?\s*(?:am|pm)?)/i);
    if (m) res.preferences.quietHours = m[1].trim();
    if (
      res.preferences.notes.length < 8 &&
      (/\b(checkpoint\w*|warn me|tell me|notify me|remind|kill|scale the job down|recommend|always|never|only|must|should|please)\b/.test(low))
    ) {
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

var NEG = "\\b(?:no|never|not|avoid|don't|do not|without|can't|cannot|must not|stay off|except)\\b";

/** True when a negation word appears at most 4 words before a match of `re` ("never on Anvil", "don't put us on A30s"). */
function negatedBefore(low, re) {
  return new RegExp(NEG + "(?:[ \\t]+[\\w'/-]+){0,3}?[ \\t]+(?:" + re.source + ')', 'i').test(low);
}

var PREF = '\\b(?:prefer\\w*|like|want|favou?r\\w*|usually|mostly|default|best|only|workhorse is)\\b';

/** True when a preference word precedes the mention within 8 words, or the mention is followed by "first". */
function preferredNear(low, re) {
  return (
    new RegExp(PREF + "(?:[ \\t]+[\\w'/,.()-]+){0,8}?[ \\t]+(?:" + re.source + ')', 'i').test(low) ||
    new RegExp('(?:' + re.source + ")[ \\t]+(?:[\\w'-]+[ \\t]+)?first\\b", 'i').test(low)
  );
}

function periodOf(low) {
  if (/\b(per|a|each|every)\s+month|monthly\b/.test(low)) return 'MONTH';
  if (/\b(per|a|each|every)\s+week|weekly\b/.test(low)) return 'WEEK';
  if (/\b(per|a|each|every)\s+(year|fy)|annual|yearly|fiscal year|this fiscal\b/.test(low)) return 'YEAR';
  if (/\bsemester\b/.test(low)) return 'SEMESTER';
  return 'TOTAL';
}

/** Funding source or cluster named near an amount. */
function scopeOf(s) {
  var m = s.match(/\b(NSF|NIH|DOE|DARPA|DTRA|ONR|AFOSR|ARL|USDA|NASA|ACCESS|AWS|startup|department|dept|industry)\b(?:\s+(?!through|thru|on|for|until|gives|is|of|ends|expires|and|bought|share|award\b)[A-Za-z][\w-]*){0,2}(?:\s+award)?/i);
  if (m) return m[0].trim();
  for (var i = 0; i < CLUSTER_WORDS.length; i++) if (CLUSTER_WORDS[i].re.test(s)) return CLUSTER_WORDS[i].id;
  return null;
}

var FUNDER_RE = /\b(NSF|NIH|DOE|DARPA|DTRA|ONR|AFOSR|ARL|USDA|NASA|ACCESS|AWS|startup|department|dept|industry)\b/i;

/** Scope of the amount at [at, end) in sentence s: funder right after ("of AWS credits"), else nearest funder before, else after, else a cluster. */
function scopeNear(s, at, end) {
  var after = s.substring(end, end + 60);
  var before = s.substring(Math.max(0, at - 90), at);
  if (/^\s*(of|in|from)\s/i.test(after) && FUNDER_RE.test(after)) return scopeOf(after.substring(after.search(FUNDER_RE)));
  var idx = -1;
  var re = new RegExp(FUNDER_RE.source, 'gi');
  var mm;
  while ((mm = re.exec(before)) !== null) idx = mm.index;
  if (idx >= 0) return scopeOf(before.substring(idx));
  if (FUNDER_RE.test(after.substring(0, 40))) return scopeOf(after.substring(after.search(FUNDER_RE)));
  return scopeOf(before + ' ' + after);
}

var VENUE_RE = /\b(NeurIPS|ICML|ICLR|CVPR|ECCV|ICCV|AAAI|IJCAI|KDD|ACL|EMNLP|NAACL|RECOMB|ISMB|RSS|CoRL|ICRA|IROS|SIGGRAPH|MICCAI|AGU|SC\d\d)\b(?:\s+20\d\d)?/i;

/** Label of a deadline: the words before the date in its clause, else a venue / keyword phrase of the sentence. */
function deadlineLabel(clause, f, sentence) {
  var tidy = function (t) {
    var out = t.replace(/^.*:\s*/, '');
    var prev;
    do {
      prev = out;
      out = out
        .replace(/[\s:,(\-–]+$/, '')
        .replace(/\b(are|is|was|were|due|on|by|in|at|for|must finish|must|finish|needs?|the|our|next|immediate|(mon|tues|wednes|thurs|fri|satur|sun)day)$/i, '')
        .trim();
    } while (out !== prev);
    return out;
  };
  var pre = tidy(clause.substring(0, f.index));
  if (pre.length >= 3) return pre.length > 60 ? pre.substring(0, 57) + '...' : pre;
  var v = sentence.match(VENUE_RE);
  if (v) return v[0];
  var k = sentence.match(/(?:\b[\w-]+\s+)?\b(thesis defen[cs]e|defen[cs]e|grant report|annual report|progress report|milestone report|camera[- ]ready|rebuttal|revision|renewal|proposal|deliverable|demo)\b/i);
  if (k) return k[0];
  var t = tidy(clause);
  return t.length > 60 ? t.substring(0, 57) + '...' : t || 'Deadline';
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

// ---------------------------------------------------------------------------------------------------------------
// LabContextExtractor: schema-constrained extraction with evidence spans. Every extracted item carries
// evidence {quote, start, end} = an exact substring of the lab text and its character offsets; items whose quote is not
// in the text, or that break the schema, are dropped and reported in `validation`. Results stay UNCONFIRMED until the lab
// confirms them (confirmConstraints); the advisor treats unconfirmed fields as hints only.
// ---------------------------------------------------------------------------------------------------------------

var EXTRACTOR = { component: 'LabContextExtractor', version: '1.1' };
var BUDGET_KINDS = ['USD', 'SU', 'GPU_HOURS', 'GPU_YEARS', 'NODE_HOURS'];
var PERIODS = ['TOTAL', 'REMAINING', 'MONTH', 'WEEK', 'SEMESTER', 'YEAR'];
var RESTRICTION_KINDS = ['HIPAA', 'EXPORT_CONTROL', 'CUI', 'FERPA', 'PII', 'NO_CLOUD', 'DATA_RESIDENCY', 'LICENSED_DATA'];
var APPROVAL_UNITS = ['USD', 'SU', 'GPU_HOURS', 'GPUS'];

/** Evidence span of a quote in text: exact match first, then whitespace-insensitive; start -1 when not found. */
function span(text, quote) {
  var q = str(typeof quote === 'object' && quote ? quote.quote : quote);
  if (!q) return { quote: '', start: -1, end: -1 };
  var i = text.indexOf(q);
  if (i >= 0) return { quote: q, start: i, end: i + q.length };
  var esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  var m = new RegExp(esc).exec(text);
  if (m) return { quote: m[0], start: m.index, end: m.index + m[0].length };
  var lo = text.toLowerCase().indexOf(q.toLowerCase());
  if (lo >= 0) return { quote: text.substring(lo, lo + q.length), start: lo, end: lo + q.length };
  return { quote: q, start: -1, end: -1 };
}

/** Sentence of the text that mentions `re` (for preference evidence). */
function sentenceWith(text, re) {
  var ss = sentencesOf(text);
  for (var i = 0; i < ss.length; i++) if (re.test(ss[i])) return ss[i];
  return null;
}

/** Adds preferences.evidence [{field, value, quote, start, end}] for every preference value of a rules parse. */
function preferenceEvidence(res, text) {
  var ev = [];
  var add = function (field, value, re) {
    var sen = re ? sentenceWith(text, re) : null;
    if (sen) {
      var sp = span(text, sen);
      ev.push({ field: field, value: value, quote: sp.quote, start: sp.start, end: sp.end });
    }
  };
  var p = res.preferences;
  (p.clusters || []).forEach(function (c) {
    add('clusters', c, (CLUSTER_WORDS.filter(function (w) {
      return w.id === c;
    })[0] || {}).re);
  });
  (p.gpuTypes || []).forEach(function (g) {
    add('gpuTypes', g, (GPU_WORDS.filter(function (w) {
      return w.id === g;
    })[0] || {}).re);
  });
  (p.avoid || []).forEach(function (a) {
    var w = CLUSTER_WORDS.concat(GPU_WORDS).filter(function (x) {
      return x.id === a;
    })[0];
    add('avoid', a, w ? w.re : a === 'preemptible/standby' ? /\b(preempt\w*|standby|spot)\b/i : a === 'aws-p4d' ? /\b(aws|cloud|on[- ]?prem)/i : null);
  });
  if (p.preemptibleOk !== null && p.preemptibleOk !== undefined) add('preemptibleOk', p.preemptibleOk, /\b(preempt\w*|standby|spot)\b/i);
  if (p.quietHours) add('quietHours', p.quietHours, /quiet hours?/i);
  if (p.maxWalltimeHours) add('maxWalltimeHours', p.maxWalltimeHours, /wall ?time|runtime/i);
  p.evidence = ev;
  return res;
}

/**
 * Validates a constraint result against the LabContextExtractor schema and the source text: coerces types, recomputes
 * evidence offsets from the quotes, drops invalid items and lists every problem in `validation.errors`.
 */
function validateConstraintObject(r, text, refMs) {
  var errors = [];
  var ref0 = refMs || Date.now();
  var keep = function (list, name, check) {
    var outList = [];
    (Array.isArray(list) ? list : []).forEach(function (it, i) {
      if (!it || typeof it !== 'object') {
        errors.push(name + '[' + i + ']: not an object');
        return;
      }
      var msg = check(it);
      if (!msg) {
        var sp = span(text, it.evidence);
        if (sp.start < 0) msg = 'evidence quote not found in the lab text';
        else it.evidence = sp;
      }
      if (msg) errors.push(name + '[' + i + ']: ' + msg + ' (dropped)');
      else outList.push(it);
    });
    return outList;
  };
  var res = {
    component: EXTRACTOR.component,
    version: EXTRACTOR.version,
    source: str(r.source) || 'rules',
    model: r.model || null,
    budgets: keep(r.budgets, 'budgets', function (b) {
      b.kind = str(b.kind).toUpperCase();
      b.amount = num(b.amount);
      b.period = PERIODS.indexOf(str(b.period).toUpperCase()) >= 0 ? str(b.period).toUpperCase() : 'TOTAL';
      if (BUDGET_KINDS.indexOf(b.kind) < 0) return 'kind must be one of ' + BUDGET_KINDS.join(', ');
      if (!(b.amount > 0)) return 'amount must be a positive number';
      return null;
    }),
    deadlines: keep(r.deadlines, 'deadlines', function (d) {
      var t = Date.parse(str(d.date));
      if (isNaN(t)) return 'date must be ISO (YYYY-MM-DD)';
      if (!str(d.label)) return 'label is required';
      d.date = new Date(t).toISOString();
      d.daysAway = round((t - ref0) / DAY_MS, 1);
      return null;
    }),
    dataRestrictions: keep(r.dataRestrictions, 'dataRestrictions', function (d) {
      d.kind = str(d.kind).toUpperCase();
      return RESTRICTION_KINDS.indexOf(d.kind) < 0 ? 'kind must be one of ' + RESTRICTION_KINDS.join(', ') : null;
    }),
    memberCaps: keep(r.memberCaps, 'memberCaps', function (m) {
      m.pct = num(m.pct);
      return !str(m.who) ? 'who is required' : !(m.pct > 0 && m.pct <= 100) ? 'pct must be 0-100' : null;
    }),
    approvals: keep(r.approvals, 'approvals', function (a) {
      a.threshold = num(a.threshold);
      a.unit = str(a.unit).toUpperCase();
      return !(a.threshold > 0) ? 'threshold must be positive' : APPROVAL_UNITS.indexOf(a.unit) < 0 ? 'unit must be one of ' + APPROVAL_UNITS.join(', ') : null;
    }),
    preferences: {},
    summary: str(r.summary),
    warnings: Array.isArray(r.warnings) ? r.warnings : [],
    provenance: {
      component: EXTRACTOR.component,
      version: EXTRACTOR.version,
      method: r.model ? 'Schema-constrained LLM (' + r.model + ') + validation, evidence spans' : 'Rules parser + validation, evidence spans',
      asOf: new Date().toISOString(),
    },
  };
  var p = r.preferences && typeof r.preferences === 'object' ? r.preferences : {};
  var strings = function (v, field) {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) {
      errors.push('preferences.' + field + ': must be a list (ignored)');
      return [];
    }
    return v.map(function (x) {
      return str(x);
    }).filter(Boolean);
  };
  var clusterIds = CLUSTER_WORDS.map(function (c) {
    return c.id;
  });
  res.preferences.clusters = strings(p.clusters, 'clusters').filter(function (c) {
    var ok = clusterIds.indexOf(c) >= 0;
    if (!ok) errors.push('preferences.clusters: unknown cluster ' + c + ' (dropped)');
    return ok;
  });
  res.preferences.gpuTypes = strings(p.gpuTypes, 'gpuTypes');
  res.preferences.avoid = strings(p.avoid, 'avoid');
  res.preferences.preemptibleOk = p.preemptibleOk === true || p.preemptibleOk === false ? p.preemptibleOk : null;
  res.preferences.maxWalltimeHours = num(p.maxWalltimeHours);
  res.preferences.quietHours = str(p.quietHours) || null;
  res.preferences.notes = strings(p.notes, 'notes').slice(0, 10);
  res.preferences.evidence = (Array.isArray(p.evidence) ? p.evidence : [])
    .map(function (e) {
      var sp = span(text, e);
      return sp.start < 0 ? null : { field: str(e.field), value: e.value, quote: sp.quote, start: sp.start, end: sp.end };
    })
    .filter(Boolean);
  res.validation = { valid: errors.length === 0, errors: errors.slice(0, 30), dropped: errors.filter(function (e) {
    return /\(dropped\)$/.test(e);
  }).length };
  if (!res.summary) res.summary = summarize(res);
  return res;
}

/** Rules-based extraction of the lab text, with evidence spans, validated (status UNCONFIRMED). */
function rulesExtraction(t) {
  var raw = preferenceEvidence(parseConstraintsText(t, Date.now()), t);
  var res = validateConstraintObject(raw, t);
  res.warnings = raw.warnings;
  return res;
}

function parseConstraintsRules(labId, text) {
  var t = str(text);
  var lab = null;
  if (str(labId)) lab = requireLab(labId);
  if (!t && lab) t = str(lab.contextDump);
  var res = rulesExtraction(t);
  res.labId = lab ? lab.id : null;
  res.inputText = t;
  res.textHash = textHash(t);
  res.status = 'UNCONFIRMED';
  return JSON.stringify(res);
}

function validateConstraints(resultJson, text) {
  var r = JSON.parse(str(resultJson) || '{}');
  return JSON.stringify(validateConstraintObject(r, str(text)));
}

/** Cache row of a lab (or null). */
function constraintRow(labId) {
  var c = Advisor.ConstraintSet.fetch({
    filter: Filter.eq('id', labId),
    include: 'id, textHash, result, source, confirmedHash, confirmedResult, confirmedAt',
    limit: 1,
  }).objs;
  return c && c.length ? c[0] : null;
}

/**
 * Best constraints known for the lab text, with status: the lab-confirmed set when it matches the current text, else
 * the cached LLM extraction, else the rules extraction (both UNCONFIRMED).
 */
function constraintsFor(lab) {
  var t = str(lab.contextDump);
  var h = textHash(t);
  try {
    var c = constraintRow(lab.id);
    if (c && c.confirmedHash === h && c.confirmedResult) {
      var conf = JSON.parse(c.confirmedResult);
      conf.status = 'CONFIRMED';
      conf.confirmedAt = iso(c.confirmedAt);
      return conf;
    }
    if (c && c.textHash === h && c.result) {
      var cached = JSON.parse(c.result);
      if (cached.component === EXTRACTOR.component && cached.version === EXTRACTOR.version) {
        cached.status = 'UNCONFIRMED';
        return cached;
      }
    }
  } catch (e) {
    log.warn('constraint cache read failed: {}', e);
  }
  var r = rulesExtraction(t);
  r.status = 'UNCONFIRMED';
  return r;
}

/** Writes the LLM extraction cache (called by extractConstraints in Python). */
function saveConstraints(labId, hash, resultJson, source) {
  Advisor.ConstraintSet.make({ id: labId, textHash: hash, result: resultJson, source: source, parsedAt: DateTime.now() }).merge();
  return true;
}

/** Confirmed set of a lab when it matches the current context text, else null (used by extractConstraints). */
function confirmedConstraints(labId) {
  var lab = requireLab(labId);
  var c = constraintRow(lab.id);
  if (!c || !c.confirmedResult || c.confirmedHash !== textHash(str(lab.contextDump))) return null;
  var r = JSON.parse(c.confirmedResult);
  r.status = 'CONFIRMED';
  r.confirmedAt = iso(c.confirmedAt);
  r.textHash = c.confirmedHash;
  r.labId = lab.id;
  return r;
}

function confirmConstraints(labId, resultJson) {
  var lab = requireLab(labId);
  var t = str(lab.contextDump);
  var h = textHash(t);
  var input = str(resultJson) ? JSON.parse(resultJson) : constraintsFor(lab);
  if (input.textHash && input.textHash !== h) throw new Error('The lab context changed since this extraction; extract again before confirming.');
  var res = validateConstraintObject(input, t);
  if (res.validation.dropped > 0) throw new Error('Cannot confirm: ' + res.validation.errors.join('; '));
  res.status = 'CONFIRMED';
  res.textHash = h;
  res.labId = lab.id;
  var now = DateTime.now();
  Advisor.ConstraintSet.make({ id: lab.id, confirmedHash: h, confirmedResult: JSON.stringify(res), confirmedAt: now }).merge();
  res.confirmedAt = iso(now);
  return res;
}

/**
 * Compact lab facts put into every agent query (allocations left, next deadlines, live jobs / alerts, data rules), so
 * budget and deadline questions need no tool round trip. Never throws: returns '' when the lab is unknown.
 */
function contextSnapshot(labId) {
  try {
    if (!str(labId)) return '';
    var lab = requireLab(labId);
    var parts = [];
    parts.push(
      'allocations: ' +
        allocationsOf(lab.id)
          .map(function (a) {
            return a.cluster + ' ' + a.source + ' ' + a.remaining + ' of ' + a.total + ' ' + a.unit + ' left (' + a.usedPct + '% used' +
              (a.remainingUsd !== null ? ', ~$' + a.remainingUsd : '') + (a.endDate ? ', ends ' + a.endDate.substring(0, 10) : '') + ')';
          })
          .join('; ')
    );
    var next = projectsOf(lab.id)
      .filter(function (p) {
        return p.daysToDeadline !== null && p.daysToDeadline > -1;
      })
      .slice(0, 3)
      .map(function (p) {
        return p.name + (p.deadlineLabel ? ' / ' + p.deadlineLabel : '') + ' due ' + p.deadline.substring(0, 16).replace('T', ' ') + ' (' + p.workloadType + ', projectId ' + p.projectId + ')';
      });
    if (next.length) parts.push('next deadlines: ' + next.join('; '));
    var live = Job.fetchCount({ filter: Filter.eq('isLive', true).and().eq('lab.id', lab.id) });
    var alerts = openAlerts(Filter.eq('lab.id', lab.id).and().eq('job.isLive', true));
    parts.push('live jobs: ' + live + ', open alerts: ' + alerts.length + (alerts.length ? ' (' + alerts.slice(0, 4).map(function (a) {
      return str(a.severity) + ' ' + str(a.alertType) + ' on ' + ref(a.job);
    }).join(', ') + ')' : ''));
    var c = constraintsFor(lab);
    var tag = c.status === 'CONFIRMED' ? ' (confirmed by lab)' : ' (UNCONFIRMED extraction)';
    var rules = (c.dataRestrictions || []).map(function (d) {
      return d.kind;
    });
    if (rules.length) parts.push('data restrictions' + tag + ': ' + rules.join(', '));
    if ((c.preferences && c.preferences.avoid || []).length) parts.push('avoid' + tag + ': ' + c.preferences.avoid.join(', '));
    return parts.join(' | ');
  } catch (e) {
    log.warn('contextSnapshot failed: {}', e);
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// PolicyRAGAdvisor retrieval: a small versioned set of Purdue RCAC / NSF ACCESS policy documents (facts and URLs from
// the domain research, knowledge/30-domain-compute-allocation.md, fetched 2026-11-19) plus the Policy rows, the lab
// context dump and projects. Lexical (BM25-style) retrieval; every hit becomes a citation the answer must quote.
// ---------------------------------------------------------------------------------------------------------------

var DOC_SET_VERSION = 'purdue-policy-docs 2026-11-19';
var POLICY_DOCS = [
  { id: 'D-01', title: 'Gautschi AI QOS changes (effective 2026-11-02)', version: '2026-11-02', cluster: 'gautschi', url: 'https://www.rcac.purdue.edu/news/7941',
    text: 'On Gautschi ai the normal QOS walltime limit dropped from 14 days to 4 days on 2026-11-02. An account may run at most max(2, 2 x purchased GPUs) H100s concurrently in normal QOS. Burst QOS: highest priority, charged 2 GPU-hours per GPU-hour, at most 8 GPUs, one running burst job per account, 8 hour walltime. Longer runs must checkpoint and chain jobs or use preemptible.' },
  { id: 'D-02', title: 'Gautschi queues and QOS', version: '2026-11-19', cluster: 'gautschi', url: 'https://docs.rcac.purdue.edu/userguides/gautschi/run_jobs/queues/',
    text: 'Gautschi ai partition QOS: normal (owned share, high priority, 4 days), preemptible (charged 0.25x, up to 30 days, jobs can be preempted for normal jobs with a 10-minute grace signal; use --signal=B:USR1@600 --requeue and checkpoint at least every 30 minutes), burst (2x charge, 8 hours). smallgpu L40S: at most 2 GPUs in use, 8 submitted, 24 hours. highmem: justification above 48 cores, 2 running, 8 submitted. cpu normal: 14 days. GPU-hour balance: estimated GPU-hours times the QOS multiplier must fit the remaining bank.' },
  { id: 'D-03', title: 'Gilbreth queues and modernization', version: '2025-10-01', cluster: 'gilbreth', url: 'https://www.rcac.purdue.edu/index.php/news/7275',
    text: 'Since the 2025 Gilbreth modernization every job must name an account (-A), a partition (-p) and request memory explicitly (--mem); jobs without a partition are rejected. Owned partitions (for example a100-80gb, a100-40gb, a30) run in normal QOS at high priority; standby scavenges idle GPUs with no start guarantee and a 4 hour limit; the training partition allows up to 24 hours for runs using more than 2 GPUs.' },
  { id: 'D-04', title: 'Gilbreth GPU jobs and GPU utilization monitoring', version: '2026-11-19', cluster: 'gilbreth', url: 'https://docs.rcac.purdue.edu/userguides/gilbreth/run_jobs/gpu_usage_monitoring/',
    text: 'RCAC logs and stores the power, memory and utilization of every GPU every 10 seconds and uses this data to identify users who request large amounts of GPU hours but do not actually use them. The get_gpu_util tool reports per-job utilization with a few hours delay. Request GPUs with --gres=gpu:N and memory proportional to GPUs.' },
  { id: 'D-05', title: 'Anvil jobs, partitions and limits', version: '2026-11-19', cluster: 'anvil', url: 'https://docs.rcac.purdue.edu/userguides/anvil/jobs/',
    text: 'Anvil partitions: wholenode and shared 96 hours, wide 12 hours, highmem gpu and ai 48 hours, debug 2 hours, gpu-debug 30 minutes. A user may use at most 12 GPUs and an allocation at most 32 GPUs at once. wholenode and wide charge 128 cores per node; highmem is charged 4x. GPU jobs are charged to the <project>-gpu account; long runs must checkpoint and chain jobs.' },
  { id: 'D-06', title: 'Anvil policies: scratch purge and allocation expiry', version: '2026-11-19', cluster: 'anvil', url: 'https://docs.rcac.purdue.edu/userguides/anvil/policies/',
    text: 'Anvil scratch files not accessed for 30 days are deleted instantly and automatically with no warning emails. Touching files to avoid the purge violates acceptable use. Project storage is purged 90 days after the allocation expires. Copy results to Data Depot or project space.' },
  { id: 'D-07', title: 'NSF ACCESS project tiers and credits', version: '2026-11-19', cluster: 'anvil', url: 'https://allocations.access-ci.org/project-types',
    text: 'ACCESS projects: Explore up to 400,000 credits, Discover up to 1,500,000, Accelerate up to 3,000,000, Maximize awarded in resource units. Credits are exchanged for specific resources; queues are only usable for exchanged resources. There are no automatic refills: request a supplement for more credits or an extension for more time. Allocations expire at their end date.' },
  { id: 'D-08', title: 'ACCESS exchange rates for Anvil', version: '2026-11-19', cluster: 'anvil', url: 'https://allocations.access-ci.org/exchange_calculator',
    text: 'Exchange rates: Anvil CPU 1.0 credit per SU (core-hour); Anvil GPU (A100) 67.308 credits per GPU-hour; Anvil AI (H100) 133.342 credits per GPU-hour. An Explore project of 400k credits is about 5,940 A100 GPU-hours or about 3,000 H100 GPU-hours.' },
  { id: 'D-09', title: 'Scratch purge and quotas on RCAC community clusters', version: '2026-11-19', cluster: 'gautschi', url: 'https://docs.rcac.purdue.edu/userguides/gautschi/storage/scratch_space/',
    text: 'On Gautschi, Gilbreth and Negishi scratch files that have not been accessed or modified in 60 days are purged. Quotas: home 25 GB (cannot be increased), scratch 100 TB and 2 million files. Keep shared data on Data Depot and archive to Fortress.' },
  { id: 'D-10', title: 'Bell decommissioned 2026-10-31', version: '2026-10-31', cluster: 'bell', url: 'https://rcac.purdue.edu/news/7776',
    text: 'The Bell community cluster was retired on 2026-10-31. Jobs can no longer be submitted to Bell; migrate CPU work to Gautschi cpu (48-core units) or Negishi.' },
  { id: 'D-11', title: 'Negishi queues', version: '2026-11-19', cluster: 'negishi', url: 'https://docs.rcac.purdue.edu/userguides/negishi/run_jobs/queues/',
    text: 'Negishi owned CPU partitions run in normal QOS for up to 14 days; highmem requires more than 64 cores with at most 2 running and 8 submitted; the gpu partition (AMD MI210, ROCm) allows at most 2 GPUs and 24 hours.' },
  { id: 'D-12', title: 'Community cluster model and priority', version: '2026-11-19', cluster: null, url: 'https://docs.rcac.purdue.edu/userguides/gautschi/overview/',
    text: 'Labs buy node shares or GPU-hour banks on RCAC community clusters. Normal QOS on owned resources has high priority and should start quickly; standby and preemptible scavenge idle cycles with no start guarantee; burst is highest priority at 2x charge. Every job must be submitted through Slurm; no work on login nodes. Be as accurate as possible about requested resources.' },
  { id: 'D-13', title: 'Idle GPU policies at peer universities', version: '2026-11-19', cluster: null, url: 'https://docs.rc.ufl.edu/scheduler/idle_gpu_policy/',
    text: 'Peer centers (UF, Yale, Princeton, Northeastern) cancel or warn about jobs whose GPUs stay idle: typical rules flag GPU utilization near 0 percent for 30 to 60 minutes and cancel after a grace period, after notifying the user. Checkpoint before cancelling long runs.' },
  { id: 'D-14', title: 'Memory sizing for model training (Transformer Math 101)', version: '2023-04-18', cluster: null, url: 'https://blog.eleuther.ai/transformer-math/',
    text: 'Mixed-precision Adam training needs about 16 bytes per parameter (weights, gradients, optimizer states) plus activations; inference needs about 2 bytes per parameter in fp16/bf16. LoRA fine-tuning needs far less optimizer memory. Pick the GPU count so per-GPU memory fits with headroom.' },
];

var STOP = { the: 1, a: 1, an: 1, of: 1, to: 1, and: 1, or: 1, in: 1, on: 1, for: 1, is: 1, are: 1, be: 1, can: 1, we: 1, our: 1, it: 1, with: 1, by: 1, at: 1, what: 1, which: 1, how: 1, do: 1, does: 1, i: 1, my: 1, us: 1, this: 1, that: 1, there: 1, any: 1 };

function tokens(text) {
  return str(text)
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, ' ')
    .split(' ')
    .map(function (t) {
      return t.replace(/^[.+-]+|[.+-]+$/g, '');
    })
    .filter(function (t) {
      return t.length > 1 && !STOP[t];
    });
}

/** Ranks passages [{text, ...}] for a query with a BM25-style score (k1 1.2, b 0.75). */
function rank(query, passages) {
  var q = tokens(query);
  if (!q.length) return [];
  var docs = passages.map(function (p) {
    return tokens(p.title + ' ' + p.text);
  });
  var avg =
    docs.reduce(function (s, d) {
      return s + d.length;
    }, 0) / Math.max(1, docs.length);
  var df = {};
  docs.forEach(function (d) {
    var seen = {};
    d.forEach(function (t) {
      if (!seen[t]) {
        seen[t] = true;
        df[t] = (df[t] || 0) + 1;
      }
    });
  });
  var n = docs.length;
  return passages
    .map(function (p, i) {
      var tf = {};
      docs[i].forEach(function (t) {
        tf[t] = (tf[t] || 0) + 1;
      });
      var score = 0;
      q.forEach(function (t) {
        if (!tf[t]) return;
        var idf = Math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5));
        score += (idf * tf[t] * 2.2) / (tf[t] + 1.2 * (0.25 + (0.75 * docs[i].length) / avg));
      });
      return { p: p, score: score * (p.boost || 1) };
    })
    .filter(function (x) {
      return x.score > 0;
    })
    .sort(function (a, b) {
      return b.score - a.score;
    });
}

/** Passages of the corpus for one lab: policy docs, active Policy rows in scope, lab context sentences, projects. */
function corpus(labId, clusterId) {
  var cl = str(clusterId).toLowerCase();
  var out0 = POLICY_DOCS.filter(function (d) {
    return !cl || !d.cluster || d.cluster === cl;
  }).map(function (d) {
    return { cite: cite('DOC', d.id, d.title, d.url, { version: d.version }), title: d.title, text: d.text };
  });
  arr(
    Policy.fetch({
      filter: Filter.eq('active', true),
      include: 'id, scope, kind, severity, title, description, limitValue, limitText, sourceUrl, cluster.id, partition.id, lab.id',
      limit: 300,
    }).objs
  ).forEach(function (p) {
    var pl = ref(p.lab);
    if (pl && pl !== str(labId)) return;
    var pc = ref(p.cluster) || (p.partition ? String(ref(p.partition)).split('-')[0] : null);
    if (cl && pc && pc !== cl) return;
    out0.push({
      cite: cite('POLICY', p.id, p.title, str(p.sourceUrl) || null, { severity: str(p.severity), scope: str(p.scope), version: 'active' }),
      title: str(p.title),
      text: [str(p.scope), str(p.kind).replace(/_/g, ' '), str(p.severity), str(p.description), p.limitValue !== null && p.limitValue !== undefined ? 'limit ' + p.limitValue : '', str(p.limitText), pc || ''].join(' '),
      boost: pl ? 1.3 : 1.1,
    });
  });
  if (str(labId)) {
    var lab = requireLab(labId);
    var dump = str(lab.contextDump);
    sentencesOf(dump).forEach(function (sen, i) {
      out0.push({ cite: cite('LAB', lab.id + '#' + (i + 1), sen, '/context', { quote: sen.substring(0, 200) }), title: 'Lab context', text: sen, boost: 1.2 });
    });
    projectsOf(lab.id).forEach(function (pj) {
      out0.push({
        cite: cite('PROJECT', pj.projectId, pj.name + (pj.deadlineLabel ? ' (' + pj.deadlineLabel + ')' : ''), '/context', { deadline: pj.deadline }),
        title: pj.name,
        text: [pj.name, pj.deadlineLabel, pj.workloadType, pj.description, 'deadline ' + str(pj.deadline).substring(0, 10)].join(' '),
      });
    });
  }
  return out0;
}

function retrieveSources(query, labId, clusterId, limit) {
  return traced(
    'retrieveSources',
    labId,
    { query: query, labId: labId, clusterId: clusterId, limit: limit },
    function (d) {
      return d.hits.length + ' sources: ' + d.hits.map(function (h) {
        return h.id;
      }).join(', ');
    },
    function () {
      if (!str(query)) throw new Error('query is required: the words to look up, e.g. "preemptible walltime gautschi".');
      var max = Math.max(1, Math.min(num(limit) || 6, 10));
      var hits = rank(query, corpus(labId, clusterId)).slice(0, max);
      var cites = hits.map(function (h) {
        return h.p.cite;
      });
      return {
        docSet: DOC_SET_VERSION,
        hits: hits.map(function (h) {
          return { id: h.p.cite.id, kind: h.p.cite.kind, title: h.p.cite.title, version: h.p.cite.version || null, url: h.p.cite.url, text: h.p.text.substring(0, 500), score: round(h.score, 2) };
        }),
        citations: cites,
        note: 'Cite every fact you use as [<id>] with the ids above. Do not cite anything not listed here or in other tool results.',
      };
    }
  );
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
        citations: [cite('LAB', lab.id, 'Lab context: ' + str(lab.name), '/context', { status: c.status || 'UNCONFIRMED' })].concat(
          projectsOf(lab.id).map(function (pj) {
            return cite('PROJECT', pj.projectId, pj.name + (pj.deadlineLabel ? ' (' + pj.deadlineLabel + ')' : ''), '/context', { deadline: pj.deadline });
          })
        ),
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
      var d = plain(Insights.labSummary(str(labId))) || {};
      d.citations = [cite('DATA', 'labSummary:' + str(labId), 'Lab dashboard (Insights.labSummary)', '/')];
      return d;
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
      return {
        count: rows.length,
        policies: rows.slice(0, 40),
        citations: rows.slice(0, 15).map(function (p) {
          return cite('POLICY', p.policyId, p.title, p.sourceUrl, { severity: p.severity, scope: p.scope, version: 'active' });
        }),
      };
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
      var d = plain(Insights.predictDuration(wt, str(gpuTypeId) || 'A100-40GB', num(gpus) || 1, num(modelParamsB) || 0)) || {};
      d.citations = [cite('DATA', 'predictDuration', 'Duration estimate from completed jobs (historical only)', '/history', { sampleSize: d.sampleSize })];
      return d;
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
          include: 'id, outcome, message, title, ruleKind, severity, scope, policy.id, policy.sourceUrl',
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
            ruleId: ref(c.policy) || 'builtin:' + str(c.ruleKind),
            rule: str(c.title),
            sourceUrl: c.policy ? str(c.policy.sourceUrl) || null : null,
            kind: str(c.ruleKind),
            severity: str(c.severity),
            message: str(c.message).substring(0, 240),
          };
        });
      var plans = arr(
        RunPlan.fetch({
          filter: Filter.eq('runRequest.id', rrId),
          include: 'id, rank, label, cluster.id, partition.id, gpuType.id, gpus, nodes, walltimeHours, estDurationHours, estCostUnits, estCostUsd, meetsDeadline, score, rationale, finishBy, deadlineSlackHours, qos, chainedJobs, preemptionRisk',
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
          estDurationHours: round(num(p.estDurationHours), 1),
          estFinish: iso(p.finishBy) || new Date(Date.now() + (num(p.estDurationHours) || 0) * 3600000).toISOString(),
          deadlineSlackHours: round(num(p.deadlineSlackHours), 1),
          qos: str(p.qos) || null,
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
        note: 'Draft only; nothing was submitted. The user launches from the Launch planner (link shown under your answer); cite rules by ruleId.',
        citations: items.map(function (c) {
          return cite('POLICY', c.ruleId, c.rule, c.sourceUrl, { severity: c.severity, outcome: c.outcome });
        }),
        _links: plans
          .map(function (p) {
            return {
              kind: 'PLAN',
              label: 'Open in Launch planner',
              title: p.label + ' plan: ' + p.gpus + 'x ' + (p.gpuType || 'GPU') + ' on ' + p.partition + ', ~$' + p.estCostUsd + (p.meetsDeadline ? ', meets deadline' : ', misses deadline'),
              href: '/plan?runRequest=' + encodeURIComponent(rrId) + '&plan=' + encodeURIComponent(p.planId),
            };
          })
          .concat(plans.length ? [] : [{ kind: 'PLAN', label: 'Open in Launch planner', title: 'Review this request', href: '/plan?runRequest=' + encodeURIComponent(rrId) }]),
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

/** Citations for a job and each of its open alerts (alert ids are cited too), all linking to the run page. */
function jobCitations(r) {
  var url = '/runs/' + encodeURIComponent(r.jobId);
  return [cite('JOB', r.jobId, r.name + ' live metrics', url)].concat(
    r.alerts.map(function (a) {
      return cite('JOB', a.alertId, a.severity + ' ' + a.alertType + ' on ' + r.jobId, url);
    })
  );
}

/** "Open run" deep link for a job; the suggested action is applied (and confirmed) on the run page, never here. */
function runLink(r) {
  var actions = r.alerts
    .map(function (a) {
      return a.recommendedAction;
    })
    .filter(function (v, i, all) {
      return v && all.indexOf(v) === i;
    });
  return {
    kind: 'RUN',
    label: 'Open run',
    title: r.jobId + ' ' + r.name + (actions.length ? ' — suggested: ' + actions.join(', ').replace(/_/g, ' ').toLowerCase() : ''),
    href: '/runs/' + encodeURIComponent(r.jobId),
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
        citations: rows
          .filter(function (r) {
            return r.alerts.length > 0;
          })
          .slice(0, 8)
          .reduce(function (acc, r) {
            return acc.concat(jobCitations(r));
          }, []),
        _links: rows
          .filter(function (r) {
            return r.alerts.length > 0;
          })
          .slice(0, 4)
          .map(function (r) {
            return runLink(r);
          }),
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
        citations: jobCitations(row),
        _links: [runLink(row)],
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
      var d = plain(Insights.universityOverview()) || {};
      d.citations = [cite('DATA', 'universityOverview', 'University overview (Insights.universityOverview)', '/admin')];
      return d;
    }
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Turn bookkeeping for Advisor.ask (Python) and the deterministic offline advisor.
// ---------------------------------------------------------------------------------------------------------------

function beginTurn() {
  return DateTime.now().minusSeconds(1).toString();
}

function turnTrace(since) {
  var start = DateTime.fromString(str(since));
  var citations = [];
  var links = [];
  var seenC = {};
  var seenL = {};
  var calls = arr(
    Advisor.ToolCall.fetch({
      filter: Filter.ge('calledAt', start),
      include: 'id, name, labId, args, summary, ok, millis, calledAt, evidence',
      order: 'ascending(calledAt)',
      limit: 50,
    }).objs
  ).map(function (c) {
    if (c.evidence) {
      try {
        var ev = JSON.parse(c.evidence);
        (ev.citations || []).forEach(function (x) {
          if (!seenC[x.id]) {
            seenC[x.id] = true;
            citations.push(x);
          }
        });
        (ev.links || []).forEach(function (x) {
          if (!seenL[x.href]) {
            seenL[x.href] = true;
            links.push(x);
          }
        });
      } catch (e) {
        log.warn('bad evidence on tool call {}', c.id);
      }
    }
    return { tool: str(c.name), args: str(c.args), summary: str(c.summary), ok: c.ok !== false, millis: num(c.millis) };
  });
  return JSON.stringify({ toolCalls: calls, citations: citations.slice(0, 30), links: links.slice(0, 8), docSet: DOC_SET_VERSION });
}

/** One markdown bullet for a retrieval hit, ending in its citation id. */
function hitLine(h) {
  var body = h.kind === 'LAB' ? 'Your lab context: "' + h.text.substring(0, 180) + '"' : h.kind === 'POLICY' ? h.title : h.title + ': ' + h.text.substring(0, 170) + (h.text.length > 170 ? '…' : '');
  return '- ' + body + ' [' + h.id + ']';
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
  var wantsJobs = /\b(running|live|jobs?|idle\w*|wast\w*|util\w*|alerts?|oom|walltime|checkpoint\w*|cancel\w*|extend\w*)\b/.test(q);
  var wantsPlan = /\b(finish|deadlines?|plans?|launch|submit|fine-?tun\w*|train\w*|run .* by|within budget|feasible|neurips|icml|iclr|cvpr|iccv|recomb|rss)\b/.test(q);
  var wantsRules = /\b(rules?|polic\w*|allowed|limits?|max\w*)\b/.test(q);
  var wantsBudget = /\b(budgets?|allocations?|left|remaining|spend\w*|costs?|expir\w*|credits?)\b/.test(q);

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
        lines.push('- ' + c.outcome + ': ' + c.message + ' [' + c.ruleId + ']');
      });
      if (remainingUsd) lines.push('\nRemaining allocation value: about $' + Math.round(remainingUsd) + '.');
      if (cheapestOk) {
        lines.push('\nThe cheapest plan that meets the deadline is **' + cheapestOk.label + '**; open it in the Launch planner (link below) to review and submit.');
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
    var found = JSON.parse(retrieveSources(question, lab.id, cl || null, 6));
    lines.push('**Relevant rules and sources' + (cl ? ' for ' + cl : '') + ':**');
    (found.hits || []).forEach(function (h) {
      lines.push(hitLine(h));
    });
  }
  if (lab && lines.length === 0 && !wantsBudget) {
    var src = JSON.parse(retrieveSources(question, lab.id, null, 4));
    if (src.hits && src.hits.length) {
      lines.push('Relevant sources:');
      src.hits.forEach(function (h) {
        lines.push(hitLine(h));
      });
    }
  }
  if (lab && (wantsBudget || lines.length === 0)) {
    var ctx = JSON.parse(labContext(lab.id));
    lines.push('**' + ctx.lab.name + '** allocations [' + lab.id + ']:');
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
