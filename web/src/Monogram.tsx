/**
 * PayeeProof's own monogram: two upright, monoline P forms in two greens, linked like a chain.
 * The front P's bowl passes over the back P's stem at the top and under it at the bottom, so the
 * letters interlock rather than simply overlap: two identities that have to line up. A small seal
 * with a check sits at the corner. Built from its own geometry; not traced, recoloured or adapted
 * from any other company's mark.
 * Animated: the two P forms start apart, slide into their linked position, then the seal lands and
 * its check is drawn. With reduced motion the finished mark is shown immediately.
 */
export function Monogram({ size = 32, animate = false, bg = '#ffffff', seal = true, title = 'PayeeProof' }: { size?: number; animate?: boolean; bg?: string; seal?: boolean; title?: string }) {
  const back = '#2bc48a', front = '#064e37';
  const w = 4.4, gap = w + 3.2;
  const backP = 'M23 33V7h6a7 7 0 0 1 0 14h-6';
  const frontP = 'M15 41V15h6a7 7 0 0 1 0 14h-6';
  return (
    <svg className={`pp-mark${animate ? ' animate' : ''}`} width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={title}>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" transform="translate(-1.5 0)">
        <g className="p2"><path d={backP} stroke={back} strokeWidth={w} /></g>
        <g className="p1">
          <path d={frontP} stroke={bg} strokeWidth={gap} />
          <path d={frontP} stroke={front} strokeWidth={w} />
        </g>
        {/* Where the back stem crosses the front bowl's lower bar, the back P passes over: the link. */}
        <g className="p2 weave">
          <path d="M23 25.5v7.5" stroke={bg} strokeWidth={gap} strokeLinecap="butt" />
          <path d="M23 25.5V33" stroke={back} strokeWidth={w} />
        </g>
      </g>
      {seal && <g className="seal">
        <circle cx="37" cy="36" r="6" fill={front} stroke={bg} strokeWidth="2" />
        <path className="tick" d="M34.3 36.1l1.9 1.9 3.6-3.8" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </g>}
    </svg>
  );
}
