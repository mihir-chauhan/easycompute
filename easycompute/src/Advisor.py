#
# Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
# Confidential and Proprietary C3 Materials.
#

import datetime
import json
import re
import time
import uuid

AGENT_NAME = "EasyCompute Advisor"
CATEGORY = "Research Computing"
# Model Hub completion client; default-completions = Bedrock Claude Sonnet 5 (CLUSTER config, works out of the box).
LLM_CLIENT_NAME = "default-completions"
# Tried in order by extractConstraints.
EXTRACT_CLIENT_NAMES = ["default-completions", "claude-sonnet-4.6"]
# Platform-provided Kv session store (seeded by genaiPlatform) that holds conversation checkpoints by session id.
SESSION_STORE_ID = "langchain_agent_session_store"
# Tool methods on Advisor and their parameters (a tool whose schema no longer matches is recreated).
CUSTOM_TOOLS = {
    "labContext": ["labId"],
    "labSummary": ["labId"],
    "listPolicies": ["labId", "clusterId", "kind"],
    "predictDuration": ["workloadType", "gpuTypeId", "gpus", "modelParamsB"],
    "evaluateRun": [
        "labId", "name", "description", "workloadType", "project", "gpuTypeId", "gpus",
        "walltimeHours", "clusterId", "modelParamsB", "datasetGb", "deadline",
    ],
    "liveJobs": ["labId", "state"],
    "jobHealth": ["jobId"],
    "universityOverview": [],
    "proposeRunSubmission": ["runRequestId", "planId", "reason"],
    "proposeJobAction": ["jobId", "actionType", "reason"],
}
GENERIC_TOOL_IDS = []

SYSTEM_PROMPT = """You are the EasyCompute Advisor, the AI assistant of a Purdue research-computing app. You help a
research lab plan and run GPU/HPC jobs across Purdue clusters (Anvil = NSF ACCESS, billed in SUs; Gilbreth, Gautschi,
Negishi, Bell = RCAC community clusters, in-house node shares; aws-p4d = third-party cloud, billed hourly in USD) within
its budget, deadlines, preferences and data restrictions, and you watch its running jobs.

Every message starts with a [Context] line naming the lab the user is looking at (labId) and today. Use that labId for
every tool call unless the user names another lab.

Tools:
- labContext: lab profile, allocations (remaining units / dollars, end dates), projects with deadlines, and constraints
  parsed from the lab's context dump (budgets, deadlines, preferred/avoided clusters and GPUs, data restrictions).
  Call it first for any budget, deadline or preference question.
- evaluateRun: what-if check of a planned run. It runs the real rule checks and returns 3 ranked plans (Fastest,
  Cheapest, Balanced) with estimated wait, duration, finish time, cost and meetsDeadline. Use it for every "can we
  finish X by Y", "where should we run", "how much will it cost" question. Pass project (e.g. "NeurIPS") so the project
  deadline is used, the workloadType (FINETUNE for fine-tunes), and deadline when the user names a day ("Friday").
- predictDuration: duration estimate from past jobs.
- listPolicies: university / cluster / partition / lab rules.
- liveJobs and jobHealth: running jobs, GPU utilization, checkpoint age, walltime left, open alerts, suggested actions.
- labSummary: the lab dashboard numbers. universityOverview: Purdue-wide utilization, cost, fairness, idle capacity
  and demand.
- proposeRunSubmission and proposeJobAction: the ONLY way to act. They create a proposal card; nothing happens until
  the user clicks Confirm.

Rules:
- Always get numbers from tools; never guess. Quote concrete figures (GPU-hours, dollars, hours, dates, utilization).
- For feasibility questions give a clear verdict first: "Yes", "No" or "Only if ...", then the best plan(s) in a small
  markdown table (plan, where, GPUs, est. finish, cost, meets deadline), then failed or warned rules, then the budget
  left after the run. Respect the lab's data restrictions (HIPAA / export-controlled data never goes to aws-p4d) and
  avoided resources.
- You never submit, cancel, extend or change anything yourself. When a concrete action would help (submitting the best
  plan, extending the walltime of a job about to time out, cancelling an idle job, checkpointing a job with a stale
  checkpoint), call the propose tool once for that action and then tell the user it is waiting for their Confirm on the
  card below the answer. Never claim an action was done. If the user asks you to do something, propose it.
- Do not propose more than two actions in one answer. Do not re-propose an action that is already pending.
- If a tool returns an error, read it and retry with corrected arguments once; otherwise explain what is missing.
- Answer concisely in markdown. Lead with the answer. Mention job ids and plan labels exactly as the tools return them.
- Only discuss compute planning, budgets, policies and jobs for this app. Politely decline unrelated requests in one
  sentence."""

DESCRIPTION = (
    "Plans GPU runs against Purdue cluster rules, lab budgets and deadlines, watches live jobs, and proposes actions "
    "that the user confirms."
)

DOCUMENTATION = """**EasyCompute Advisor** answers questions about a lab's compute: budget, deadlines, policies, run
plans and live jobs.

Read-only tools: `labContext`, `labSummary`, `listPolicies`, `predictDuration`, `evaluateRun` (creates DRAFT run
requests only), `liveJobs`, `jobHealth`, `universityOverview`. Propose-only tools: `proposeRunSubmission`,
`proposeJobAction` record an `Advisor.Proposal`; the user applies it with Confirm on the Assistant page.

Examples: "Can we finish the NeurIPS fine-tune by Friday within budget?", "Which of our running jobs are wasting GPUs?"
"""

EXTRACT_PROMPT = """You extract structured compute constraints from a research lab's free-text context notes.
Return ONLY a JSON object (no prose, no code fences) with exactly these keys:
{
 "budgets": [{"kind": "USD"|"SU"|"GPU_HOURS"|"GPU_YEARS"|"NODE_HOURS", "amount": number, "period": "TOTAL"|"REMAINING"|"MONTH"|"WEEK"|"SEMESTER"|"YEAR", "scope": string|null, "evidence": string}],
 "deadlines": [{"label": string, "date": "YYYY-MM-DD", "evidence": string}],
 "preferences": {"clusters": [cluster ids], "gpuTypes": [gpu ids], "avoid": [cluster ids, gpu ids or "preemptible/standby"], "preemptibleOk": true|false|null, "maxWalltimeHours": number|null, "quietHours": string|null, "notes": [short strings]},
 "dataRestrictions": [{"kind": "HIPAA"|"EXPORT_CONTROL"|"CUI"|"FERPA"|"PII"|"NO_CLOUD"|"DATA_RESIDENCY"|"LICENSED_DATA", "description": string, "evidence": string}],
 "memberCaps": [{"who": string, "pct": number, "evidence": string}],
 "approvals": [{"threshold": number, "unit": "USD"|"SU"|"GPU_HOURS", "evidence": string}],
 "summary": "one sentence"
}
Cluster ids: anvil, gilbreth, gautschi, negishi, bell, aws-p4d (AWS / cloud). GPU ids: H100-80GB, A100-80GB, A100-40GB,
A30, A10, V100, L40S. "evidence" is the exact source sentence. Resolve relative dates against TODAY and give the next
occurrence. Do not invent anything that is not stated in the text; use empty lists or null instead."""


# ------------------------------------------------------------------------------------------------------------- agent

def _latest_agent(cls):
    objs = c3.GenaiCore.Agent.fetch(filter=c3.Filter.eq("name", AGENT_NAME), order="descending(ver)", limit=1).objs
    # Re-read the full record: without it the short-term memory store is not resolved and follow-ups lose context.
    return objs[0].get("this") if objs else None


def _schema_params(tool):
    try:
        schema = tool.argsSchema or {}
        props = schema.get("properties") if isinstance(schema, dict) else None
        return sorted((props or {}).keys())
    except Exception:  # noqa: BLE001 - unknown shape: treat as stale
        return []


def _custom_tools():
    """Reuses the C3Method tool of each method (ids look like Advisor_<method>_<n>) when its parameters still match;
    creates it otherwise, so repeated calls do not create duplicate tools or agent versions."""
    tools = []
    for method, params in CUSTOM_TOOLS.items():
        existing = c3.GenaiCore.Tool.C3Method.fetch(
            filter=c3.Filter.startsWith("id", "Advisor_" + method + "_").and_().eq("name", method),
            order="descending(meta.created)",
            limit=1,
        ).objs
        if existing and _schema_params(existing[0].get("this")) == sorted(params):
            tools.append(existing[0])
        else:
            tools.append(c3.GenaiCore.Tool.C3Method.createFromMethodName(type=c3.Advisor, methodName=method))
    return tools


def _new_agent(tool_ids):
    return c3.GenaiCore.Agent.LangChain(
        name=AGENT_NAME,
        description=DESCRIPTION,
        documentation=DOCUMENTATION,
        category=CATEGORY,
        systemPrompt=SYSTEM_PROMPT,
        llmClient=c3.GenaiCore.Llm.Completion.Client(name=LLM_CLIENT_NAME),
        tools=[c3.GenaiCore.Tool(id=i) for i in tool_ids],
        # the store must be referenced by its concrete Kv type, otherwise memory is silently not restored
        shortTermMemoryStore=c3.GenaiCore.SessionStore.Kv(id=SESSION_STORE_ID),
    )


def ensureAgent(cls, publish=False):
    tools = _custom_tools() + [c3.GenaiCore.Tool.forId(tid) for tid in GENERIC_TOOL_IDS]
    tool_ids = [t.id for t in tools]
    latest = _latest_agent(cls)
    if latest is None:
        agent = _new_agent(tool_ids).create()
    else:
        same = (
            latest.type().name() == "GenaiCore.Agent.LangChain"
            and latest.systemPrompt == SYSTEM_PROMPT
            and latest.llmClient is not None
            and latest.llmClient.name == LLM_CLIENT_NAME
            and [t.id for t in (latest.tools or [])] == tool_ids
            and latest.shortTermMemoryStore is not None
            and latest.shortTermMemoryStore.type().name() == "GenaiCore.SessionStore.Kv"
        )
        agent = latest if same else _new_agent(tool_ids).createNewVersion()
    if publish:
        agent = agent.publishAgent()
    return agent.id


def _text_of(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        return "\n\n".join(_text_of(v) for v in content.values())
    value = getattr(content, "value", None)
    if isinstance(value, str):
        return value
    parts = getattr(content, "parts", None)
    if parts:
        return "".join(_text_of(p) for p in parts)
    for attr in ("text", "content"):
        v = getattr(content, attr, None)
        if isinstance(v, str):
            return v
    return str(content)


def _context_line(labId):
    today = datetime.datetime.utcnow()
    lab = ""
    if labId:
        try:
            objs = c3.Lab.fetch(filter=c3.Filter.eq("id", labId), include="id, name", limit=1).objs
            lab = "labId=" + labId + (" (" + objs[0].name + ")" if objs else "")
        except Exception:  # noqa: BLE001
            lab = "labId=" + labId
    else:
        lab = "no lab selected"
    return "[Context] " + lab + "; today=" + today.strftime("%A %Y-%m-%d %H:%M UTC")


def ask(cls, question, sessionId=None, labId=None, mode=None):
    started = time.time()
    since = c3.Advisor.beginTurn()
    session_id = sessionId or ("advisor-" + uuid.uuid4().hex)
    answer, run_id, status, used_mode, reason = "", None, "completed", "agent", None
    if (mode or "agent") != "offline":
        try:
            agent = _latest_agent(cls)
            if agent is None:
                c3.Advisor.ensureAgent(False)
                agent = _latest_agent(cls)
            # The session id is the LangChain thread id: the agent restores/saves the conversation in its Kv store.
            run = agent.run(
                query=_context_line(labId) + "\n\n" + question,
                spec=c3.GenaiCore.Agent.RunSpec(sessionId=session_id),
            )
            run = run.get("id, status, error, response")
            run_id, status = run.id, str(run.status)
            answer = _text_of(run.response)
            if not answer:
                reason = "The agent returned no answer" + (": " + str(run.error) if run.error else "")
        except Exception as e:  # noqa: BLE001 - any agent/LLM failure falls back to the offline advisor
            reason = "Agent unavailable: " + str(e)[:300]
    else:
        reason = "Offline mode requested"
    if not answer:
        used_mode, status, run_id = "offline", "completed", None
        answer = c3.Advisor.offlineAnswer(question, labId)
    trace = json.loads(c3.Advisor.turnTrace(since, labId))
    return c3.Advisor.Reply(
        answer=answer,
        sessionId=session_id,
        runId=run_id,
        status=status,
        mode=used_mode,
        fallbackReason=reason if used_mode == "offline" else None,
        seconds=round(time.time() - started, 1),
        toolCalls=trace.get("toolCalls", []),
        proposals=trace.get("proposals", []),
    )


# -------------------------------------------------------------------------------------------------- constraints

def _completion_text(resp):
    if isinstance(resp, dict):
        return resp["choices"][0]["message"]["content"]
    try:
        return resp.choices[0].message.content
    except Exception:  # noqa: BLE001
        return resp["choices"][0]["message"]["content"]


def _json_from(text):
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("LLM returned no JSON object")
    return json.loads(t[start:end + 1])


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _list(v):
    return v if isinstance(v, list) else []


def _merge(base, llm, today):
    """LLM fields replace the rules-based ones when they are present and well-formed; the rest is kept."""
    res = dict(base)
    budgets = []
    for b in _list(llm.get("budgets")):
        if isinstance(b, dict) and _num(b.get("amount")) is not None and b.get("kind"):
            budgets.append({
                "kind": str(b["kind"]).upper(), "amount": _num(b["amount"]), "period": b.get("period") or "TOTAL",
                "scope": b.get("scope"), "evidence": b.get("evidence"),
            })
    if budgets:
        res["budgets"] = budgets
    deadlines = []
    for d in _list(llm.get("deadlines")):
        try:
            day = datetime.datetime.strptime(str(d.get("date"))[:10], "%Y-%m-%d")
        except (ValueError, TypeError, AttributeError):
            continue
        day = day.replace(hour=23, minute=59)
        deadlines.append({
            "label": d.get("label") or "Deadline", "date": day.strftime("%Y-%m-%dT%H:%M:00.000Z"),
            "daysAway": round((day - today).total_seconds() / 86400.0, 1), "evidence": d.get("evidence"),
        })
    if deadlines:
        res["deadlines"] = sorted(deadlines, key=lambda x: x["date"])
    prefs = llm.get("preferences")
    if isinstance(prefs, dict):
        merged = dict(base.get("preferences") or {})
        for k in ("clusters", "gpuTypes", "avoid", "notes"):
            if _list(prefs.get(k)):
                merged[k] = [str(x) for x in prefs[k]]
        for k in ("preemptibleOk", "quietHours"):
            if prefs.get(k) is not None:
                merged[k] = prefs[k]
        if _num(prefs.get("maxWalltimeHours")) is not None:
            merged["maxWalltimeHours"] = _num(prefs["maxWalltimeHours"])
        res["preferences"] = merged
    for k in ("dataRestrictions", "memberCaps", "approvals"):
        items = [x for x in _list(llm.get(k)) if isinstance(x, dict)]
        if items:
            res[k] = items
    if isinstance(llm.get("summary"), str) and llm["summary"].strip():
        res["summary"] = llm["summary"].strip()
    res["source"] = "llm"
    return res


def extractConstraints(cls, labId=None, text=None):
    base = json.loads(c3.Advisor.parseConstraintsRules(labId, text))
    src = base.pop("inputText", "") or ""
    h = base.get("textHash")
    if labId:
        try:
            cached = c3.Advisor.ConstraintSet.fetch(
                filter=c3.Filter.eq("id", labId), include="id, textHash, result", limit=1
            ).objs
            if cached and cached[0].textHash == h and cached[0].result:
                res = json.loads(cached[0].result)
                res["cached"] = True
                return res
        except Exception:  # noqa: BLE001 - cache is an optimisation only
            pass
    if not src.strip():
        return base
    today = datetime.datetime.utcnow()
    errors = []
    for client_name in EXTRACT_CLIENT_NAMES:
        try:
            client = c3.GenaiCore.Llm.Completion.Client(name=client_name)
            resp = client.completion(
                messages=[
                    {"role": "system", "content": EXTRACT_PROMPT},
                    {"role": "user", "content": "TODAY: " + today.strftime("%A %Y-%m-%d") + "\n\nLAB CONTEXT:\n" + src[:12000]},
                ],
                options={"returnJson": True, "temperature": 0, "max_tokens": 2500},
            )
            res = _merge(base, _json_from(_completion_text(resp)), today)
            res["model"] = client_name
            break
        except Exception as e:  # noqa: BLE001 - try the next client, then fall back to the rules
            errors.append(client_name + ": " + str(e)[:200])
    else:
        res = base
        res["llmError"] = "; ".join(errors)
    res["cached"] = False
    # Only LLM results are cached, so a temporary LLM outage is retried on the next call.
    if labId and res.get("source") == "llm":
        try:
            c3.Advisor.saveConstraints(labId, h, json.dumps(res), res.get("source"))
        except Exception:  # noqa: BLE001
            pass
    return res
