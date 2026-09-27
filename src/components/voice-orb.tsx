"use client";

import { useId } from "react";

export function VoiceOrb() {
  const id = useId().replaceAll(":", "");
  const maskId = `call-mask-${id}`;
  const blurId = `call-blur-${id}`;

  return (
    <div className="call-loader" aria-hidden="true">
      <svg viewBox="0 0 120 120" focusable="false">
        <defs>
          <filter id={blurId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <filter
            id={`${id}-fluid`}
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur stdDeviation="6" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="12" intercept="-5.5" />
            </feComponentTransfer>
          </filter>
          <mask id={maskId}>
            <g
              className="call-loader-shapes"
              filter={`url(#${id}-fluid)`}
              fill="white"
            >
              <polygon points="60,8 88,36 70,68 36,53" />
              <polygon points="91,20 112,55 82,85 56,51" />
              <polygon points="101,64 93,102 57,110 55,71" />
              <polygon points="62,57 71,100 30,103 16,72" />
              <polygon points="21,24 56,31 58,69 11,66" />
              <polygon points="45,14 83,43 68,83 29,59" />
              <polygon points="46,41 84,42 90,79 48,92 25,62" />
            </g>
          </mask>
          <radialGradient id={`${id}-silver`} cx="32%" cy="23%" r="85%">
            <stop offset="0%" stopColor="#fff" />
            <stop offset="34%" stopColor="#d9dadd" />
            <stop offset="68%" stopColor="#696a70" />
            <stop offset="100%" stopColor="#17181c" />
          </radialGradient>
        </defs>
        <g mask={`url(#${maskId})`}>
          <rect width="120" height="120" fill={`url(#${id}-silver)`} />
          <ellipse
            className="call-loader-light"
            cx="37"
            cy="32"
            rx="35"
            ry="18"
            fill="white"
            filter={`url(#${blurId})`}
          />
        </g>
      </svg>
    </div>
  );
}
