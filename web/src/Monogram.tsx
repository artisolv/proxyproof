import { useId } from 'react';

/**
 * PayeeProof's own monogram: two solid, upright P forms side by side. The bright P overlaps the deep P
 * like tinted glass, and one continuous check mark is cut through both bowls: its short arm in the first
 * P, its long arm rising into the second. The check stands in for the counters, so the proof is what ties
 * the two identities together. Built from its own geometry; upright, side by side and green so it cannot
 * be mistaken for any payment provider's mark.
 * The check is drawn in the background colour (`bg`), so pass the surface colour the mark sits on.
 * Animated: the two Ps slide together, the overlap appears, then the check is cut. With reduced motion
 * the finished mark is shown immediately.
 */
function pPath(x: number) {
  // Solid P: stem 11 wide, bowl 24 tall with a full round end, 4-unit corner radius.
  return `M${x + 4} 8H${x + 14}A12 12 0 0 1 ${x + 14} 32H${x + 11}V44a4 4 0 0 1-4 4H${x + 4}a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Z`;
}
const P1 = pPath(5), P2 = pPath(23);
const CHECK = 'M12 20.5L19.5 28L38 13.5';

export function Monogram({ size = 32, animate = false, bg = '#ffffff', seal = true, title = 'PayeeProof' }: { size?: number; animate?: boolean; bg?: string; seal?: boolean; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`pp-mark${animate ? ' animate' : ''}`} width={size} height={size} viewBox="0 0 56 56" role="img" aria-label={title}>
      <defs>
        <linearGradient id={`${id}a`} x1="5" y1="8" x2="30" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#0b7a55" /><stop offset="1" stopColor="#064e37" /></linearGradient>
        <linearGradient id={`${id}b`} x1="23" y1="8" x2="49" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#2bc48a" /><stop offset="1" stopColor="#8fd65a" /></linearGradient>
        <clipPath id={`${id}c`}><path d={P1} /></clipPath>
      </defs>
      <path className="p1" d={P1} fill={`url(#${id}a)`} />
      <path className="p2" d={P2} fill={`url(#${id}b)`} />
      <path className="ov" d={P2} fill="#0a6446" clipPath={`url(#${id}c)`} />
      {seal && <path className="tick" d={CHECK} fill="none" stroke={bg} strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}
