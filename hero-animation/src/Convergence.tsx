import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  random,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  getLength,
  getPointAtLength,
  getTangentAtLength,
} from "@remotion/paths";

// Reunly palette (styles.css :root, dark theme).
export const BG = "#080b16";
export const BG_2 = "#0c1122";
export const TEXT = "#eef1f8";
export const TEXT_DIM = "#9aa3b8";
export const INDIGO = "#6366f1";
export const VIOLET = "#a855f7";
export const PINK = "#ec4899";
export const GOOD = "#34d399";

export type Traveller = {
  readonly city: string;
  readonly mode: "flight" | "drive";
};

export type ConvergenceProps = {
  readonly destination: string;
  readonly emoji: string;
  readonly travellers: readonly Traveller[];
};

// A flight arcs high, a road stays low — the line's shape says the mode,
// same rule as the app's journey map.
const ARC = { flight: 1, drive: 0.3 } as const;

type Route = {
  readonly d: string;
  readonly origin: { x: number; y: number };
  readonly length: number;
  readonly depart: number;
  readonly travel: number;
  readonly mode: Traveller["mode"];
  readonly city: string;
};

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const Convergence: React.FC<ConvergenceProps> = ({
  destination,
  emoji,
  travellers,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const hub = { x: width * 0.79, y: height / 2 };
  const n = travellers.length;
  const gap = n === 1 ? 0 : Math.min(height * 0.18, (height * 0.7) / (n - 1));

  const routes: Route[] = travellers.map((t, i) => {
    const offset = i - (n - 1) / 2;
    const origin = {
      x: width * 0.2 + Math.abs(offset) * width * 0.025,
      y: height / 2 + offset * gap,
    };
    const midX = (origin.x + hub.x) / 2;
    const lift = (height * 0.14 + Math.abs(offset) * height * 0.03) * ARC[t.mode];
    const cy = origin.y + (hub.y - origin.y) / 2 - lift;
    const d = `M ${origin.x} ${origin.y} Q ${midX} ${cy} ${hub.x} ${hub.y}`;
    return {
      d,
      origin,
      length: getLength(d),
      // Staggered departures; a car takes a little longer than a plane.
      depart: Math.round((1.4 + i * 0.55) * fps),
      travel: Math.round((t.mode === "flight" ? 2.3 : 2.8) * fps),
      mode: t.mode,
      city: t.city,
    };
  });

  const arrivals = routes.map((r) => r.depart + r.travel);
  const lastArrival = Math.max(...arrivals);
  const arrivedCount = arrivals.filter((a) => frame >= a).length;

  // Whole-scene fade so the loop restarts without a hard cut.
  const sceneOpacity = interpolate(
    frame,
    [0, 0.4 * fps, durationInFrames - 0.6 * fps, durationInFrames],
    [0, 1, 1, 0],
    clamp,
  );

  const hubIn = spring({ frame: frame - 0.2 * fps, fps, config: { damping: 12 } });
  const celebrate = spring({
    frame: frame - lastArrival,
    fps,
    config: { damping: 10, mass: 0.8 },
  });

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 70% 50%, ${BG_2} 0%, ${BG} 70%)`,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        opacity: sceneOpacity,
        overflow: "hidden",
      }}
    >
      <Aurora />
      <DotGrid />

      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0 }}
      >
        <defs>
          <linearGradient id="route" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={INDIGO} />
            <stop offset="55%" stopColor={VIOLET} />
            <stop offset="100%" stopColor={PINK} />
          </linearGradient>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="hubFill">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="45%" stopColor={VIOLET} />
            <stop offset="100%" stopColor={INDIGO} />
          </radialGradient>
        </defs>

        {routes.map((r, i) => (
          <RouteLine key={r.city} route={r} index={i} />
        ))}

        {/* Ripples: one per arrival, plus a big one when the last lands. */}
        {arrivals.map((a, i) => (
          <Ripple key={i} at={a} x={hub.x} y={hub.y} size={90} />
        ))}
        <Ripple at={lastArrival} x={hub.x} y={hub.y} size={230} />

        <Sparks at={lastArrival} x={hub.x} y={hub.y} />

        {/* Destination hub */}
        <g
          style={{
            transformOrigin: `${hub.x}px ${hub.y}px`,
            scale: String(hubIn * (1 + 0.25 * celebrate) * (1 + arrivedCount * 0.04)),
          }}
        >
          <circle
            cx={hub.x}
            cy={hub.y}
            r={46}
            fill="none"
            stroke={VIOLET}
            strokeOpacity={0.35}
            strokeWidth={2}
            strokeDasharray="6 10"
            style={{
              transformOrigin: `${hub.x}px ${hub.y}px`,
              rotate: `${interpolate(frame, [0, durationInFrames], [0, 120])}deg`,
            }}
          />
          <circle
            cx={hub.x}
            cy={hub.y}
            r={interpolate(Math.sin((frame / fps) * Math.PI * 1.6), [-1, 1], [30, 36])}
            fill={VIOLET}
            fillOpacity={0.18}
          />
          <circle cx={hub.x} cy={hub.y} r={20} fill="url(#hubFill)" filter="url(#glow)" />
        </g>

        {routes.map((r, i) =>
          r.mode === "flight" ? (
            <Plane key={r.city} route={r} index={i} />
          ) : (
            <Car key={r.city} route={r} index={i} />
          ),
        )}
      </svg>

      {/* Origin labels (HTML so text renders crisply) */}
      {routes.map((r, i) => (
        <OriginLabel key={r.city} route={r} index={i} arrived={frame >= arrivals[i]} />
      ))}

      {/* Destination label + arrivals counter */}
      <div
        style={{
          position: "absolute",
          left: hub.x - 240,
          width: 480,
          top: hub.y + 70,
          textAlign: "center",
          color: TEXT,
          fontWeight: 800,
          fontSize: 44,
          letterSpacing: -0.5,
          opacity: interpolate(frame, [0.3 * fps, 0.8 * fps], [0, 1], clamp),
          translate: `0px ${interpolate(frame, [0.3 * fps, 0.8 * fps], [16, 0], {
            ...clamp,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px`,
          scale: String(1 + 0.18 * celebrate),
        }}
      >
        {emoji} {destination}
        <div
          style={{
            marginTop: 8,
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: 0.3,
            color: arrivedCount === n ? GOOD : TEXT_DIM,
          }}
        >
          {arrivedCount === n
            ? "Everyone's here 🎉"
            : `${arrivedCount} of ${n} arrived`}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------

const RouteLine: React.FC<{ route: Route; index: number }> = ({ route, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const drawStart = Math.round((0.5 + index * 0.2) * fps);
  const drawn = interpolate(frame, [drawStart, drawStart + 0.9 * fps], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.65, 0, 0.35, 1),
  });
  // Lit once the traveller has passed: the line "fills in" behind them.
  const progress = travelProgress(frame, route);
  return (
    <>
      <path
        d={route.d}
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.16}
        strokeWidth={2.5}
        strokeDasharray="4 9"
        strokeLinecap="round"
        style={{ clipPath: `inset(0 ${(1 - drawn) * 100}% 0 0)` }}
      />
      <path
        d={route.d}
        fill="none"
        stroke="url(#route)"
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={`${route.length * progress} ${route.length}`}
        opacity={0.85}
      />
    </>
  );
};

function travelProgress(frame: number, route: Route): number {
  return interpolate(frame, [route.depart, route.depart + route.travel], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.45, 0, 0.2, 1),
  });
}

const OriginLabel: React.FC<{ route: Route; index: number; arrived: boolean }> = ({
  route,
  index,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = Math.round((0.3 + index * 0.18) * fps);
  const pop = spring({ frame: frame - start, fps, config: { damping: 14 } });
  return (
    <div
      style={{
        position: "absolute",
        right: `calc(100% - ${route.origin.x}px)`,
        top: route.origin.y - 22,
        display: "flex",
        alignItems: "center",
        gap: 14,
        opacity: pop,
        translate: `${interpolate(pop, [0, 1], [-24, 0])}px 0px`,
      }}
    >
      <span style={{ color: TEXT_DIM, fontSize: 30, fontWeight: 700, whiteSpace: "nowrap" }}>
        {route.city}
      </span>
      <span
        style={{
          width: 16,
          height: 16,
          marginRight: -8,
          borderRadius: 999,
          background: TEXT,
          boxShadow: `0 0 0 ${interpolate(Math.sin(frame / 6 + index), [-1, 1], [4, 9])}px rgba(139,140,249,0.25)`,
          scale: String(pop),
        }}
      />
    </div>
  );
};

const Plane: React.FC<{ route: Route; index: number }> = ({ route, index }) => {
  const frame = useCurrentFrame();
  const p = travelProgress(frame, route);
  if (frame < route.depart - 4) return null;
  const at = getPointAtLength(route.d, route.length * p) ?? route.origin;
  const tan = getTangentAtLength(route.d, Math.min(route.length * p, route.length - 0.01)) ?? { x: 1, y: 0 };
  const angle = (Math.atan2(tan.y, tan.x) * 180) / Math.PI;
  // Climb, cruise, descend: bigger at altitude, shadow drifts further away.
  const altitude = Math.sin(p * Math.PI);
  // Small on the runway so it doesn't cover the city label, full size in the air.
  const runway = interpolate(p, [0, 0.12, 0.88, 1], [0.35, 1, 1, 0.5], clamp);
  const size = (1 + altitude * 0.45) * runway;
  const appear = interpolate(frame, [route.depart - 4, route.depart + 4], [0, 1], clamp);
  const land = interpolate(p, [0.93, 1], [1, 0], clamp);
  return (
    <g opacity={appear * land}>
      <Trail route={route} p={p} index={index} />
      {/* Ground shadow */}
      <g
        transform={`translate(${at.x + altitude * 18} ${at.y + altitude * 26}) rotate(${angle}) scale(${size * 0.9})`}
        opacity={0.28 * altitude}
      >
        <AirlinerShape fill="#000000" />
      </g>
      <g transform={`translate(${at.x} ${at.y}) rotate(${angle}) scale(${size})`} filter="url(#glow)">
        <AirlinerShape fill={TEXT} />
      </g>
    </g>
  );
};

const Car: React.FC<{ route: Route; index: number }> = ({ route, index }) => {
  const frame = useCurrentFrame();
  const p = travelProgress(frame, route);
  if (frame < route.depart - 4) return null;
  const at = getPointAtLength(route.d, route.length * p) ?? route.origin;
  const appear = interpolate(frame, [route.depart - 4, route.depart + 4], [0, 1], clamp);
  const land = interpolate(p, [0.93, 1], [1, 0], clamp);
  // Stays upright (a rotated car reads as a glitch); a small road bounce.
  const bounce = p > 0 && p < 1 ? Math.abs(Math.sin(frame / 2.2)) * 2.5 : 0;
  return (
    <g opacity={appear * land}>
      <Trail route={route} p={p} index={index} />
      <g transform={`translate(${at.x} ${at.y - 14 - bounce})`} filter="url(#glow)">
        <CarShape />
      </g>
    </g>
  );
};

// A short gradient comet tail just behind the traveller.
const Trail: React.FC<{ route: Route; p: number; index: number }> = ({ route, p }) => {
  const tail = Math.min(route.length * 0.22, route.length * p);
  const head = route.length * p;
  return (
    <path
      d={route.d}
      fill="none"
      stroke="url(#route)"
      strokeWidth={9}
      strokeLinecap="round"
      strokeDasharray={`${tail} ${route.length * 2}`}
      strokeDashoffset={-(head - tail)}
      opacity={0.55}
      filter="url(#glow)"
    />
  );
};

// Top-down airliner, nose pointing +x, centred on the origin.
export const AirlinerShape: React.FC<{ fill: string }> = ({ fill }) => (
  <g fill={fill}>
    {/* fuselage */}
    <path d="M 26 0 C 24 -3.2 18 -4 10 -4 L -20 -3.4 L -26 -1.2 L -26 1.2 L -20 3.4 L 10 4 C 18 4 24 3.2 26 0 Z" />
    {/* swept wings */}
    <path d="M 6 -3.6 L -6 -24 L -11 -24 L -5 -3.6 Z" />
    <path d="M 6 3.6 L -6 24 L -11 24 L -5 3.6 Z" />
    {/* tail stabilisers */}
    <path d="M -17 -3 L -24 -11 L -27 -11 L -23 -2.4 Z" />
    <path d="M -17 3 L -24 11 L -27 11 L -23 2.4 Z" />
    {/* cockpit accent */}
    <path d="M 22 -1.6 L 24.5 0 L 22 1.6 Z" fill={VIOLET} />
  </g>
);

// Side-view car, upright, centred on the origin.
export const CarShape: React.FC = () => (
  <g>
    <path
      d="M -20 4 L -20 -2 C -20 -5 -18 -6 -15 -6 L -9 -6 L -4 -13 L 9 -13 L 14 -6 L 18 -5 C 20 -4.5 21 -3 21 -1 L 21 4 Z"
      fill={PINK}
    />
    <path d="M -2.5 -11 L 2 -11 L 2 -6.5 L -6.5 -6.5 Z M 4 -11 L 8 -11 L 11.5 -6.5 L 4 -6.5 Z" fill={BG} opacity={0.75} />
    <circle cx={-11} cy={4} r={4.2} fill={TEXT} />
    <circle cx={12} cy={4} r={4.2} fill={TEXT} />
    <circle cx={-11} cy={4} r={1.6} fill={BG} />
    <circle cx={12} cy={4} r={1.6} fill={BG} />
  </g>
);

export const Ripple: React.FC<{ at: number; x: number; y: number; size: number; color?: string }> = ({
  at,
  x,
  y,
  size,
  color = PINK,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = interpolate(frame, [at, at + 0.9 * fps], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.cubic),
  });
  if (frame < at || t >= 1) return null;
  return (
    <circle
      cx={x}
      cy={y}
      r={20 + t * size}
      fill="none"
      stroke={color}
      strokeWidth={4 * (1 - t) + 0.5}
      opacity={1 - t}
    />
  );
};

// Deterministic burst when the whole group has arrived.
export const Sparks: React.FC<{ at: number; x: number; y: number }> = ({ at, x, y }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = (frame - at) / (1.3 * fps);
  if (t < 0 || t > 1) return null;
  const colors = [INDIGO, VIOLET, PINK, GOOD, "#fbbf24"];
  return (
    <g>
      {new Array(26).fill(0).map((_, i) => {
        const angle = random(`a${i}`) * Math.PI * 2;
        const dist = 90 + random(`d${i}`) * 170;
        const ease = 1 - Math.pow(1 - t, 3);
        const px = x + Math.cos(angle) * dist * ease;
        const py = y + Math.sin(angle) * dist * ease + t * t * 40;
        const r = 3 + random(`r${i}`) * 4;
        return (
          <circle
            key={i}
            cx={px}
            cy={py}
            r={r * (1 - t * 0.6)}
            fill={colors[i % colors.length]}
            opacity={1 - t}
          />
        );
      })}
    </g>
  );
};

export const Aurora: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const drift = interpolate(frame, [0, durationInFrames], [0, 1]);
  return (
    <>
      <div
        style={{
          position: "absolute",
          width: 700,
          height: 700,
          left: -150 + drift * 120,
          top: -380,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${INDIGO}55 0%, transparent 65%)`,
          filter: "blur(30px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 620,
          height: 620,
          right: -120 + drift * 80,
          bottom: -360,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${PINK}40 0%, transparent 65%)`,
          filter: "blur(30px)",
        }}
      />
    </>
  );
};

// Faint dotted "map" texture, drifting slowly.
const DotGrid: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        backgroundImage: "radial-gradient(rgba(255,255,255,0.09) 1.4px, transparent 1.6px)",
        backgroundSize: "28px 28px",
        backgroundPosition: `${(-frame / fps) * 6}px 0px`,
        maskImage: "radial-gradient(ellipse at 60% 50%, black 30%, transparent 80%)",
        WebkitMaskImage: "radial-gradient(ellipse at 60% 50%, black 30%, transparent 80%)",
      }}
    />
  );
};
