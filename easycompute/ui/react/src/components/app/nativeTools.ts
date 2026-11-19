/*
 * Deep links into C3 AI's native tools for this app (07-c3code-ui-workspace-tools.md):
 *   https://<host>/misc/studio/apps/<cluster>-<env>-<app>/<route>?shellTheme=dark
 * env/app come from the preview path (/<env>/<app>/uiservice/...) or the c3env/c3app cookies.
 */

import { getCookieValue } from '@/c3Action';

export type NativeTool = 'datafusion' | 'data-integration' | 'file-explorer' | 'lakehouse' | 'user-management' | 'user-management/groups';

export const NATIVE_TOOL_LABEL: Record<NativeTool, string> = {
  datafusion: 'Data Fusion',
  'data-integration': 'Data Monitoring',
  'file-explorer': 'File Explorer',
  lakehouse: 'Data Lakehouse',
  'user-management': 'User Management',
  'user-management/groups': 'User groups',
};

export function nativeToolUrl(tool: NativeTool): string {
  const { origin, hostname, pathname } = window.location;
  const parts = pathname.split('/').filter(Boolean);
  const ui = parts.indexOf('uiservice');
  const env = getCookieValue('c3env') ?? (ui >= 2 ? parts[ui - 2] : undefined) ?? 'gse5001867';
  const app = getCookieValue('c3app') ?? (ui >= 2 ? parts[ui - 1] : undefined) ?? 'liveapp';
  const cluster = hostname.split('.')[0] || 'accelerator';
  const host = hostname === 'localhost' || hostname === '127.0.0.1' ? 'https://accelerator.c3.ai' : origin;
  return `${host}/misc/studio/apps/${cluster === 'localhost' ? 'accelerator' : cluster}-${env}-${app}/${tool}?shellTheme=dark`;
}
