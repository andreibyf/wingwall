export function WingwallLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-label="Wingwall"
      role="img"
    >
      {/* Two wings (butterfly fly structure) meeting at a central wall */}
      <path d="M16 6L4 12L16 18L4 24" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 6L28 12L16 18L28 24" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="16" y1="4" x2="16" y2="28" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
    </svg>
  );
}
