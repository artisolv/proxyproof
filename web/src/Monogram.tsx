/**
 * ProxyProof's mark: two check marks in a white circle, like a "delivered and read" double tick.
 * One tick per side of the payment. The deeper green is the paying agent's proof, the brighter green the
 * receiving agent's, the same two greens the landing page uses as each side is verified.
 * `ring` adds a hairline edge so the white circle still reads on white pages.
 * Animated: the first tick is drawn, then the second. With reduced motion both appear at once.
 */
// Tick two is drawn over tick one with a hairline white outline, just enough to separate them where they cross.
const TICK_1 = 'M13.75 29L20.75 36L34.25 20';
const TICK_2 = 'M25.35 32.6L28.75 36L42.25 20';

export function Monogram({ size = 32, animate = false, ring = false, title = 'ProxyProof' }: { size?: number; animate?: boolean; ring?: boolean; title?: string }) {
  return (
    <svg className={`pp-mark${animate ? ' animate' : ''}`} width={size} height={size} viewBox="0 0 56 56" {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
      <circle cx="28" cy="28" r={ring ? 27 : 28} fill="#fff" stroke={ring ? '#cfe3d9' : 'none'} strokeWidth="1.5" />
      <path className="t1" d={TICK_1} fill="none" stroke="#0e7a55" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
      <path className="t2" d={TICK_2} fill="none" stroke="#fff" strokeWidth="6.2" strokeLinecap="round" strokeLinejoin="round" />
      <path className="t2" d={TICK_2} fill="none" stroke="#2bc48a" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The logo lock-up used in every header: the mark and the name, set in the brand face. */
export function Wordmark({ size = 30, ring = false }: { size?: number; ring?: boolean }) {
  return (
    <span className="wordmark">
      <Monogram size={size} ring={ring} title="" />
      <span>ProxyProof</span>
    </span>
  );
}
