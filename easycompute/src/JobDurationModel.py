"""
JobDurationModel: native C3 ML job-duration model (Feature.Set -> MlPipeline -> MlModel -> MlModel.Route).

Heavy imports (numpy, sklearn) are done inside the methods; both methods run in the py-sklearn_312 runtime.
"""

import datetime
import hashlib

PROJECT_ID = 'job-duration'
PROJECT_NAME = 'Job Duration'
X_FS_NAME = 'durationInputs'
Y_FS_NAME = 'durationLabel'
X_FS_ID = 'Job#' + X_FS_NAME
Y_FS_ID = 'Job#' + Y_FS_NAME
TRAIN_FILTER = "isLive == false && (state == 'COMPLETED' || state == 'TIMEOUT') && elapsedHours > 0"
LIVE_FILTER = 'isLive == true'
MAT_HORIZON_DAYS = 4 * 365

CAT_COLS = ['workloadType', 'clusterId', 'partitionId', 'gpuTypeId', 'labId']
NUM_COLS = ['allocGpus', 'allocNodes', 'allocCpus', 'reqMemGb', 'timelimitHours']

X_COLUMNS = {
    'subject': 'string',
    'workloadType': 'string',
    'clusterId': 'string',
    'partitionId': 'string',
    'gpuTypeId': 'string',
    'allocGpus': 'int',
    'allocNodes': 'int',
    'allocCpus': 'int',
    'reqMemGb': 'double',
    'timelimitHours': 'double',
    'labId': 'string',
}

Y_COLUMNS = {
    'subject': 'string',
    'elapsedHours': 'double',
}

# Feature Set lambdas (Lambda.fromPySrc needs a single lambda expression). Missing references map to 'NONE'.
X_SRC = """lambda subjects, spec, fs: (lambda pd, ids: c3.Feature.CustomMaterializationResult(
    data=pd.DataFrame(
        [{
            'subject': j.id,
            'workloadType': j.workloadType or 'UNKNOWN',
            'clusterId': j.cluster.id if j.cluster else 'NONE',
            'partitionId': j.partition.id if j.partition else 'NONE',
            'gpuTypeId': j.gpuType.id if j.gpuType else 'NONE',
            'allocGpus': int(j.allocGpus or 0),
            'allocNodes': int(j.allocNodes or 0),
            'allocCpus': int(j.allocCpus or 0),
            'reqMemGb': float(j.reqMemGb or 0.0),
            'timelimitHours': float(j.timelimitHours or 0.0),
            'labId': j.lab.id if j.lab else 'NONE',
        } for j in (c3.Job.fetch({
            'filter': c3.Filter.intersects('id', ids),
            'include': 'id, workloadType, cluster.id, partition.id, gpuType.id, allocGpus, allocNodes, allocCpus, reqMemGb, timelimitHours, lab.id',
            'order': 'id',
            'limit': -1,
        }).objs or []) if ids],
        columns=['subject', 'workloadType', 'clusterId', 'partitionId', 'gpuTypeId', 'allocGpus', 'allocNodes',
                 'allocCpus', 'reqMemGb', 'timelimitHours', 'labId']),
    timeRangeIgnored=True))(__import__('pandas'), [s.id for s in subjects])"""

Y_SRC = """lambda subjects, spec, fs: (lambda pd, ids: c3.Feature.CustomMaterializationResult(
    data=pd.DataFrame(
        [{'subject': j.id, 'elapsedHours': float(j.elapsedHours or 0.0)}
         for j in (c3.Job.fetch({
             'filter': c3.Filter.intersects('id', ids),
             'include': 'id, elapsedHours',
             'order': 'id',
             'limit': -1,
         }).objs or []) if ids],
        columns=['subject', 'elapsedHours']),
    timeRangeIgnored=True))(__import__('pandas'), [s.id for s in subjects])"""

# Metric-backed run-telemetry Features on Job (metadata/SimpleMetric/Job_Telemetry*.json). They are catalogued in the
# Feature Store (Feature.Overview lists metric-backed Features) but are NOT model inputs: only live jobs have JobMetric
# samples, so they cannot be used to train on finished history.
TELEMETRY_FEATURES = {
    'telemetryGpuUtilPct': ('Job_TelemetryGpuUtilPct', 'Average GPU utilization (%) over JobMetric samples'),
    'telemetryGpuMemPct': ('Job_TelemetryGpuMemPct', 'Average GPU memory used (%) over JobMetric samples'),
    'telemetryCpuUtilPct': ('Job_TelemetryCpuUtilPct', 'Average CPU utilization (%) over JobMetric samples'),
    'telemetryMemPct': ('Job_TelemetryMemPct', 'Average host memory used (%) over JobMetric samples'),
}

HYPERPARAMS = {
    'n_estimators': 300,
    'learning_rate': 0.05,
    'max_depth': 3,
    'subsample': 0.9,
    'random_state': 0,
}


def _now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def _info(msg):
    c3.Logger.for_('easycompute.JobDurationModel').info(msg)


def _ensure_feature_sets():
    """Upserts both Lambda Feature Sets and returns them with srcBatch and columns loaded."""
    c3.Feature.Set.make({
        'id': X_FS_ID,
        'name': X_FS_NAME,
        'subjectType': c3.Job,
        'description': 'Job-duration model inputs: workload type, cluster, partition, GPU type, lab, allocated '
                       'GPUs/nodes/CPUs, requested memory (GB) and walltime limit (hours).',
        'columns': X_COLUMNS,
        'srcBatch': c3.Lambda.fromPySrc(X_SRC),
    }).upsert()
    c3.Feature.Set.make({
        'id': Y_FS_ID,
        'name': Y_FS_NAME,
        'subjectType': c3.Job,
        'description': 'Job-duration model label: elapsed run time in hours of finished jobs.',
        'columns': Y_COLUMNS,
        'srcBatch': c3.Lambda.fromPySrc(Y_SRC),
    }).upsert()
    inc = 'this, srcBatch, columns'
    xfs = c3.Feature.Set.forName(subjectType=c3.Job, name=X_FS_NAME, include=inc, failIfMissing=True)
    yfs = c3.Feature.Set.forName(subjectType=c3.Job, name=Y_FS_NAME, include=inc, failIfMissing=True)
    return xfs, yfs


def _ensure_telemetry_features():
    """Upserts the metric-backed telemetry Features; returns their ids."""
    ids = []
    for name, (metric_id, summary) in TELEMETRY_FEATURES.items():
        metric = c3.SimpleMetric.forId(metric_id)
        if metric is None:
            continue
        if c3.Feature.forId('Job#' + name) is None:
            c3.Feature.fromMetric(subjectType=c3.Job, legacy=c3.LegacyMetric(metric=metric, interval='HOUR'),
                                  name=name).withSummary(summary).withDescription(
                summary + '. Run telemetry; not a job-duration model input.').upsert()
        ids.append('Job#' + name)
    return ids


def _materialize(fs, subject_filter):
    # The range must sit inside the Feature Store time horizon (now - 5y .. now); the lambdas ignore it.
    now = _now()
    start = now - datetime.timedelta(days=MAT_HORIZON_DAYS)
    end = now - datetime.timedelta(minutes=1)
    fs.materialize(spec=c3.Feature.MaterializationSpec(filter=subject_filter, start=start, end=end, sync=True))


def _ensure_project():
    proj = c3.MlProject.forId(PROJECT_ID)
    if proj is None:
        router = c3.MlModel.RuleRouter.fromSubjectType(c3.Job).upsert()
        proj = c3.MlProject(id=PROJECT_ID, name=PROJECT_NAME, subjectType=c3.Job, router=router).upsert()
    return c3.MlProject.forId(PROJECT_ID)


def _split(ids):
    """Deterministic 80/20 split: sort by md5(id), first 80% train."""
    ordered = sorted(ids, key=lambda i: hashlib.md5(i.encode('utf-8')).hexdigest())
    cut = int(round(len(ordered) * 0.8))
    return ordered[:cut], ordered[cut:]


def _author_pipeline():
    import numpy as np
    from sklearn.compose import ColumnTransformer, TransformedTargetRegressor
    from sklearn.ensemble import GradientBoostingRegressor
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder

    prep = ColumnTransformer(
        [('cat', OneHotEncoder(handle_unknown='ignore', sparse_output=False), CAT_COLS),
         ('num', 'passthrough', NUM_COLS)],
        remainder='drop')
    est = TransformedTargetRegressor(
        regressor=Pipeline([('prep', prep), ('gbr', GradientBoostingRegressor(**HYPERPARAMS))]),
        func=np.log1p, inverse_func=np.expm1)
    mla = c3.MlPipeline.Authoring
    pipe = mla.convert(est, spec=c3.SklearnLikeConvertSpec(name='JobDurationGbr', processFunc='predict'))
    x = mla.var()
    y = mla.var()
    pred = pipe(x, y)
    return mla.pipeline(x={'features': x}, y={'target': y}, out={'prediction': pred})


def _to_pandas(data):
    if data is None:
        return None
    if hasattr(data, 'to_pandas'):
        return data.to_pandas()
    return data


def _predictions_by_subject(output, subject_ids):
    """Maps model.process output to {subjectId: predictedHours}."""
    try:
        data = output['prediction']
    except Exception:
        data = getattr(output, 'prediction', None)
    df = _to_pandas(data)
    try:
        if 'subject' in list(df.columns):
            keys = [str(v) for v in df['subject']]
            df = df.drop(columns=['subject'])
        elif df.index.dtype == object:
            keys = [str(v) for v in df.index]
        else:
            keys = list(subject_ids)
        values = [float(v) for v in df.iloc[:, 0].tolist()]
    except Exception as e:
        raise Exception('Unexpected process output %s / %s: %s' % (type(output), repr(df)[:800], e))
    if len(values) != len(keys):
        raise Exception('Process output has %d rows for %d subjects' % (len(values), len(keys)))
    return dict(zip(keys, values))


def _metrics(y_true, y_pred):
    from sklearn.metrics import mean_absolute_error, median_absolute_error, r2_score
    return {
        'maeHours': float(mean_absolute_error(y_true, y_pred)),
        'medianAeHours': float(median_absolute_error(y_true, y_pred)),
        'r2': float(r2_score(y_true, y_pred)),
    }


def train(cls):
    started = _now()
    run_id = 'jdm-' + started.strftime('%Y%m%dT%H%M%S')
    run = c3.JobDurationModel.Run(id=run_id, projectId=PROJECT_ID, status='RUNNING', trainedAt=started)
    try:
        xfs, yfs = _ensure_feature_sets()
        telemetry_ids = _ensure_telemetry_features()
        hist = c3.Job.fetch({'filter': TRAIN_FILTER, 'include': 'id, workloadType, elapsedHours', 'limit': -1}).objs or []
        rows = {j.id: (j.workloadType or 'UNKNOWN', float(j.elapsedHours)) for j in hist}
        train_ids, test_ids = _split(list(rows.keys()))
        _info('JobDurationModel.train: %d eligible, %d train, %d test' % (len(rows), len(train_ids), len(test_ids)))

        _materialize(xfs, '(' + TRAIN_FILTER + ') || ' + LIVE_FILTER)
        _materialize(yfs, TRAIN_FILTER)

        proj = _ensure_project()
        # MlModel is create-only: train() returns a NEW trained MlModel; the untrained template is removed after.
        template_id = 'job-duration-template-' + started.strftime('%Y%m%d%H%M%S')
        template = c3.MlModel(id=template_id, name='Job Duration GBR ' + started.strftime('%Y-%m-%d %H:%M'),
                              pipeline=_author_pipeline(), project=proj,
                              xFeatures={'features': xfs}, yFeatures={'target': yfs}).create()
        model = template.train(subjects=[c3.Job(id=i) for i in train_ids]).result()
        model_id = model.id
        model = c3.MlModel.forId(model_id)
        try:
            c3.MlModel.forId(template_id).remove()
        except Exception as e:  # keep going; the template is harmless
            _info('JobDurationModel.train: could not remove template %s: %s' % (template_id, e))

        out = model.process(subjects=[c3.Job(id=i) for i in test_ids]).result()
        preds = _predictions_by_subject(out, test_ids)
        y_true = [rows[i][1] for i in test_ids]
        y_pred = [max(0.0, preds[i]) for i in test_ids]
        model_metrics = _metrics(y_true, y_pred)

        # Baseline: training-set median elapsed hours per workload type (global median for unseen types).
        import numpy as np
        by_wt = {}
        for i in train_ids:
            by_wt.setdefault(rows[i][0], []).append(rows[i][1])
        medians = {k: float(np.median(v)) for k, v in by_wt.items()}
        global_median = float(np.median([rows[i][1] for i in train_ids]))
        base_pred = [medians.get(rows[i][0], global_median) for i in test_ids]
        base_metrics = _metrics(y_true, base_pred)

        # Deploy, retire every other active route in the project (only one CHAMPION may cover a subject filter),
        # then promote the new route to CHAMPION.
        route = model.deploy(c3.MlModel.DeploySpec(subjectFilter='true'))
        retired = 0
        others = c3.MlModel.Route.fetch({'filter': "project.id == '%s' && isActive == true && id != '%s'"
                                                   % (PROJECT_ID, route.id), 'limit': -1}).objs or []
        for r in others:
            r.updateStatus('RETIRED')
            retired += 1
        route.updateStatus('CHAMPION')
        route = c3.MlModel.Route.forId(route.id)

        run = run.withFields({
            'modelId': model_id,
            'routeId': route.id,
            'routeStatus': route.status.label if route.status else None,
            'retiredRoutes': retired,
            'status': 'SUCCEEDED',
            'trainedAt': _now(),
            'eligibleCount': len(rows),
            'trainCount': len(train_ids),
            'testCount': len(test_ids),
            'maeHours': model_metrics['maeHours'],
            'r2': model_metrics['r2'],
            'baselineMaeHours': base_metrics['maeHours'],
            'baselineR2': base_metrics['r2'],
            'metrics': {
                'model': model_metrics,
                'baseline': base_metrics,
                'baselineMedianHoursByWorkloadType': medians,
                'holdoutMeanHours': float(np.mean(y_true)),
                'split': 'sorted by md5(job id); first 80% train, last 20% holdout',
                'trainFilter': TRAIN_FILTER,
                'target': 'log1p(elapsedHours) via TransformedTargetRegressor',
                'estimator': 'OneHotEncoder + GradientBoostingRegressor',
                'hyperparams': HYPERPARAMS,
                'featureSets': [X_FS_ID, Y_FS_ID],
                'telemetryFeatures': telemetry_ids,
            },
        })
    except Exception as e:
        run = run.withFields({'status': 'FAILED', 'message': str(e)[:4000], 'trainedAt': _now()})
        run.upsert()
        raise
    run.upsert()
    return c3.JobDurationModel.Run.forId(run_id)


def _champion_model_id():
    routes = c3.MlModel.Route.fetch({'filter': "project.id == '%s' && isActive == true" % PROJECT_ID,
                                     'include': 'id, model.id, status, statusHistory', 'limit': -1}).objs or []
    champs = [r for r in routes if r.status and r.status.label == 'CHAMPION']
    if not champs:
        return None
    champs.sort(key=lambda r: r.model.id, reverse=True)
    return champs[0].model.id


def scoreLive(cls):
    model_id = _champion_model_id()
    if model_id is None:
        raise Exception('No CHAMPION route in MlProject %s; run JobDurationModel.train() first.' % PROJECT_ID)
    model = c3.MlModel.forId(model_id)
    live = c3.Job.fetch({'filter': LIVE_FILTER, 'include': 'id, timelimitHours', 'limit': -1}).objs or []
    live_ids = [j.id for j in live]
    now = _now()
    written = 0
    if live_ids:
        xfs = c3.Feature.Set.forName(subjectType=c3.Job, name=X_FS_NAME, include='this, srcBatch, columns',
                                     failIfMissing=True)
        _materialize(xfs, LIVE_FILTER)
        out = model.process(subjects=[c3.Job(id=i) for i in live_ids]).result()
        preds = _predictions_by_subject(out, live_ids)
        objs = []
        for j in live:
            if j.id not in preds:
                continue
            hours = max(0.0, preds[j.id])
            limit = float(j.timelimitHours) if j.timelimitHours is not None else None
            objs.append(c3.JobPrediction(
                id=j.id, job=c3.Job(id=j.id), predictedHours=hours, timelimitHours=limit,
                walltimeRisk=bool(limit is not None and hours > limit), modelId=model_id, scoredAt=now))
        if objs:
            c3.JobPrediction.upsertBatch(objs)
        written = len(objs)

    existing = c3.JobPrediction.fetch({'include': 'id', 'limit': -1}).objs or []
    live_set = set(live_ids)
    stale = [p for p in existing if p.id not in live_set]
    if stale:
        c3.JobPrediction.removeBatch(stale)

    runs = c3.JobDurationModel.Run.fetch({'filter': "modelId == '%s'" % model_id, 'order': 'descending(trainedAt)',
                                          'limit': 1}).objs or []
    if runs:
        runs[0].withFields({'lastScoredAt': now, 'lastScoredCount': written}).merge()
    _info('JobDurationModel.scoreLive: %d predictions with %s' % (written, model_id))
    return written
