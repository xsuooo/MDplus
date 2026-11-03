import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const PresentContext = createContext(true);
export const useIsPresent = () => useContext(PresentContext);

/** Keep only the exit picture alive; focus and input follow the logical state. */
export function Presence({ present, children }: { present: boolean; children: ReactNode }) {
  const [retained, setRetained] = useState(present);
  const lastChildren = useRef(children);
  if (present) lastChildren.current = children;

  useLayoutEffect(() => {
    if (present) { setRetained(true); return; }
    if (!retained) { lastChildren.current = null; return; }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRetained(false);
      return;
    }
    const duration = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--motion-exit')) || 160;
    const timer = window.setTimeout(() => setRetained(false), duration);
    return () => window.clearTimeout(timer);
  }, [present, retained]);

  if (!present && !retained) return null;
  return (
    <PresentContext.Provider value={present}>
      <div className="presence" data-exiting={present ? undefined : ''}
        {...{ inert: present ? undefined : '' }} aria-hidden={present ? undefined : true}
        onClickCapture={(event) => { if (!present) { event.preventDefault(); event.stopPropagation(); } }}>
        {present ? children : lastChildren.current}
      </div>
    </PresentContext.Provider>
  );
}
