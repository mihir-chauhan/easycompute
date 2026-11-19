/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import React, { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import ErrorReporterProvider from "./components/ErrorBoundary/ErrorBoundary";
import AppShell, {
  AppShellProvider,
  useAppShell,
  type ShellLab,
} from "./components/app/AppShell";
import { c3Call } from "./c3Action";
import { ADMIN_NAV, labNav } from "./config/navigation";
import { fetchLabs } from "./features/lab/api";
import { setCurrentLabId } from "./features/lab/useCurrentLab";
// <routes-imports> (generated from routes.*.json by the integrator)
import Home from './pages/Home/Home';
import LabHome from './pages/LabHome/LabHome';
import LabContext from './pages/LabContext/LabContext';
import AdminPolicies from './pages/AdminPolicies/AdminPolicies';
import PlanRun from './pages/PlanRun/PlanRun';
import RunList from './pages/Runs/RunList';
import RunDetail from './pages/Runs/RunDetail';
import LiveMonitor from './pages/Runs/LiveMonitor';
import History from './pages/History/History';
import Guardrails from './pages/Guardrails/Guardrails';
import AssistantPage from './pages/Assistant/AssistantPage';
import AdminOverview from './pages/AdminOverview/AdminOverview';
import AdminClusters from './pages/AdminClusters/AdminClusters';
import AdminClusterDetail from './pages/AdminClusters/AdminClusterDetail';
import AdminLabs from './pages/AdminLabs/AdminLabs';
import AdminData from './pages/AdminData/AdminData';
import AdminUsers from './pages/AdminUsers/AdminUsers';
import Projects from './pages/Projects/Projects';
// </routes-imports>

/** Mirrors the shell's current lab into the lab pages' `useCurrentLab` (features/lab), so both stay in step. */
function LabSync() {
  const { labId } = useAppShell();
  useEffect(() => {
    if (labId) setCurrentLabId(labId);
  }, [labId]);
  return null;
}

/** Number of the current lab's running live jobs, for the "Live monitor" badge. */
function useLiveCount(labId: string | null): number | undefined {
  const [count, setCount] = useState<number>();
  useEffect(() => {
    if (!labId) return undefined;
    let cancelled = false;
    c3Call("Job", "fetchCount", "Job", [
      {
        filter: `lab.id == "${labId}" && isLive == true && state == "RUNNING"`,
      },
    ])
      .then((n) => {
        if (!cancelled) setCount(Number(n) || 0);
      })
      .catch(() => {
        if (!cancelled) setCount(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [labId]);
  return count;
}

/** The shell with the nav for the current lab (inside the provider so it can read the lab). */
function Shell({ children }: { children: React.ReactNode }) {
  const { labId } = useAppShell();
  const liveCount = useLiveCount(labId);
  return (
    <AppShell labNav={labNav(liveCount)} adminNav={ADMIN_NAV}>
      {children}
    </AppShell>
  );
}

/**
 * Application shell: {@link AppShell} (top bar with the Lab view / Research Computing switch and the demo lab
 * switcher, section-aware side nav) wraps every route, so the chrome is present on every page.
 */
export default function App() {
  const [labs, setLabs] = useState<ShellLab[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchLabs()
      .then((rows) => {
        if (!cancelled) setLabs(rows);
      })
      .catch(() => {
        // Pages show their own load errors; the shell just has no lab switcher.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ErrorReporterProvider>
      <AppShellProvider labs={labs}>
        <LabSync />
        <Routes>
          {/* <bare-routes> */}
                <Route path="/" element={<Home />} />
          {/* </bare-routes> */}
          <Route
            path="*"
            element={
              <Shell>
                <Routes>
                  {/* <routes> */}
                <Route path="/dashboard" element={<LabHome />} />
                <Route path="/context" element={<LabContext />} />
                <Route path="/policies" element={<AdminPolicies />} />
                <Route path="/plan" element={<PlanRun />} />
                <Route path="/runs" element={<RunList />} />
                <Route path="/runs/:id" element={<RunDetail />} />
                <Route path="/monitor" element={<LiveMonitor />} />
                <Route path="/history" element={<History />} />
                <Route path="/guardrails" element={<Guardrails />} />
                <Route path="/assistant" element={<AssistantPage />} />
                <Route path="/admin" element={<AdminOverview />} />
                <Route path="/admin/clusters" element={<AdminClusters />} />
                <Route path="/admin/clusters/:id" element={<AdminClusterDetail />} />
                <Route path="/admin/policies" element={<AdminPolicies />} />
                <Route path="/admin/labs" element={<AdminLabs />} />
                <Route path="/admin/data" element={<AdminData />} />
                <Route path="/admin/users" element={<AdminUsers />} />
                <Route path="/members" element={<AdminUsers />} />
                <Route path="/projects" element={<Projects />} />
                {/* </routes> */}
                  <Route
                    path="*"
                    element={
                      <div className="flex h-full items-center justify-center p-8 text-center text-[var(--c3-style-basic-fg-neutral)]">
                        <p>Page not found.</p>
                      </div>
                    }
                  />
                </Routes>
              </Shell>
            }
          />
        </Routes>
      </AppShellProvider>
    </ErrorReporterProvider>
  );
}
