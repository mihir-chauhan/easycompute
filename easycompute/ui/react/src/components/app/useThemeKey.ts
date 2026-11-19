/*
 * EasyCompute design system — re-render on light/dark flips.
 * eCharts options embed resolved colours, so build them in `useMemo(..., [data, themeKey])`.
 */

import { useEffect, useState } from 'react';

/** Returns 'dark' | 'light' and changes when the `.dark` class on <html> flips. */
export function useThemeKey(): 'dark' | 'light' {
  const read = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const [key, setKey] = useState<'dark' | 'light'>(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setKey(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return key;
}
