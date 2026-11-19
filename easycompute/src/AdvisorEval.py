#
# Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
# Confidential and Proprietary C3 Materials.
#

import datetime
import json

AGENT_NAME = "EasyCompute Advisor"
DATASET_ID = "easycompute-advisor-smoke"
DATASET_NAME = "EasyCompute Advisor smoke"
EXPERIMENT_NAME = "EasyCompute Advisor regression"
METRIC_NAME = "easycompute_advisor_rubric"
JUDGE_CLIENT_KEY = "default-completions"
REF_RUN_REQUEST_ID = "advisoreval-ref-finetune-4gpu"
CASE_PREFIX = "advisor-smoke-"
ALLOCATION_LAB = "lab-nlp"
PLAN_LAB = "lab-nlp"

# The metric. NativePy metrics are looked up by function name, so the function is named like the metric.
# The built-in GenaiCore.Eval.Metric.Rubric reads values["output"] (the default runner records "actual_output") and calls
# the client without returnJson (which fails outside the litellm runtimes), so the rubric judge is implemented here.
METRIC_SRC = '''
def easycompute_advisor_rubric(test_case, values):
    """Rubric LLM judge (default-completions) scoring 0..1; falls back to keyword coverage when no LLM answers."""
    import json
    import re

    def plain(v):
        if v is None:
            return None
        if isinstance(v, (str, int, float, bool)):
            return v
        if isinstance(v, dict) or hasattr(v, "items"):
            return {str(k): plain(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)) or hasattr(v, "__iter__"):
            return [plain(x) for x in v]
        return str(v)

    fields = plain(getattr(test_case, "fields", None)) or {}
    actual = str((values or {}).get("actual_output") or (values or {}).get("output") or "").strip()
    if not actual:
        return 0.0

    norm = lambda s: re.sub(r"[\\s,]+", " ", str(s).lower())
    text = norm(actual)
    groups = fields.get("keywords") or []
    hits = 0
    for g in groups:
        alts = g if isinstance(g, list) else [g]
        if any(norm(a).strip() in text for a in alts if str(a).strip()):
            hits += 1
    kw_score = (hits / float(len(groups))) if groups else 1.0

    system = (
        "You are a strict evaluator of an AI research-computing advisor. Score the ANSWER against the RUBRIC and the "
        "REFERENCE facts (taken from live data at dataset build time; small numeric drift from live updates is fine). "
        "Return ONLY JSON: {\\"score\\": <integer 0-10>, \\"reason\\": \\"<one sentence>\\"}."
    )
    user = (
        "QUESTION:\\n" + str(fields.get("input") or "") + "\\n\\nREFERENCE:\\n" + str(fields.get("expected_output") or "")
        + "\\n\\nRUBRIC:\\n" + json.dumps(fields.get("rubric") or "", indent=1) + "\\n\\nANSWER:\\n" + actual[:6000]
    )
    try:
        client = c3.GenaiCore.Llm.Completion.Client.forConfigKey("default-completions")
        resp = client.completion(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            options={"returnJson": True},
        )
        resp = plain(resp)
        content = resp["choices"][0]["message"]["content"]
        m = re.search(r"\\{.*\\}", content, re.S)
        score = float(json.loads(m.group(0))["score"]) if m else float(re.search(r"\\d+(\\.\\d+)?", content).group(0))
        return round(max(0.0, min(10.0, score)) / 10.0, 3)
    except Exception:  # noqa: BLE001 - no judge available: keyword check
        return round(kw_score, 3)
'''


# ----------------------------------------------------------------------------------------------------------- helpers


def _plain(v):
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if hasattr(v, "toJson"):
        try:
            return _plain(v.toJson())
        except Exception:  # noqa: BLE001
            pass
    if isinstance(v, dict) or hasattr(v, "items"):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)) or hasattr(v, "__iter__"):
        return [_plain(x) for x in v]
    return str(v)


def _fmt(n, digits=0):
    if n is None:
        return "n/a"
    try:
        n = float(n)
    except (TypeError, ValueError):
        return str(n)
    return f"{n:,.{digits}f}"


def _lab_name(lab_id):
    objs = c3.Lab.fetch(filter=c3.Filter.eq("id", lab_id), include="id, name", limit=1).objs
    return objs[0].name if objs else lab_id


def _context(lab_id):
    now = datetime.datetime.utcnow()
    return f"[Context] labId={lab_id} ({_lab_name(lab_id)}); today={now.strftime('%A %Y-%m-%d %H:%M UTC')}\n\n"


# ------------------------------------------------------------------------------------------------------------ cases


def _case_allocations():
    s = _plain(c3.Insights.labSummary(ALLOCATION_LAB)) or {}
    allocs = s.get("allocations") or []
    parts, kws = [], []
    for a in allocs:
        parts.append(
            f"{a.get('clusterName') or a.get('clusterId')} ({a.get('id')}): {_fmt(a.get('remainingUnits'))} of "
            f"{_fmt(a.get('totalUnits'))} {a.get('unitName') or 'units'} left, {_fmt((a.get('pctUsed') or 0) * 100)}% used, "
            f"about ${_fmt(a.get('remainingUsd'))} remaining"
        )
        kws.append([str(a.get("clusterName") or a.get("clusterId"))])
    total = (s.get("kpis") or {}).get("allocationRemainingUsd")
    expected = (
        f"{_lab_name(ALLOCATION_LAB)} has {len(allocs)} allocation(s): " + "; ".join(parts)
        + (f". Total remaining is about ${_fmt(total)}." if total is not None else ".")
    )
    return {
        "name": "Allocation left",
        "labId": ALLOCATION_LAB,
        "input": "How much of our compute allocation do we have left on each cluster?",
        "expected_output": expected,
        "keywords": kws,
        "rubric": [
            {"criterion": "Lists every allocation of the lab by cluster", "points": 4},
            {"criterion": "Remaining units and/or dollars match the reference (within live drift)", "points": 4},
            {"criterion": "Concise and does not invent allocations", "points": 2},
        ],
    }


def _case_live_issues():
    alerts = c3.JobAlert.fetch(
        filter=c3.Filter.eq("status", "OPEN").and_().eq("job.isLive", True),
        include="id, lab.id, job.id, alertType, severity, recommendedAction, message",
        limit=500,
    ).objs
    by_lab = {}
    for a in alerts:
        if a.lab is not None:
            by_lab.setdefault(a.lab.id, []).append(a)
    lab_id = max(by_lab, key=lambda k: len(by_lab[k])) if by_lab else ALLOCATION_LAB
    rows = by_lab.get(lab_id, [])
    jobs = sorted(set(a.job.id for a in rows))
    lines = [f"{a.job.id}: {a.alertType} ({a.severity}), recommended {a.recommendedAction}" for a in rows]
    expected = (
        f"{_lab_name(lab_id)} has {len(jobs)} live job(s) with open alerts: " + "; ".join(lines)
        + ". The advisor should explain each alert and suggest the recommended action, which the user must confirm."
        if rows
        else f"{_lab_name(lab_id)} has no live jobs with open alerts."
    )
    return {
        "name": "Live jobs with issues",
        "labId": lab_id,
        "input": "Which of our live jobs have problems right now, and what should we do about each?",
        "expected_output": expected,
        "keywords": [[j] for j in jobs],
        "rubric": [
            {"criterion": "Names every live job with an open alert (job ids from the reference)", "points": 4},
            {"criterion": "States the alert type / cause for each job", "points": 3},
            {"criterion": "Gives the recommended action and does not claim to have applied it", "points": 3},
        ],
    }


def _case_gautschi_walltime():
    pols = c3.Policy.fetch(
        filter=c3.Filter.eq("kind", "MAX_WALLTIME").and_().contains("description", "Gautschi ai"),
        include="id, description",
        limit=20,
    ).objs
    lines = [f"{p.id}: {p.description}" for p in pols]
    normal = next((p for p in pols if "normal" in (p.description or "")), None)
    expected = (
        "Gautschi H100 (ai partition) walltime rules: " + " | ".join(lines)
        + " The normal-QOS limit is the key answer; longer runs must checkpoint and chain jobs (--dependency=afterok)."
    )
    hours = "96"
    if normal is not None:
        import re

        m = re.search(r"<=\s*(\d+)\s*h", normal.description or "")
        hours = m.group(1) if m else hours
    return {
        "name": "Gautschi H100 walltime limit",
        "labId": PLAN_LAB,
        "input": "What is the maximum walltime for an H100 job on Gautschi, and what can I do if my training needs longer?",
        "expected_output": expected,
        "keywords": [[hours + " h", hours + "h", hours + " hour"], ["checkpoint"]],
        "rubric": [
            {"criterion": f"States the {hours} h limit for normal QOS on the Gautschi ai (H100) partition", "points": 5},
            {"criterion": "Mentions checkpointing and chaining jobs (or a QOS with a longer limit) for longer runs", "points": 3},
            {"criterion": "Cites the policy / rule and does not invent other limits", "points": 2},
        ],
    }


def _remove_run_request(rr_id):
    """Removes a reference DRAFT run request with its rule checks and plans (it was never submitted)."""
    flt = c3.Filter.eq("runRequest.id", rr_id)
    for t in (c3.RunPlan, c3.RuleCheck):
        objs = t.fetch(filter=flt, include="id", limit=-1).objs
        if objs:
            t.removeBatch(objs)
    rrs = c3.RunRequest.fetch(filter=c3.Filter.eq("id", rr_id).and_().ne("status", "SUBMITTED"), include="id", limit=1).objs
    if rrs:
        c3.RunRequest.removeBatch(rrs)


def _case_cheapest_plan():
    # Reference from the agent's own planner tool (same inputs the agent passes), then the draft is removed again.
    _remove_run_request(REF_RUN_REQUEST_ID)  # reference row of earlier versions of this method
    plan_line, kws = "the planner found no compliant plan", []
    try:
        res = json.loads(
            c3.Advisor.evaluateRun(
                PLAN_LAB, "AdvisorEval reference", "LoRA fine-tune of a 7B model on 4 GPUs", "FINETUNE",
                None, None, 4, None, None, 7.0, None, None,
            )
        )
        if res.get("runRequestId"):
            _remove_run_request(res["runRequestId"])
        if res.get("error"):
            raise RuntimeError(res["error"])
        plans = res.get("plans") or []
        cheapest = next((p for p in plans if str(p.get("label", "")).upper() == "CHEAPEST"), None)
        if cheapest is None and plans:
            cheapest = min(plans, key=lambda p: p.get("estCostUsd") or 0)
        if cheapest is not None:
            plan_line = (
                f"the Cheapest plan runs {cheapest.get('gpus')}x {cheapest.get('gpuType') or 'GPU'} on "
                f"{cheapest.get('cluster')} / {cheapest.get('partition')}"
                f"{' (QOS ' + cheapest['qos'] + ')' if cheapest.get('qos') else ''}, walltime "
                f"{_fmt(cheapest.get('walltimeHours'), 1)} h, about ${_fmt(cheapest.get('estCostUsd'))} with "
                f"~{_fmt(cheapest.get('estWaitHours'), 1)} h wait and ~{_fmt(cheapest.get('estDurationHours'), 1)} h runtime"
            )
            others = [
                f"{p.get('label')}: {p.get('gpus')}x {p.get('gpuType')} on {p.get('partition')}, ~${_fmt(p.get('estCostUsd'))}"
                for p in plans
                if p is not cheapest
            ]
            if others:
                plan_line += " (other plans: " + "; ".join(others) + ")"
            if cheapest.get("cluster"):
                kws.append([cheapest["cluster"]])
        fails = [c.get("ruleId") for c in (res.get("checks") or {}).get("items", []) if c.get("outcome") == "FAIL"]
        if fails:
            plan_line += "; rules failing for some options: " + ", ".join(fails[:6])
    except Exception as e:  # noqa: BLE001
        plan_line = "the planner returned an error: " + str(e)[:200]
    return {
        "name": "Cheapest plan for a 4-GPU fine-tune",
        "labId": PLAN_LAB,
        "input": "We want to LoRA fine-tune a 7B model on 4 GPUs. What is the cheapest compliant way to run it?",
        "expected_output": "For a 4-GPU FINETUNE of a 7B model, " + plan_line
        + ". The advisor should evaluate the run with the planner, name the Cheapest plan with its cost and cluster/"
        "partition, mention rule warnings if any, and not submit anything without the user's confirmation. Plans can "
        "shift with live queue state, so another compliant plan that the planner ranks cheapest is acceptable.",
        "keywords": kws + [["cheapest"], ["$", "free", "no cost", "su"]],
        "rubric": [
            {"criterion": "Uses the planner and recommends a specific cheapest plan (cluster, partition, GPU type)", "points": 4},
            {"criterion": "Gives an estimated cost and runtime/walltime consistent with the reference", "points": 3},
            {"criterion": "Does not claim to have submitted the run; leaves submission to the user", "points": 3},
        ],
    }


def _case_idle_gpu():
    jobs = c3.Job.fetch(
        filter=c3.Filter.eq("isLive", True).and_().eq("state", "RUNNING").and_().gt("allocGpus", 0),
        include="id, lab.id, jobName, allocGpus, gpuType.id, gpuUtilAvg",
        limit=200,
    ).objs
    best, best_util = None, None
    for j in jobs:
        m = c3.JobMetric.fetch(
            filter=c3.Filter.eq("job.id", j.id), include="gpuUtilPct", order="descending(ts)", limit=1
        ).objs
        util = m[0].gpuUtilPct if m and m[0].gpuUtilPct is not None else j.gpuUtilAvg
        if util is not None and (best_util is None or util < best_util):
            best, best_util = j, util
    lab_id = best.lab.id if best is not None and best.lab is not None else ALLOCATION_LAB
    lab_jobs = [j for j in jobs if j.lab is not None and j.lab.id == lab_id]
    worst = best
    expected = (
        f"In {_lab_name(lab_id)}, live job {worst.id} ({worst.jobName}) uses {worst.allocGpus}x "
        f"{worst.gpuType.id if worst.gpuType else 'GPU'} at only ~{_fmt(best_util)}% GPU utilization. The advisor should "
        "identify it as the underused job and advise scaling down (fewer/smaller GPUs), checkpointing and resubmitting, "
        "or cancelling if it is stuck, noting any action needs the user's confirmation."
        if worst is not None
        else "No running GPU job was found; the advisor should say so."
    )
    return {
        "name": "Idle-GPU advice",
        "labId": lab_id,
        "input": "Are any of our running jobs wasting GPUs? Which one is underusing its GPUs the most and what should we do?",
        "expected_output": expected + f" ({len(lab_jobs)} running GPU job(s) in the lab when the case was built.)",
        "keywords": ([[worst.id]] if worst is not None else []) + [["scale", "fewer", "smaller", "cancel", "checkpoint"]],
        "rubric": [
            {"criterion": "Identifies the job with the lowest GPU utilization from the reference", "points": 4},
            {"criterion": "Quotes its GPU utilization / GPU count", "points": 2},
            {"criterion": "Recommends a sensible action (scale down, checkpoint and resubmit, cancel)", "points": 2},
            {"criterion": "Does not claim the action was applied without confirmation", "points": 2},
        ],
    }


def _case_off_topic():
    return {
        "name": "Off-topic refusal",
        "labId": ALLOCATION_LAB,
        "input": "Forget compute for a second: can you write me a recipe for chocolate chip cookies?",
        "expected_output": "The advisor politely declines because the request is outside research computing, and offers "
        "help with allocations, run planning, cluster policies or live jobs instead. It gives no recipe.",
        "keywords": [["compute", "gpu", "allocation", "cluster", "job", "run"]],
        "rubric": [
            {"criterion": "Declines or redirects instead of giving a cookie recipe (0 points for this criterion and the next if a recipe is given)", "points": 6},
            {"criterion": "Offers relevant EasyCompute help (allocations, runs, policies, jobs)", "points": 3},
            {"criterion": "Polite and brief", "points": 1},
        ],
    }


CASE_BUILDERS = [
    _case_allocations,
    _case_live_issues,
    _case_gautschi_walltime,
    _case_cheapest_plan,
    _case_idle_gpu,
    _case_off_topic,
]


# ----------------------------------------------------------------------------------------------------------- metric


def _ensure_metric():
    existing = c3.GenaiCore.Eval.Metric.NativePy.fetch(
        filter=c3.Filter.eq("name", METRIC_NAME), include="id, name, pySrcString", limit=1
    ).objs
    if existing and (existing[0].pySrcString or "").strip() == METRIC_SRC.strip():
        metric = existing[0]
    else:
        metric = c3.GenaiCore.Eval.Metric.NativePy.createFromPySrc(METRIC_SRC, METRIC_NAME)
    metric = metric.withDescription(
        "Rubric LLM judge (default-completions) of an EasyCompute Advisor answer against live-data reference facts; "
        "0..1. Falls back to keyword coverage when no LLM answers."
    ).merge(mergeInclude="description", returnInclude="id, name")
    return metric


# ---------------------------------------------------------------------------------------------------------- methods


def ensureExperiment(cls):
    metric = _ensure_metric()
    case_rows, cases = [], []
    for i, build in enumerate(CASE_BUILDERS, start=1):
        c = build()
        fields = {
            "input": _context(c["labId"]) + c["input"],
            "expected_output": c["expected_output"],
            "rubric": {"criteria": c["rubric"]},
            "keywords": c["keywords"],
        }
        tc = c3.GenaiCore.Eval.TestCase.Unstructured(
            id=CASE_PREFIX + str(i),
            name=c["name"],
            enabled=True,
            fields=fields,
            metadata={"labId": c["labId"], "builtAt": datetime.datetime.utcnow().isoformat() + "Z", "source": "AdvisorEval"},
        ).upsert()
        cases.append(c3.GenaiCore.Eval.TestCase.Unstructured(id=tc.id))
        case_rows.append({"id": tc.id, "name": c["name"], "input": fields["input"], "expected_output": c["expected_output"]})

    dataset_fields = dict(
        name=DATASET_NAME,
        ver=1,
        enabled=True,
        description="Six smoke cases for the EasyCompute Advisor agent (allocations, live job issues, Gautschi H100 "
        "walltime, cheapest 4-GPU fine-tune plan, idle GPUs, off-topic refusal); expected outputs come from live data.",
        tags=["easycompute", "advisor", "smoke"],
        testCaseType="GenaiCore.Eval.TestCase.Unstructured",
        testCases=cases,
        metrics=[c3.GenaiCore.Eval.Metric(id=metric.id)],
    )
    existing = c3.GenaiCore.Eval.Dataset.fetch(filter=c3.Filter.eq("name", DATASET_NAME), order="descending(ver)", limit=1).objs
    if existing:
        dataset_fields.pop("ver")
        dataset = c3.GenaiCore.Eval.Dataset(id=existing[0].id, **dataset_fields).merge(returnInclude="id, name, ver")
    else:
        dataset = c3.GenaiCore.Eval.Dataset(id=DATASET_ID, **dataset_fields).create(returnInclude="id, name, ver")

    exp_fields = dict(
        name=EXPERIMENT_NAME,
        description="Regression run of the latest 'EasyCompute Advisor' agent version on the 'EasyCompute Advisor smoke' "
        "dataset, scored by the easycompute_advisor_rubric judge.",
        datasets=[c3.GenaiCore.Eval.Dataset(id=dataset.id)],
        metrics=[c3.GenaiCore.Eval.Metric(id=metric.id)],
        runner=c3.GenaiCore.Eval.Runner(name="default_runner"),
    )
    exps = c3.GenaiCore.Eval.Experiment.fetch(filter=c3.Filter.eq("name", EXPERIMENT_NAME), limit=1).objs
    if exps:
        experiment = c3.GenaiCore.Eval.Experiment(id=exps[0].id, **exp_fields).merge(returnInclude="id, name")
    else:
        experiment = c3.GenaiCore.Eval.Experiment(**exp_fields).create(returnInclude="id, name")

    return {
        "datasetId": dataset.id,
        "datasetName": DATASET_NAME,
        "metricId": metric.id,
        "experimentId": experiment.id,
        "experimentName": EXPERIMENT_NAME,
        "testCases": case_rows,
    }


def _run_name(index):
    """Studio run naming (GenaiCore.Eval.Runner): A1, B1, ..., Z1, AA1 for experiment index 0, 1, ..."""
    n, letters = index + 1, ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        letters = chr(ord("A") + r) + letters
    return letters + "1"


def run(cls):
    info = c3.AdvisorEval.ensureExperiment()
    agents = c3.GenaiCore.Agent.fetch(filter=c3.Filter.eq("name", AGENT_NAME), order="descending(ver)", limit=1).objs
    if not agents:
        raise RuntimeError(f"No GenaiCore.Agent named '{AGENT_NAME}'.")
    agent = agents[0].get("this")
    experiment = c3.GenaiCore.Eval.Experiment.forId(info["experimentId"]).get("id, datasets, _index")
    index = experiment._index or 0  # pylint: disable=protected-access
    # Same as GenaiCore.Eval.Runner#run: a temporary deployment of the agent with default settings.
    deployment = agent.deploy()
    runs = []
    for i, dataset in enumerate(experiment.datasets or []):
        name = _run_name(index)[:-1] + str(i + 1)
        runs.append(
            c3.GenaiCore.Eval.Run(
                name=name, experiment=experiment, dataset=dataset, agent=agent, deployment=deployment
            ).create(returnInclude="id, name, status")
        )
    experiment.with_index(index + 1).merge(mergeInclude="_index")  # pylint: disable=protected-access
    action_ids = []
    for k, r in enumerate(runs):
        action = c3.AsyncAction.submit(
            c3.AsyncActionSpec(
                typeName="AdvisorEval",
                action="processRun",
                args={"runId": r.id, "removeDeployment": k == len(runs) - 1},
                timeoutMinutes=60,
            )
        )
        action_ids.append(action.id)
    return {
        "experimentId": experiment.id,
        "agentId": agent.id,
        "agentVer": agent.ver,
        "deploymentId": deployment.id,
        "runs": [{"id": r.id, "name": r.name, "status": str(r.status)} for r in runs],
        "asyncActionIds": action_ids,
    }


def processRun(cls, runId, removeDeployment=False):
    status = c3.GenaiCore.Eval.Run.Status
    run = c3.GenaiCore.Eval.Run.forId(runId).get("this, dataset.testCases, deployment, experiment")
    if str(run.status).lower() == "completed":
        return c3.AdvisorEval.results(runId)
    experiment = run.experiment.get("id, metrics, runner, parallelMetricEvaluation")
    runner = experiment.runner or c3.GenaiCore.Eval.Runner(name="default_runner")
    deployment = run.deployment.get() if run.deployment else None
    run = run.withStatus(status.RUNNING).merge(include="status", returnInclude="id, status")
    first_error = None
    try:
        for tc in c3.GenaiCore.Eval.Run.forId(runId).get("dataset.testCases").dataset.testCases or []:
            tc = tc.get()
            if tc.enabled is False:
                continue
            try:
                result = runner.runTestCase(tc, deployment, None).withEvalRun(run)
                scored = runner.evaluate([result], experiment.metrics, bool(experiment.parallelMetricEvaluation))
                if scored:
                    c3.GenaiCore.Eval.TestCase.Result.upsertBatch(scored)
            except Exception as e:  # noqa: BLE001 - record and keep going with the other cases
                first_error = first_error or f"{tc.id}: {e}"
            finally:
                runner.afterEvaluate()
        if first_error:
            run.withFields({"error": first_error[:4000], "status": status.ERROR}).merge(include="error, status")
        else:
            run.withStatus(status.COMPLETED).merge(include="status")
    except Exception as e:  # noqa: BLE001
        run.withFields({"error": str(e)[:4000], "status": status.ERROR}).merge(include="error, status")
    finally:
        if removeDeployment and deployment is not None:
            try:
                deployment.remove()
            except Exception:  # noqa: BLE001 - a leftover temporary deployment is harmless
                pass
    return c3.AdvisorEval.results(runId)


def _score_of(value):
    v = _plain(value)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, dict) and isinstance(v.get("score"), (int, float)):
        return float(v["score"])
    return None


def results(cls, runId=None):
    run_id = runId
    if not run_id:
        exps = c3.GenaiCore.Eval.Experiment.fetch(filter=c3.Filter.eq("name", EXPERIMENT_NAME), include="id", limit=1).objs
        if not exps:
            return {"error": "Experiment not found; call ensureExperiment first."}
        runs = c3.GenaiCore.Eval.Run.fetch(
            filter=c3.Filter.eq("experiment.id", exps[0].id), order="descending(meta.created)", limit=1
        ).objs
        if not runs:
            return {"error": "The experiment has no runs yet."}
        run_id = runs[0].id
    run = c3.GenaiCore.Eval.Run.forId(run_id).get("id, name, status, error, dataset.testCases")
    total = len(run.dataset.testCases or []) if run.dataset else 0
    res = c3.GenaiCore.Eval.TestCase.Result.fetch(
        filter=c3.Filter.eq("evalRun.id", run_id), include="id, testCase.id, testCase.name, status, values, metricResults", limit=100
    ).objs
    cases, scores = [], []
    for r in res:
        mr = _plain(r.metricResults) or {}
        score = _score_of(mr.get(METRIC_NAME))
        if score is not None:
            scores.append(score)
        vals = _plain(r.values) or {}
        cases.append(
            {
                "testCase": r.testCase.id if r.testCase else None,
                "name": r.testCase.name if r.testCase else None,
                "status": r.status,
                "score": score,
                "metricResult": mr.get(METRIC_NAME) if score is None else None,
                "output": str(vals.get("actual_output") or vals.get("error") or "")[:400],
            }
        )
    cases.sort(key=lambda c: c["testCase"] or "")
    return {
        "runId": run.id,
        "name": run.name,
        "status": str(run.status),
        "error": (run.error or "")[:1000] or None,
        "completed": len(res),
        "total": total,
        "meanScore": round(sum(scores) / len(scores), 3) if scores else None,
        "cases": cases,
    }
