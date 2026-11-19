/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import React from 'react';
import { Navigate } from 'react-router-dom';

import { ErrorState, LoadingState, PageFrame } from '@/components/app';
import { fetchLiveJobs, fetchOpenAlerts } from '@/features/lab/api';
import { useCurrentLab } from '@/features/lab/useCurrentLab';
import { useLoad } from '@/features/lab/useLoad';

const RANK: Record<string, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 };

/** "Live monitor" nav entry: opens the live run that most needs attention (critical alerts first), else the runs list. */
const LiveMonitor: React.FC = () => {
  const { labId, error: labError } = useCurrentLab();
  const data = useLoad(() => (labId ? Promise.all([fetchLiveJobs(labId), fetchOpenAlerts(labId)]) : null), [labId]);

  if (labError || data.error) {
    return (
      <PageFrame title="Live monitor">
        <ErrorState message={`Could not load live runs: ${labError ?? data.error}`} onRetry={data.reload} />
      </PageFrame>
    );
  }
  if (!data.data) {
    return (
      <PageFrame title="Live monitor">
        <LoadingState label="Finding the run that needs you most…" />
      </PageFrame>
    );
  }
  const [jobs, alerts] = data.data;
  const running = jobs.filter((j) => j.state === 'RUNNING');
  const score = (id: string) => Math.min(9, ...alerts.filter((a) => a.job?.id === id).map((a) => RANK[a.severity] ?? 9));
  const pick = [...running].sort((a, b) => score(a.id) - score(b.id) || (b.allocGpus ?? 0) - (a.allocGpus ?? 0))[0];
  return <Navigate to={pick ? `/runs/${encodeURIComponent(pick.id)}` : '/runs?view=running'} replace />;
};

export default LiveMonitor;
