/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import React, { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import ErrorReporterProvider from './components/ErrorBoundary/ErrorBoundary';
import AppShell, { AppShellProvider, useAppShell, type ShellLab } from './components/app/AppShell';
import { ADMIN_NAV, LAB_NAV } from './config/navigation';
import { fetchLabs } from './features/lab/api';
import { setCurrentLabId } from './features/lab/useCurrentLab';
// <routes-imports> (generated from routes.*.json by the integrator)
import LabHome from './pages/LabHome/LabHome';
import LabContext from './pages/LabContext/LabContext';
import PlanRun from './pages/PlanRun/PlanRun';
import RunList from './pages/Runs/RunList';
import RunDetail from './pages/Runs/RunDetail';
import History from './pages/History/History';
import AssistantPage from './pages/Assistant/AssistantPage';
import AdminOverview from './pages/AdminOverview/AdminOverview';
import AdminClusters from './pages/AdminClusters/AdminClusters';
import AdminClusterDetail from './pages/AdminClusters/AdminClusterDetail';
import AdminPolicies from './pages/AdminPolicies/AdminPolicies';
import AdminLabs from './pages/AdminLabs/AdminLabs';
// </routes-imports>


/** Mirrors the shell's current lab into the lab pages' `useCurrentLab` (features/lab), so both stay in step. */
function LabSync() {
  const { labId } = useAppShell();
  useEffect(() => {
    if (labId) setCurrentLabId(labId);
  }, [labId]);
  return null;
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
        <AppShell labNav={LAB_NAV} adminNav={ADMIN_NAV}>
          <Routes>
            {/* <routes> */}
                <Route path="/" element={<LabHome />} />
                <Route path="/context" element={<LabContext />} />
                <Route path="/plan" element={<PlanRun />} />
                <Route path="/runs" element={<RunList />} />
                <Route path="/runs/:id" element={<RunDetail />} />
                <Route path="/history" element={<History />} />
                <Route path="/assistant" element={<AssistantPage />} />
                <Route path="/admin" element={<AdminOverview />} />
                <Route path="/admin/clusters" element={<AdminClusters />} />
                <Route path="/admin/clusters/:id" element={<AdminClusterDetail />} />
                <Route path="/admin/policies" element={<AdminPolicies />} />
                <Route path="/admin/labs" element={<AdminLabs />} />
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
        </AppShell>
      </AppShellProvider>
    </ErrorReporterProvider>
  );
}
