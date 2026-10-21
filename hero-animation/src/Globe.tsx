import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  geoDistance,
  geoGraticule10,
  geoInterpolate,
  geoOrthographic,
  geoPath,
  type GeoPermissibleObjects,
} from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import landTopo from "world-atlas/land-110m.json";
import {
  AirlinerShape,
  Aurora,
  BG,
  BG_2,
  CarShape,
  GOOD,
  INDIGO,
  PINK,
  Ripple,
  Sparks,
  TEXT,
  TEXT_DIM,
  VIOLET,
  clamp,
} from "./Convergence";

type LonLat = [number, number];

export type GlobeTraveller = {
  readonly city: string;
  readonly mode: "flight" | "drive";
  readonly lat: number;
  readonly lon: number;
};

export type GlobeProps = {
  readonly destination: string;
  readonly emoji: string;
  readonly lat: number;
  readonly lon: number;
  readonly travellers: readonly GlobeTraveller[];
  // Look and feel, kept as inputs so variants can be compared side by side.
  readonly palette?: PaletteName;
  // Multiplies every journey timing: 1 = 9 s loop, 1.3 = slower and calmer.
  readonly pace?: number;
};

type Palette = {
  readonly ocean: readonly [string, string, string];
  readonly land: string;
  readonly coast: string;
  readonly atmo: string;
  readonly route: readonly [string, string, string];
  readonly hub: string;
  readonly pin: string;
};

export const PALETTES = {
  // Agreed by the motion + brand review: brand navy and indigo, warm gold
  // "home lights" routes that resolve into brand pink at the destination.
  glow: {
    ocean: ["#17204a", "#0b1130", "#050812"],
    land: "rgba(165,180,252,0.14)",
    coast: "rgba(199,210,254,0.45)",
    atmo: INDIGO,
    route: ["#fcd34d", VIOLET, PINK],
    hub: PINK,
    pin: "#fcd34d",
  },
  // The app's own indigo → violet → pink on a navy globe.
  brand: {
    ocean: ["#1e2550", "#0f1430", "#060914"],
    land: "rgba(139,140,249,0.20)",
    coast: "rgba(167,139,250,0.55)",
    atmo: INDIGO,
    route: [INDIGO, VIOLET, PINK],
    hub: PINK,
    pin: INDIGO,
  },
  // Closer to a real Earth: blue ocean, green land, warm sunset routes.
  earth: {
    ocean: ["#1b5585", "#0c2f50", "#04121f"],
    land: "rgba(110,190,140,0.38)",
    coast: "rgba(170,230,190,0.6)",
    atmo: "#38bdf8",
    route: ["#fde68a", "#fb923c", "#ec4899"],
    hub: "#fb923c",
    pin: "#38bdf8",
  },
  // Night side of the planet: dark land, golden city-light routes.
  night: {
    ocean: ["#121a2e", "#0a0f1c", "#04060c"],
    land: "rgba(255,255,255,0.07)",
    coast: "rgba(251,191,36,0.45)",
    atmo: "#f59e0b",
    route: ["#fbbf24", "#f97316", "#ec4899"],
    hub: "#fbbf24",
    pin: "#fbbf24",
  },
  // Teal land on deep navy, routes running teal → violet → pink.
  teal: {
    ocean: ["#123047", "#0a1b2c", "#050c16"],
    land: "rgba(45,212,191,0.22)",
    coast: "rgba(94,234,212,0.6)",
    atmo: "#2dd4bf",
    route: ["#2dd4bf", VIOLET, PINK],
    hub: PINK,
    pin: "#2dd4bf",
  },
} satisfies Record<string, Palette>;
export type PaletteName = keyof typeof PALETTES;

const topo = landTopo as unknown as Topology<{ land: GeometryCollection }>;
const LAND = feature(topo, topo.objects.land) as GeoPermissibleObjects;
const GRATICULE = geoGraticule10();
const SAMPLES = 72;

// Spherical mean of some points: where the "camera" should look so the
// whole group is on the visible face.
function viewCentre(points: LonLat[]): LonLat {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [lon, lat] of points) {
    const l = (lon * Math.PI) / 180;
    const p = (lat * Math.PI) / 180;
    x += Math.cos(p) * Math.cos(l);
    y += Math.cos(p) * Math.sin(l);
    z += Math.sin(p);
  }
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  const lat = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
  return [lon, lat];
}

export const Globe: React.FC<GlobeProps> = ({
  destination,
  emoji,
  lat,
  lon,
  travellers,
  palette = "glow",
  pace = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const pal: Palette = PALETTES[palette];
  const departAt = (i: number) => Math.round((1.4 + i * 0.55) * pace * fps);
  const travelFor = (mode: GlobeTraveller["mode"]) => Math.round((mode === "flight" ? 2.3 : 2.8) * pace * fps);

  const dest: LonLat = [lon, lat];
  const origins: LonLat[] = travellers.map((t) => [t.lon, t.lat]);
  const [cLon, cLat] = viewCentre([dest, dest, ...origins]);

  // A slow, eased spin past the group, so the world is visibly turning while
  // everyone travels.
  const spin = interpolate(frame, [0, durationInFrames], [26, -4], {
    easing: Easing.bezier(0.33, 0, 0.67, 1),
  });
  // Timings are needed before the camera, so derive the last arrival here.
  const lastArrival = Math.max(...travellers.map((t, i) => departAt(i) + travelFor(t.mode)));
  // Camera: as the last travellers come in, turn to face the destination and
  // push in, so short hops (Boston→NY, Pune→Goa) open up for the finale.
  const focus = interpolate(frame, [lastArrival - 1.6 * pace * fps, lastArrival + 0.4 * pace * fps], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.65, 0, 0.35, 1),
  });
  const R = height * 0.43 * (1 + 0.45 * focus);
  const C = { x: width * 0.43, y: height / 2 };
  const groupLon = cLon - spin;
  const lonDelta = ((((dest[0] - groupLon) % 360) + 540) % 360) - 180;
  const viewLonLat: LonLat = [
    groupLon + lonDelta * focus * 0.8,
    cLat * 0.7 + (dest[1] - cLat * 0.7) * focus * 0.8,
  ];
  const projection = geoOrthographic()
    .scale(R)
    .translate([C.x, C.y])
    .rotate([-viewLonLat[0], -viewLonLat[1]])
    .clipAngle(90);
  const path = geoPath(projection);

  // Project a lon/lat at a height above the surface (fraction of R). The
  // orthographic projection is linear, so altitude just scales the offset
  // from the centre. Occluded = behind the globe and inside its disc.
  const project = (ll: LonLat, h = 0) => {
    const p = projection(ll) ?? [C.x, C.y];
    const x = C.x + (p[0] - C.x) * (1 + h);
    const y = C.y + (p[1] - C.y) * (1 + h);
    const z = Math.cos(geoDistance(ll, viewLonLat));
    const outside = Math.hypot(x - C.x, y - C.y) > R;
    return { x, y, z, visible: z > 0 || outside };
  };

  const routes = travellers.map((t, i) => {
    const from: LonLat = [t.lon, t.lat];
    const interp = geoInterpolate(from, dest);
    const dist = geoDistance(from, dest);
    const alt = t.mode === "flight" ? Math.min(0.3, 0.06 + dist * 0.22) : 0.008;
    const depart = departAt(i);
    const travel = travelFor(t.mode);
    const progress = interpolate(frame, [depart, depart + travel], [0, 1], {
      ...clamp,
      easing: Easing.bezier(0.45, 0, 0.2, 1),
    });
    const at = (s: number) => project(interp(s), alt * Math.sin(Math.PI * s));
    return { ...t, i, from, interp, alt, depart, travel, progress, at };
  });

  const arrivals = routes.map((r) => r.depart + r.travel);
  const arrivedCount = arrivals.filter((a) => frame >= a).length;
  const n = routes.length;

  const sceneOpacity = interpolate(
    frame,
    [0, 0.4 * fps, durationInFrames - 0.6 * fps, durationInFrames],
    [0, 1, 1, 0],
    clamp,
  );
  const globeIn = spring({ frame, fps, config: { damping: 16 } });
  const celebrate = spring({ frame: frame - lastArrival, fps, config: { damping: 10, mass: 0.8 } });
  const hub = project(dest);

  // City labels: pushed apart vertically so neighbours (London/Manchester,
  // Mumbai/Pune) stay readable.
  const labels = routes
    .map((r) => {
      const p = project(r.from);
      return { r, p, y: p.y, left: p.x <= hub.x };
    })
    .sort((a, b) => a.y - b.y);
  for (let pass = 0; pass < 4; pass++) {
    for (let k = 1; k < labels.length; k++) {
      const a = labels[k - 1];
      const b = labels[k];
      if (a.left === b.left && b.y - a.y < 38) {
        const push = (38 - (b.y - a.y)) / 2;
        a.y -= push;
        b.y += push;
      }
    }
  }

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 45% 50%, ${BG_2} 0%, ${BG} 70%)`,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        opacity: sceneOpacity,
        overflow: "hidden",
      }}
    >
      <Aurora />
      <Stars />

      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{
          position: "absolute",
          inset: 0,
          scale: String(interpolate(globeIn, [0, 1], [0.85, 1])),
          transformOrigin: `${C.x}px ${C.y}px`,
        }}
      >
        <defs>
          <radialGradient id="ocean" cx="38%" cy="32%" r="75%">
            <stop offset="0%" stopColor={pal.ocean[0]} />
            <stop offset="55%" stopColor={pal.ocean[1]} />
            <stop offset="100%" stopColor={pal.ocean[2]} />
          </radialGradient>
          <radialGradient id="atmo">
            <stop offset="80%" stopColor={pal.atmo} stopOpacity={0.35} />
            <stop offset="100%" stopColor={pal.atmo} stopOpacity={0} />
          </radialGradient>
          <radialGradient id="limb" cx="50%" cy="50%" r="50%">
            <stop offset="70%" stopColor="#000" stopOpacity={0} />
            <stop offset="100%" stopColor="#000" stopOpacity={0.55} />
          </radialGradient>
          <radialGradient id="shine" cx="34%" cy="26%" r="40%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.14} />
            <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
          </radialGradient>
          {/* One gradient per route, anchored home → destination in screen
              space, so it always starts gold at home and ends pink on
              arrival whichever way the route points. */}
          {routes.map((r) => {
            const a = project(r.from);
            return (
              <linearGradient
                key={r.city}
                id={`gRoute${r.i}`}
                gradientUnits="userSpaceOnUse"
                x1={a.x}
                y1={a.y}
                x2={hub.x}
                y2={hub.y}
              >
                <stop offset="0%" stopColor={pal.route[0]} />
                <stop offset="55%" stopColor={pal.route[1]} />
                <stop offset="100%" stopColor={pal.route[2]} />
              </linearGradient>
            );
          })}
          <filter id="gGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Atmosphere, ocean, graticule, land, then lighting on top */}
        <circle cx={C.x} cy={C.y} r={R * 1.12} fill="url(#atmo)" />
        <circle cx={C.x} cy={C.y} r={R} fill="url(#ocean)" />
        <path d={path(GRATICULE) ?? ""} fill="none" stroke="#ffffff" strokeOpacity={0.06} strokeWidth={1} />
        <path
          d={path(LAND) ?? ""}
          fill={pal.land}
          stroke={pal.coast}
          strokeWidth={0.8}
        />
        <circle cx={C.x} cy={C.y} r={R} fill="url(#limb)" />
        <circle cx={C.x} cy={C.y} r={R} fill="url(#shine)" />

        {/* Routes */}
        {routes.map((r) => {
          const drawStart = Math.round((0.5 + r.i * 0.2) * fps);
          const drawn = interpolate(frame, [drawStart, drawStart + 0.9 * fps], [0, 1], clamp);
          return (
            <g key={r.city}>
              <path
                d={polyline(r.at, 0, drawn)}
                fill="none"
                stroke="#ffffff"
                strokeOpacity={0.22}
                strokeWidth={2}
                strokeDasharray="4 8"
                strokeLinecap="round"
              />
              <path
                d={polyline(r.at, 0, r.progress)}
                fill="none"
                stroke={`url(#gRoute${r.i})`}
                strokeWidth={5}
                strokeLinecap="round"
                opacity={0.9}
              />
              <path
                d={polyline(r.at, Math.max(0, r.progress - 0.22), r.progress)}
                fill="none"
                stroke={`url(#gRoute${r.i})`}
                strokeWidth={12}
                strokeLinecap="round"
                opacity={r.progress > 0 && r.progress < 1 ? 0.35 : 0}
                filter="url(#gGlow)"
              />
            </g>
          );
        })}

        {/* Origin pins */}
        {routes.map((r) => {
          const p = project(r.from);
          const pop = spring({ frame: frame - Math.round((0.3 + r.i * 0.18) * fps), fps, config: { damping: 14 } });
          if (!p.visible) return null;
          return (
            <g key={r.city} opacity={pop * Math.min(1, p.z * 4)}>
              <circle cx={p.x} cy={p.y} r={9 + Math.sin(frame / 6 + r.i) * 2.5} fill={pal.pin} fillOpacity={0.3} />
              <circle cx={p.x} cy={p.y} r={5} fill={TEXT} />
            </g>
          );
        })}

        {/* Ripples + burst at the destination */}
        {arrivals.map((a, k) => (
          <Ripple key={k} at={a} x={hub.x} y={hub.y} size={70} color={pal.hub} />
        ))}
        <Ripple at={lastArrival} x={hub.x} y={hub.y} size={180} color={pal.hub} />
        <Sparks at={lastArrival} x={hub.x} y={hub.y} />

        {/* Destination hub */}
        <g style={{ transformOrigin: `${hub.x}px ${hub.y}px`, scale: String(1 + 0.3 * celebrate + arrivedCount * 0.05) }}>
          <circle cx={hub.x} cy={hub.y} r={22 + Math.sin((frame / fps) * Math.PI * 1.6) * 3} fill={VIOLET} fillOpacity={0.22} />
          <circle cx={hub.x} cy={hub.y} r={10} fill={pal.hub} filter="url(#gGlow)" />
          <circle cx={hub.x} cy={hub.y} r={4} fill="#fff" />
        </g>

        {/* Travellers: shadow on the ground, craft in the air */}
        {routes.map((r) => {
          if (frame < r.depart - 4 || r.progress >= 1) return null;
          const s = r.progress;
          const here = r.at(s);
          if (!here.visible) return null;
          const ahead = r.at(Math.min(1, s + 0.01));
          const angle = (Math.atan2(ahead.y - here.y, ahead.x - here.x) * 180) / Math.PI;
          const altitude = Math.sin(Math.PI * s);
          const appear = interpolate(frame, [r.depart - 4, r.depart + 4], [0, 1], clamp);
          const land = interpolate(s, [0.93, 1], [1, 0], clamp);
          if (r.mode === "drive") {
            return (
              <g key={r.city} opacity={appear * land} transform={`translate(${here.x} ${here.y - 12}) scale(0.8)`} filter="url(#gGlow)">
                <CarShape />
              </g>
            );
          }
          const ground = project(r.interp(s));
          const runway = interpolate(s, [0, 0.12, 0.88, 1], [0.35, 1, 1, 0.5], clamp);
          const size = (0.85 + altitude * 0.5) * runway;
          return (
            <g key={r.city} opacity={appear * land}>
              {ground.z > 0 ? (
                <g transform={`translate(${ground.x} ${ground.y}) rotate(${angle}) scale(${size * 0.75})`} opacity={0.35 * altitude}>
                  <AirlinerShape fill="#000" />
                </g>
              ) : null}
              <g transform={`translate(${here.x} ${here.y}) rotate(${angle}) scale(${size})`} filter="url(#gGlow)">
                <AirlinerShape fill={TEXT} />
              </g>
            </g>
          );
        })}
      </svg>

      {/* City labels */}
      {labels.map(({ r, p, y, left }) => {
        const pop = spring({ frame: frame - Math.round((0.3 + r.i * 0.18) * fps), fps, config: { damping: 14 } });
        if (!p.visible) return null;
        return (
          <div
            key={r.city}
            style={{
              position: "absolute",
              top: y - 20,
              ...(left ? { right: `calc(100% - ${p.x - 14}px)` } : { left: p.x + 14 }),
              color: TEXT,
              fontSize: 32,
              fontWeight: 600,
              whiteSpace: "nowrap",
              WebkitTextStroke: "4px rgba(8,11,22,0.85)",
              paintOrder: "stroke fill",
              opacity: pop * Math.min(1, p.z * 4),
            }}
          >
            {r.city}
          </div>
        );
      })}

      {/* Title block beside the globe */}
      <div
        style={{
          position: "absolute",
          left: width * 0.76,
          top: height / 2 - 60,
          color: TEXT,
          opacity: interpolate(frame, [0.4 * fps, 0.9 * fps], [0, 1], clamp),
          translate: `${interpolate(frame, [0.4 * fps, 0.9 * fps], [20, 0], {
            ...clamp,
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px 0px`,
        }}
      >
        <div style={{ fontSize: 56, lineHeight: 1 }}>{emoji}</div>
        <div
          style={{
            fontSize: 48,
            fontWeight: 800,
            letterSpacing: -0.5,
            marginTop: 8,
            scale: String(1 + 0.12 * celebrate),
            transformOrigin: "left center",
          }}
        >
          {destination}
        </div>
        <div
          style={{
            marginTop: 8,
            fontSize: 22,
            fontWeight: 600,
            color: arrivedCount === n ? GOOD : TEXT_DIM,
          }}
        >
          {arrivedCount === n ? "Everyone's here 🎉" : `${arrivedCount} of ${n} arrived`}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// SVG path through the visible samples of a route between s0 and s1,
// breaking the line wherever it passes behind the globe.
function polyline(
  at: (s: number) => { x: number; y: number; visible: boolean },
  s0: number,
  s1: number,
): string {
  if (s1 <= s0) return "";
  let d = "";
  let pen = false;
  const steps = Math.max(2, Math.ceil(SAMPLES * (s1 - s0)));
  for (let k = 0; k <= steps; k++) {
    const p = at(s0 + ((s1 - s0) * k) / steps);
    if (!p.visible) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
    pen = true;
  }
  return d;
}

// A few twinkling stars, placed deterministically.
const Stars: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        color: "#df4d4d"
      }}
    >
      {new Array(40).fill(0).map((_, i) => {
        const x = ((i * 9301 + 49297) % 233280) / 233280;
        const y = ((i * 4271 + 1237) % 7919) / 7919;
        const tw = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(frame / 9 + i * 1.7));
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x * width,
              top: y * height,
              width: i % 5 === 0 ? 3 : 2,
              height: i % 5 === 0 ? 3 : 2,
              borderRadius: 9,
              background: "#fff",
              opacity: tw,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
