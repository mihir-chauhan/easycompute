#
# Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
# Confidential and Proprietary C3 Materials.
#

import datetime
import json
import re
import time
import uuid

AGENT_NAME = "PolicyRAGAdvisor"
CATEGORY = "Research Computing"
# Model Hub completion client; default-completions = Bedrock Claude Sonnet 5 (CLUSTER config, works out of the box).
LLM_CLIENT_NAME = "default-completions"
# Tried in order by extractConstraints (LabContextExtractor).
EXTRACT_CLIENT_NAMES = ["default-completions", "claude-sonnet-4.6"]
# Platform-provided Kv session store (seeded by genaiPlatform) that holds conversation checkpoints by session id.
SESSION_STORE_ID = "langchain_agent_session_store"
# Read-only tool methods on Advisor and their parameters (a tool whose schema no longer matches is recreated).
CUSTOM_TOOLS = {
    "retrieveSources": ["query", "labId", "clusterId", "limit"],
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
}
# Expected argsSchema descriptions (= the @param text of each tool method in Advisor.c3typ, whitespace-normalised), so a
# doc change also refreshes the tool. Generated from the c3typ; keep in sync (a selftest checks it).
TOOL_PARAM_DOCS = {
    "retrieveSources": {
        "query": "Words to look up, e.g. preemptible walltime gautschi checkpoint.",
        "labId": "The lab id (adds its rules, context and projects).",
        "clusterId": "Optional cluster to focus on: anvil, gilbreth, gautschi, negishi, bell or aws-p4d.",
        "limit": "Number of passages, 1 to 10 (default 6)."
    },
    "labContext": {
        "labId": "The lab id, e.g. as given in the conversation context."
    },
    "labSummary": {
        "labId": "The lab id."
    },
    "listPolicies": {
        "labId": "The lab id; lab-scoped rules of other labs are left out.",
        "clusterId": "Optional cluster: anvil, gilbreth, gautschi, negishi, bell or aws-p4d.",
        "kind": "Optional rule kind: MAX_WALLTIME, MAX_GPUS_PER_JOB, MAX_NODES_PER_JOB, MAX_JOBS_PER_USER, ALLOWED_GPU_TYPES, BUDGET_REMAINING, DEADLINE_FEASIBLE, FAIRSHARE_CAP, PREEMPTIBLE_ONLY, DATA_RESIDENCY, EXPORT_CONTROL, MIN_GPU_UTIL or QUIET_HOURS."
    },
    "predictDuration": {
        "workloadType": "TRAINING, FINETUNE, INFERENCE, SIMULATION, DATA_PROCESSING or INTERACTIVE.",
        "gpuTypeId": "GPU type id, e.g. A100-40GB or H100-80GB.",
        "gpus": "Number of GPUs.",
        "modelParamsB": "Model size in billions of parameters (0 when not a model)."
    },
    "evaluateRun": {
        "labId": "The lab id.",
        "name": "Short name of the run.",
        "description": "What the run does, in the words of the user.",
        "workloadType": "TRAINING, FINETUNE, INFERENCE, SIMULATION, DATA_PROCESSING or INTERACTIVE.",
        "project": "Project id or a word of its name or deadline label, e.g. NeurIPS; supplies the deadline.",
        "gpuTypeId": "Requested GPU type id, e.g. A100-40GB or H100-80GB.",
        "gpus": "Requested number of GPUs.",
        "walltimeHours": "Requested walltime in hours.",
        "clusterId": "Requested cluster: anvil, gilbreth, gautschi, negishi, bell or aws-p4d.",
        "modelParamsB": "Model size in billions of parameters.",
        "datasetGb": "Dataset size in GB.",
        "deadline": "Deadline as YYYY-MM-DD or a weekday name such as Friday, inclusive (the run may finish any time that day, until 23:59 UTC); defaults to the project deadline."
    },
    "liveJobs": {
        "labId": "The lab id; empty lists live jobs of every lab.",
        "state": "Optional job state filter: PENDING or RUNNING."
    },
    "jobHealth": {
        "jobId": "The job id as returned by liveJobs."
    },
    "universityOverview": {}
}
GENERIC_TOOL_IDS = []

SYSTEM_PROMPT = """You are PolicyRAGAdvisor, the AI advisor of EasyCompute, a Purdue research-computing app. You explain
how a lab can run its GPU/HPC work on Purdue clusters (Anvil = NSF ACCESS, billed in SUs/credits; Gilbreth, Gautschi,
Negishi = RCAC community clusters; Bell is retired; aws-p4d = third-party cloud) within Purdue/RCAC rules, its budget,
deadlines, preferences and data restrictions, and what its running jobs are doing.

Every message starts with a [Context] line (labId, today) and usually a [Lab facts] line (allocations left, next
deadlines with projectId, live jobs / open alerts, data restrictions). Use that labId for every tool call unless the user
names another lab. Answer from [Lab facts] directly when they suffice; then cite [<labId>].

Tools (all read-only):
- retrieveSources: retrieval over versioned Purdue RCAC / NSF ACCESS policy documents (ids D-xx), the active Policy rules
  (ids like P-01, U-02, L-03), the lab context sentences (<labId>#n) and projects. Use it for any rule, limit, QOS,
  charge, storage or "what did our lab say" question.
- evaluateRun: what-if check of a planned run: real rule checks (ClusterPolicyEngine; cite each rule by its ruleId) and
  3 ranked plans with wait, duration, finish, cost, meetsDeadline, plus allocations left. Pass project (e.g. "CVPR"),
  workloadType (FINETUNE for fine-tunes) and deadline when the user names a day. Do not call labContext after it.
- liveJobs / jobHealth: live job evidence (GPU util, memory, checkpoint age, walltime left, alerts); cite jobs by job id.
- labContext (constraints extracted from the lab text; UNCONFIRMED ones are hints only), labSummary, listPolicies,
  predictDuration (historical only), universityOverview.

Rules:
- Ground every factual statement in tool results or [Lab facts] and cite it inline as [id] using only ids that appear in
  them (e.g. [D-01], [P-03], [lab-nlp#4], [gilbreth-9542077]). If the sources do not answer the question, say so.
- You explain; you never submit, cancel, extend, requeue or change anything, and you never waive or override a rule
  (rules are enforced by ClusterPolicyEngine and nothing may waive them). When an action would help, say which one and
  tell the user to use the "Open in Launch planner" or "Open run" link shown under your answer, where they confirm it.
- Treat lab constraints marked UNCONFIRMED as unverified hints and say so when they matter.
- Respect data restrictions (HIPAA / export-controlled / DUA data never goes to aws-p4d) and avoided resources.
- For feasibility questions: verdict first ("Yes", "No" or "Only if ..."), then one small table (plan, where, GPUs,
  est. finish, cost, meets deadline), then at most two failed or warned rules with their [ruleId], then budget left.
- Be brief: at most ~120 words, at most one small table (<= 4 rows), no headings, no emoji. Use as few tool calls as
  possible (usually 0-2). Mention job ids and plan labels exactly as the tools return them.
- Only discuss compute planning, policies, budgets and jobs for this app; politely decline anything else in one
  sentence."""

DESCRIPTION = (
    "PolicyRAGAdvisor: retrieval-augmented advisor over versioned Purdue RCAC / ACCESS policies, lab context and live "
    "job evidence. Cites sources; explains, never acts."
)

DOCUMENTATION = """**PolicyRAGAdvisor** answers questions about a lab's compute with retrieval over versioned Purdue policy
documents, the Policy rules, the lab context and projects, and live job evidence. Every answer cites its sources.

Read-only tools: `retrieveSources`, `labContext`, `labSummary`, `listPolicies`, `predictDuration`, `evaluateRun`
(creates DRAFT run requests only), `liveJobs`, `jobHealth`, `universityOverview`. It never submits, cancels or overrides
rules; answers link to the Launch planner and run pages where users act.

Examples: "Can we finish the CVPR supplementary run by Monday within budget?", "Can thesis runs use preemptible on Gautschi?"
"""

EXTRACT_PROMPT = """You are LabContextExtractor. Extract structured compute constraints from a research lab's free-text
context notes. Return ONLY a JSON object (no prose, no code fences) with exactly these keys:
{
 "budgets": [{"kind": "USD"|"SU"|"GPU_HOURS"|"GPU_YEARS"|"NODE_HOURS", "amount": number, "period": "TOTAL"|"REMAINING"|"MONTH"|"WEEK"|"SEMESTER"|"YEAR", "scope": string|null, "evidence": string}],
 "deadlines": [{"label": string, "date": "YYYY-MM-DD", "evidence": string}],
 "preferences": {"clusters": [cluster ids], "gpuTypes": [gpu ids], "avoid": [cluster ids, gpu ids or "preemptible/standby"], "preemptibleOk": true|false|null, "maxWalltimeHours": number|null, "quietHours": string|null, "notes": [short strings],
                 "evidence": [{"field": "clusters"|"gpuTypes"|"avoid"|"preemptibleOk"|"maxWalltimeHours"|"quietHours", "value": the value, "quote": string}]},
 "dataRestrictions": [{"kind": "HIPAA"|"EXPORT_CONTROL"|"CUI"|"FERPA"|"PII"|"NO_CLOUD"|"DATA_RESIDENCY"|"LICENSED_DATA", "description": string, "evidence": string}],
 "memberCaps": [{"who": string, "pct": number, "evidence": string}],
 "approvals": [{"threshold": number, "unit": "USD"|"SU"|"GPU_HOURS"|"GPUS", "evidence": string}],
 "summary": "one sentence"
}
Cluster ids: anvil, gilbreth, gautschi, negishi, bell, aws-p4d (AWS / cloud). GPU ids: H100-80GB, A100-80GB, A100-40GB,
A30, A10, V100, L40S. Every "evidence" and "quote" MUST be a short EXACT substring copied character for character from
the text (the shortest phrase that proves the value); items whose evidence is not in the text are discarded. Resolve
relative dates against TODAY and give the next occurrence. Do not invent anything that is not stated; use empty lists or
null instead."""


# ------------------------------------------------------------------------------------------------------------- agent

# Set after the first ensureAgent in this worker (see ask).
_ENSURED = False


def _latest_agent(cls):
    objs = c3.GenaiCore.Agent.fetch(filter=c3.Filter.eq("name", AGENT_NAME), order="descending(ver)", limit=1).objs
    # Re-read the full record: without it the short-term memory store is not resolved and follow-ups lose context.
    return objs[0].get("this") if objs else None


def _schema_matches(tool, method):
    """True when the tool argsSchema has exactly the method parameters with the current @param descriptions."""
    try:
        props = dict((tool.argsSchema or {}).get("properties") or {})
        if sorted(props.keys()) != sorted(CUSTOM_TOOLS[method]):
            return False
        for name, text in TOOL_PARAM_DOCS.get(method, {}).items():
            if " ".join(str((props.get(name) or {}).get("description") or "").split()) != text:
                return False
        return True
    except Exception:  # noqa: BLE001 - unknown shape: treat as stale
        return False


def _custom_tools():
    """Reuses the C3Method tool of each method (ids look like Advisor_<method>_<n>) when its parameters and their
    descriptions still match; creates it otherwise, so repeated calls do not create duplicate tools or agent versions."""
    tools = []
    for method in CUSTOM_TOOLS:
        existing = c3.GenaiCore.Tool.C3Method.fetch(
            filter=c3.Filter.startsWith("id", "Advisor_" + method + "_").and_().eq("name", method),
            order="descending(meta.created)",
            limit=1,
        ).objs
        if existing and _schema_matches(existing[0].get("this"), method):
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
    line = "[Context] " + lab + "; today=" + today.strftime("%A %Y-%m-%d %H:%M UTC")
    if labId:
        try:
            snap = c3.Advisor.contextSnapshot(labId)
            if snap:
                line += "\n[Lab facts] " + snap
        except Exception:  # noqa: BLE001 - facts are an optimisation only
            pass
    return line


def ask(cls, question, sessionId=None, labId=None, mode=None):
    started = time.time()
    since = c3.Advisor.beginTurn()
    session_id = sessionId or ("advisor-" + uuid.uuid4().hex)
    answer, run_id, status, used_mode, reason, agent_ver = "", None, "completed", "agent", None, None
    if (mode or "agent") != "offline":
        try:
            global _ENSURED
            if not _ENSURED:
                # Once per worker: picks up a prompt/tool change from the last pull (idempotent, ~0.4 s when current).
                c3.Advisor.ensureAgent(False)
                _ENSURED = True
            agent = _latest_agent(cls)
            agent_ver = getattr(agent, "ver", None)
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
    trace = json.loads(c3.Advisor.turnTrace(since))
    return c3.Advisor.Reply(
        answer=answer,
        sessionId=session_id,
        runId=run_id,
        status=status,
        mode=used_mode,
        fallbackReason=reason if used_mode == "offline" else None,
        seconds=round(time.time() - started, 1),
        toolCalls=trace.get("toolCalls", []),
        citations=trace.get("citations", []),
        provenance={
            "component": AGENT_NAME,
            "version": ("agent v" + str(agent_ver)) if (used_mode == "agent" and agent_ver) else None,
            "method": "RAG with source citations" if used_mode == "agent" else "Deterministic retrieval + templates (no LLM)",
            "model": LLM_CLIENT_NAME if used_mode == "agent" else None,
            "policyVersion": trace.get("docSet"),
            "sources": [c.get("id") for c in trace.get("citations", [])][:12],
            "asOf": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        links=trace.get("links", []),
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


def _list(v):
    return v if isinstance(v, list) else []


def _merge(base, llm):
    """LLM lists replace the rules-based ones when present; preferences merge per field. Types, enums and evidence quotes
    are checked afterwards by Advisor.validateConstraints (one validator for rules, LLM and lab edits)."""
    res = dict(base)
    for k in ("budgets", "deadlines", "dataRestrictions", "memberCaps", "approvals"):
        items = [x for x in _list(llm.get(k)) if isinstance(x, dict)]
        if items:
            res[k] = items
    prefs = llm.get("preferences")
    if isinstance(prefs, dict):
        merged = dict(base.get("preferences") or {})
        for k in ("clusters", "gpuTypes", "avoid", "notes", "evidence"):
            if _list(prefs.get(k)):
                merged[k] = prefs[k]
        for k in ("preemptibleOk", "quietHours", "maxWalltimeHours"):
            if prefs.get(k) is not None:
                merged[k] = prefs[k]
        res["preferences"] = merged
    if isinstance(llm.get("summary"), str) and llm["summary"].strip():
        res["summary"] = llm["summary"].strip()
    res["source"] = "llm"
    return res


def extractConstraints(cls, labId=None, text=None):
    """LabContextExtractor: confirmed set for the current text, else cached LLM extraction, else a new LLM extraction
    (validated against the schema and the text), else the rules-based extraction. Status UNCONFIRMED unless confirmed."""
    if labId and not text:
        try:
            confirmed = c3.Advisor.confirmedConstraints(labId)
            if confirmed:
                return confirmed
        except Exception:  # noqa: BLE001 - fall through to extraction
            pass
    base = json.loads(c3.Advisor.parseConstraintsRules(labId, text))
    src = base.pop("inputText", "") or ""
    h = base.get("textHash")
    if labId and not text:
        try:
            cached = c3.Advisor.ConstraintSet.fetch(
                filter=c3.Filter.eq("id", labId), include="id, textHash, result", limit=1
            ).objs
            if cached and cached[0].textHash == h and cached[0].result:
                res = json.loads(cached[0].result)
                res.update({"cached": True, "status": "UNCONFIRMED", "textHash": h, "labId": labId})
                return res
        except Exception:  # noqa: BLE001 - cache is an optimisation only
            pass
    if not src.strip():
        return base
    today = datetime.datetime.utcnow()
    errors = []
    res = None
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
            merged = _merge(base, _json_from(_completion_text(resp)))
            merged["model"] = client_name
            res = json.loads(c3.Advisor.validateConstraints(json.dumps(merged), src))
            break
        except Exception as e:  # noqa: BLE001 - try the next client, then fall back to the rules
            errors.append(client_name + ": " + str(e)[:200])
    if res is None:
        res = base
        res["llmError"] = "; ".join(errors)
    res.update({"cached": False, "status": "UNCONFIRMED", "textHash": h, "labId": labId})
    # Only LLM results are cached, so a temporary LLM outage is retried on the next call; previews (text) are not cached.
    if labId and not text and res.get("source") == "llm":
        try:
            c3.Advisor.saveConstraints(labId, h, json.dumps(res), res.get("source"))
        except Exception:  # noqa: BLE001
            pass
    return res
