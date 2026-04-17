import { cn } from "@/lib/utils";

interface FounderOSLogoProps {
  /** Overall height in px. Width scales automatically from the viewBox. */
  size?: number;
  /** When true, renders only the mark (rounded square with F) without the wordmark. */
  markOnly?: boolean;
  className?: string;
  /** Override the mark background color (CSS color). Defaults to the brand token. */
  markColor?: string;
  /** Override the wordmark text color. Defaults to the foreground token. */
  textColor?: string;
}

/**
 * FounderOS primary brand lockup: rounded teal mark + "FounderOS" wordmark.
 * Uses design tokens so it re-themes automatically in light/dark mode.
 */
export function FounderOSLogo({
  size = 24,
  markOnly = false,
  className,
  markColor,
  textColor,
}: FounderOSLogoProps) {
  const markStyle = markColor
    ? { fill: markColor }
    : { fill: "var(--brand, oklch(0.5 0.07 193))" };
  const textStyle = textColor
    ? { fill: textColor }
    : { fill: "var(--foreground)" };
  const accentStyle = { fill: "color-mix(in oklch, var(--brand, #0d7377) 55%, transparent)" };

  if (markOnly) {
    return (
      <svg
        role="img"
        aria-label="FounderOS"
        viewBox="0 0 24 24"
        height={size}
        width={size}
        className={cn("shrink-0", className)}
      >
        <rect x="1" y="1" width="22" height="22" rx="5.5" style={markStyle} />
        <path
          d="M8 6 H16 A0.8 0.8 0 0 1 16 7.6 H9.6 V11 H14.4 A0.8 0.8 0 0 1 14.4 12.6 H9.6 V18 A0.8 0.8 0 0 1 8 18 Z"
          fill="var(--primary-foreground, #fff)"
        />
        <circle cx="17.5" cy="17.5" r="1.8" style={accentStyle} />
      </svg>
    );
  }

  const w = size * 7;
  return (
    <svg
      role="img"
      aria-label="FounderOS"
      viewBox="0 0 168 24"
      height={size}
      width={w / 1}
      className={cn("shrink-0", className)}
      style={{ width: "auto" }}
    >
      <rect x="0" y="0" width="24" height="24" rx="6" style={markStyle} />
      <path
        d="M7 6 H15 A0.8 0.8 0 0 1 15 7.6 H8.6 V11 H13.4 A0.8 0.8 0 0 1 13.4 12.6 H8.6 V18 A0.8 0.8 0 0 1 7 18 Z"
        fill="var(--primary-foreground, #fff)"
      />
      <circle cx="17.5" cy="17.5" r="1.8" style={accentStyle} />
      <text
        x="32"
        y="17.5"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif"
        fontSize="15"
        fontWeight="650"
        letterSpacing="-0.015em"
        style={textStyle}
      >
        FounderOS
      </text>
    </svg>
  );
}
