import { useCallback, useLayoutEffect, useState } from 'react';
import { readAppearance, writeAppearance, type Appearance } from '../lib/appearance';

/** Display-only, independent of the native light/dark preference and document state. */
export function useAppearance() {
  const [appearance, setAppearance] = useState(readAppearance);

  useLayoutEffect(() => {
    document.documentElement.dataset.appearance = appearance;
  }, [appearance]);

  const changeAppearance = useCallback((value: Appearance) => {
    setAppearance(value);
    writeAppearance(value);
  }, []);

  return { appearance, changeAppearance };
}
