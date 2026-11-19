#
# Implementation of GuardrailWorkflow (runtime claim py-workflows → py.3.12-workflows-server-py4j).
# Builds the "Run guardrail triage" agentic workflow from resource/workflows/run_guardrail_triage.json
# and executes it for JobAlerts.
#

import datetime
import json
import re

WF_ID = "run_guardrail_triage"
SPEC_URL = "meta://easycompute/resource/workflows/run_guardrail_triage.json"
INPUT_NODE = "alert_id_input"
MAX_PER_TICK = 3


def _log():
    return c3.Logger.for_("easycompute.GuardrailWorkflow")


def _spec():
    return json.loads(c3.File(url=SPEC_URL).readString())


def _find_workflow():
    objs = c3.Genai.Agent.Resource.Workflow.fetch(filter=c3.Filter.eq("id", WF_ID), limit=1, include="id").objs
    if not objs:
        return None
    return c3.Genai.Agent.Resource.Workflow.forId(WF_ID).get(include="this, workflowCore.this")


def _build_graph(spec):
    from workflows import Graph
    from workflows.components.node import NodeKind

    g = Graph()
    natives = [c3.Genai.Workflow.NodeTemplate.forName(t).toNative() for t in spec["templates"]]
    g.update_node_templates(natives, force_update=True)

    for field, typ in spec["state"].items():
        g.add_field_to_state(field, typ)

    for n in spec["nodes"]:
        cfg = dict(n.get("llm_config_values") or {})
        if n.get("code") is not None:
            code = n["code"]
            cfg["code"] = "\n".join(code) if isinstance(code, list) else code
        node = g.register_node_from_template(
            template_name=n["template"],
            node_name=n["name"],
            input_spec=n.get("input_spec"),
            output_spec=n.get("output_spec"),
            llm_config_values=cfg,
            description=n.get("description") or n["name"],
            force_update=True,
        )
        if n.get("init_kwargs"):
            kw = dict(node.init_kwargs or {})
            kw.update(n["init_kwargs"])
            node.init_kwargs = kw
            node.initialized = False
        if n.get("kind"):
            g.get_node(n["name"]).kind = NodeKind(n["kind"])

    for n in spec["nodes"]:
        for k in (n.get("input_spec") or {}):
            g.add_input_mapping(state_field=k, target_node=n["name"], target_input=k, force_update=True)
        for k in (n.get("output_spec") or {}):
            g.add_output_mapping(source_node=n["name"], source_output=k, state_field=k, force_update=True)

    for src, dst in spec["edges"]:
        g.add_edge(source_node=src, target_node=dst, force_update=True)
    return g


def _diagnose(g):
    try:
        res = g.diagnose_graph_completeness(display_results=False)
    except Exception as e:  # report, do not hide
        return {"error": str(e)}
    if res is None:
        return None
    for attr in ("model_dump", "dict"):
        if hasattr(res, attr):
            try:
                return json.loads(json.dumps(getattr(res, attr)(), default=str))
            except Exception:
                pass
    return str(res)


def _is_clean(diag):
    if diag is None:
        return True
    if isinstance(diag, dict):
        if diag.get("error"):
            return False
        for key in ("is_complete", "complete", "is_valid", "valid"):
            if key in diag:
                return bool(diag[key])
        errs = diag.get("errors") or diag.get("issues")
        return not errs
    if isinstance(diag, (list, tuple)):
        return len(diag) == 0
    return True


def ensureWorkflow(cls):
    spec = _spec()
    wf = _find_workflow()
    created = wf is None
    if created:
        wf = c3.Genai.Agent.Resource.Workflow(id=WF_ID, name=spec["name"], description=spec.get("description"))
    elif wf.isPublished:
        wf = wf.setPublished(False)
        wf = wf.get(include="this, workflowCore.this")

    g = _build_graph(spec)
    diag = _diagnose(g)
    if not _is_clean(diag):
        raise RuntimeError("Workflow graph validation failed: " + json.dumps(diag, default=str)[:4000])

    wf = wf.updateNative(g)
    # updateNative can drop the name; restore name/description on the instance.
    wf = c3.Genai.Agent.Resource.Workflow.forId(WF_ID).get(include="this, workflowCore.this")
    wf.withField("name", spec["name"]).withField("description", spec.get("description")).merge()

    wf = c3.Genai.Agent.Resource.Workflow.forId(WF_ID).get(include="this, workflowCore.this")
    wf = wf.setPublished(True)
    wf = c3.Genai.Agent.Resource.Workflow.forId(WF_ID).get(include="this, workflowCore.this")
    wf = wf.compileWorkflow()
    final = c3.Genai.Agent.Resource.Workflow.forId(WF_ID).get(include="id, name, isPublished")
    _log().info("ensureWorkflow: %s workflow %s" % ("created" if created else "updated", WF_ID))
    return {
        "id": final.id,
        "name": final.name,
        "published": bool(final.isPublished),
        "created": created,
        "validation": diag,
    }


def _ready_workflow():
    wf = _find_workflow()
    if wf is None or not wf.isPublished:
        ensureWorkflow(None)
        wf = _find_workflow()
    return wf


def _to_jsonable(v):
    return json.loads(json.dumps(v, default=lambda o: o.isoformat() if hasattr(o, "isoformat") else str(o)))


def _new_execution(wf, alert_id):
    try:
        ex = c3.Genai.Agent.Resource.Workflow.createInitialExecution(wf, "workflow")
        if ex is not None and ex.id:
            return ex
    except Exception as e:
        _log().warn("createInitialExecution failed, creating execution directly: %s" % e)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    exid = "grt_" + re.sub(r"[^A-Za-z0-9_-]", "_", alert_id or "newest") + "_" + stamp
    return c3.Genai.WorkflowExecution(
        id=exid, name=exid, workflow=wf, createdAt=datetime.datetime.now(datetime.timezone.utc)
    ).upsert()


def triage(cls, alertId=None):
    alert_id = (alertId or "").strip()
    wf = _ready_workflow()
    ex = _new_execution(wf, alert_id)
    wf = wf.compileWorkflow()
    wf.executeWorkflow(workflowExecution=ex, input={})

    pend = wf.getPendingInterrupts(ex) or []
    for _ in range(3):
        if not pend:
            break
        responses = [
            c3.Genai.Workflow.ResumeResponse(
                interruptId=p.interruptId, payload={"input_type": "string", "input_value": alert_id}
            )
            for p in pend
        ]
        list(wf.resumeWorkflow(ex, responses) or [])
        pend = wf.getPendingInterrupts(ex) or []

    state = _to_jsonable(wf.getNativeExecutionStateValues(ex) or {})
    ex_now = c3.Genai.WorkflowExecution.forId(ex.id).get(include="id, status, errorMessage")
    status = str(ex_now.status) if ex_now and ex_now.status is not None else None

    result = state.get("triage_result") or {}
    gt_id = result.get("guardrailTriageId")
    if gt_id and result.get("workflowExecutionId") != ex.id:
        # The record node resolves the execution id by lookup; pin the exact id of this run.
        c3.GuardrailTriage(id=gt_id, workflowExecutionId=ex.id).merge()
        result["workflowExecutionId"] = ex.id
        state["triage_result"] = result

    return {
        "executionId": ex.id,
        "status": status,
        "errorMessage": ex_now.errorMessage if ex_now else None,
        "state": state,
    }


def triageNew(cls):
    alerts = c3.JobAlert.fetch(
        filter="status == 'OPEN'", order="descending(detectedAt)", limit=200, include="id"
    ).objs or []
    ids = [a.id for a in alerts]
    if not ids:
        return 0
    triaged = set()
    for i in range(0, len(ids), 100):
        chunk = ids[i:i + 100]
        for t in c3.GuardrailTriage.fetch(filter="intersects(id, %s)" % json.dumps(chunk), limit=-1, include="id").objs or []:
            triaged.add(t.id)
    todo = [i for i in ids if i not in triaged][:MAX_PER_TICK]

    count = 0
    for aid in todo:
        try:
            res = triage(cls, aid)
            if (res.get("state") or {}).get("triage_result"):
                count += 1
            else:
                _log().warn("triageNew: no triage_result for %s (%s)" % (aid, res.get("errorMessage")))
        except Exception as e:
            _log().error("triageNew: triage of %s failed: %s" % (aid, e))
    return count
