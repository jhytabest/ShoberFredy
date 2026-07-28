/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/*
 * Shoberfredy logo: an original shiba-inu head drawn as inline SVG, with an
 * optional wordmark. Inline SVG keeps the logo crisp at every size and lets
 * the wordmark inherit theme colors.
 */

const SHIBA_ORANGE = '#e78a2e';
const SHIBA_CREAM = '#f6e7d3';
const SHIBA_DARK = '#2b1d12';

/**
 * Shiba head mark.
 * @param {{size?: number}} props
 */
export function ShibaHead({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Shoberfredy">
      {/* ears */}
      <polygon points="14,38 22,6 46,26" fill={SHIBA_ORANGE} />
      <polygon points="86,38 78,6 54,26" fill={SHIBA_ORANGE} />
      <polygon points="20,32 25,14 39,26" fill={SHIBA_CREAM} />
      <polygon points="80,32 75,14 61,26" fill={SHIBA_CREAM} />
      {/* head */}
      <ellipse cx="50" cy="56" rx="38" ry="34" fill={SHIBA_ORANGE} />
      {/* cheek + muzzle cream */}
      <ellipse cx="50" cy="68" rx="26" ry="20" fill={SHIBA_CREAM} />
      <ellipse cx="24" cy="52" rx="9" ry="12" fill={SHIBA_CREAM} />
      <ellipse cx="76" cy="52" rx="9" ry="12" fill={SHIBA_CREAM} />
      {/* eyes */}
      <circle cx="36" cy="50" r="4.2" fill={SHIBA_DARK} />
      <circle cx="64" cy="50" r="4.2" fill={SHIBA_DARK} />
      <circle cx="37.4" cy="48.6" r="1.3" fill="#ffffff" />
      <circle cx="65.4" cy="48.6" r="1.3" fill="#ffffff" />
      {/* nose + mouth */}
      <path d="M45 62 Q50 58 55 62 Q50 68 45 62 Z" fill={SHIBA_DARK} />
      <path
        d="M50 66 L50 71 M50 71 Q45 77 40 73 M50 71 Q55 77 60 73"
        stroke={SHIBA_DARK}
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/**
 * Full logo: shiba head + "shoberfredy" wordmark.
 * @param {{width?: number, white?: boolean}} props
 */
export default function ShibaLogo({ width = 250, white = false } = {}) {
  const textColor = white ? '#ffffff' : SHIBA_DARK;
  // Head is ~13% of the total width; scale type with the container.
  const headSize = Math.round(width * 0.17);
  return (
    <span
      className="shibaLogo"
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(width * 0.035), width }}
    >
      <ShibaHead size={headSize} />
      <svg width={width - headSize} height={headSize} viewBox="0 0 300 52" role="img" aria-label="shoberfredy">
        <text
          x="0"
          y="38"
          fontFamily="'Outfit', system-ui, sans-serif"
          fontWeight="700"
          fontSize="40"
          letterSpacing="0.5"
          fill={textColor}
        >
          shober<tspan fill={SHIBA_ORANGE}>fredy</tspan>
        </text>
      </svg>
    </span>
  );
}
