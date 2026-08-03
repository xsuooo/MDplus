import type { SVGProps } from 'react';

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

/** Markdown document mark used consistently in the welcome view and toolbar. */
export const IconBrand = (p: IconProps) => (
  <svg {...base(p.size, p)} viewBox="0 0 32 32" strokeWidth={1.8}>
    <path
      className="brand-icon-page"
      d="M8 3.5h10.1L24.5 9.9V25A3.5 3.5 0 0 1 21 28.5H8A3.5 3.5 0 0 1 4.5 25V7A3.5 3.5 0 0 1 8 3.5Z"
    />
    <path d="M18 3.8v6.1h6.1" />
    <path d="m11.2 13.8-1.1 6.4M16 13.8l-1.1 6.4M10.4 16.5h7.3M9.9 19.2h7.3" strokeWidth={1.7} />
    <path className="brand-icon-plus" d="M23.2 20.7v5.2M20.6 23.3h5.2" strokeWidth={2.05} />
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
