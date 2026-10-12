import type { SVGProps } from 'react';
import appIconUrl from '../assets/app-icon.svg';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(size: number | undefined, props: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size ?? 18,
    height: size ?? 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    ...props,
  };
}

/** Shares the exact artwork used by the desktop icon and browser favicon. */
export const IconBrand = (p: IconProps) => (
  <svg {...base(p.size, p)} viewBox="0 0 32 32" fill="none" stroke="none">
    <image href={appIconUrl} width="32" height="32" />
  </svg>
);

export const IconOpen = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="M4 19.5A2.5 2.5 0 0 1 1.5 17V7a2.5 2.5 0 0 1 2.5-2.5h4l2 2.5h8.5A2.5 2.5 0 0 1 21 9.5v7.5a2.5 2.5 0 0 1-2.5 2.5Z" />
    <path d="M8 13.5h6" />
  </svg>
);

export const IconNew = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="M12 3v9" />
    <path d="M7.5 7.5h-1a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-8a3 3 0 0 0-3-3h-1" />
    <path d="M12 12v9" />
  </svg>
);

export const IconSave = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="M4 3h13l3 3v15H4Z" />
    <path d="M8 3v5h8V3" />
    <path d="M8 21v-6h8v6" />
  </svg>
);

export const IconSaveAs = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="M4 3h13l3 3v15H4Z" />
    <path d="M8 3v5h8V3" />
    <path d="M8 21v-6h8v6" />
    <path d="M18 10v5M15.5 12.5H20.5" />
  </svg>
);

export const IconSearch = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconOutline = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="M3 6h5" />
    <path d="M3 12h5" />
    <path d="M3 18h5" />
    <path d="M10 6.5h11" />
    <path d="M10 12.5h11" />
    <path d="M10 18.5h11" />
  </svg>
);

export const IconCode = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="m8 7-5 5 5 5" />
    <path d="m16 7 5 5-5 5" />
    <path d="M13.5 4 10.5 20" />
  </svg>
);

export const IconSun = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
  </svg>
);

export const IconMoon = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />
  </svg>
);

export const IconMonitor = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);

export const IconClose = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconMinimize = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="M5 12h14" />
  </svg>
);

export const IconMaximize = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="1" />
  </svg>
);

export const IconClock = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const IconChevronUp = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="m6 14 6-6 6 6" />
  </svg>
);

export const IconChevronDown = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="m6 10 6 6 6-6" />
  </svg>
);

export const IconExport = (p: IconProps) => (
  <svg {...base(p.size, p)}>
    <path d="M12 3v12" />
    <path d="m8 11 4-4 4 4" />
    <path d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" />
  </svg>
);
