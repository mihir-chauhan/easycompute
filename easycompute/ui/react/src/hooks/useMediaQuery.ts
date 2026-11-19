/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 */

import { useEffect, useState } from 'react';

/** Phone layout: the side nav becomes a drawer opened from the top bar. */
export const PHONE_QUERY = '(max-width: 767px)';
/** Desktop layout: the full 256px side nav (below it the nav is a 48px icon rail). */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/** True while the CSS media query matches; follows viewport changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
