/**
 * ProxyProof's own monogram: a dark green P and a light green mirrored P standing back to back, their
 * stems side by side in the middle and their bowls facing outward. A white check mark sits centred in the
 * top half of the light green P. Two sides of a payment, meeting at the proof.
 * Built from its own geometry; upright, mirrored and green so it cannot be mistaken for any payment
 * provider's mark.
 * Animated: the two Ps slide together from either side, then the check is drawn on the light P. With
 * reduced motion the finished mark is shown immediately.
 */
// One solid P: stem x 29..38, bowl out to x 52 (y 8..30, just over half the height), stem down to y 48.
// The dark P is the same path reflected about x = 28, leaving a 2-unit gap between the stems. The check
// is centred on the light P's bowl (x 29..52, y 8..30) with at least 2 units clear of every edge.
const P = 'M32 8H41A11 11 0 0 1 41 30H38V45a3 3 0 0 1-3 3H32a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3Z';
const CHECK = 'M34.5 19.5L38.5 23.5L46.5 14.5';

export function Monogram({ size = 32, animate = false, seal = true, title = 'ProxyProof' }: { size?: number; animate?: boolean; bg?: string; seal?: boolean; title?: string }) {
  return (
    <svg className={`pp-mark${animate ? ' animate' : ''}`} width={size} height={size} viewBox="0 0 56 56" role="img" aria-label={title}>
      <g className="p1"><path d={P} fill="#064e37" transform="matrix(-1 0 0 1 56 0)" /></g>
      <g className="p2"><path d={P} fill="#2bc48a" /></g>
      {seal && <path className="tick" d={CHECK} fill="none" stroke="#ffffff" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
