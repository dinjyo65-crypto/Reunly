import { Composition, Folder } from "remotion";
import { Convergence } from "./Convergence";
import { Globe } from "./Globe";

// The four sample trips the registration hero rotates through (app.js
// SAMPLE_TRIPS). 1200x570 keeps the hero's ~2.1:1 shape at 3x for sharp phones.
export const RemotionRoot: React.FC = () => {
  return (
    <>
    {/* Look-and-feel candidates for review (same Bali trip throughout). */}
    <Folder name="Lab">
      <Composition id="LabBrand" component={Globe} durationInFrames={270} fps={30} width={1200} height={570}
        defaultProps={{ destination: "Bali", emoji: "🌺", lat: -8.41, lon: 115.19, palette: "brand", pace: 1,
          travellers: [
            { city: "Sydney", mode: "flight", lat: -33.87, lon: 151.21 },
            { city: "Singapore", mode: "flight", lat: 1.35, lon: 103.82 },
            { city: "Hong Kong", mode: "flight", lat: 22.32, lon: 114.17 },
            { city: "Bangkok", mode: "flight", lat: 13.76, lon: 100.5 },
          ] }} />
      <Composition id="LabEarth" component={Globe} durationInFrames={270} fps={30} width={1200} height={570}
        defaultProps={{ destination: "Bali", emoji: "🌺", lat: -8.41, lon: 115.19, palette: "earth", pace: 1,
          travellers: [
            { city: "Sydney", mode: "flight", lat: -33.87, lon: 151.21 },
            { city: "Singapore", mode: "flight", lat: 1.35, lon: 103.82 },
            { city: "Hong Kong", mode: "flight", lat: 22.32, lon: 114.17 },
            { city: "Bangkok", mode: "flight", lat: 13.76, lon: 100.5 },
          ] }} />
      <Composition id="LabNight" component={Globe} durationInFrames={270} fps={30} width={1200} height={570}
        defaultProps={{ destination: "Bali", emoji: "🌺", lat: -8.41, lon: 115.19, palette: "night", pace: 1,
          travellers: [
            { city: "Sydney", mode: "flight", lat: -33.87, lon: 151.21 },
            { city: "Singapore", mode: "flight", lat: 1.35, lon: 103.82 },
            { city: "Hong Kong", mode: "flight", lat: 22.32, lon: 114.17 },
            { city: "Bangkok", mode: "flight", lat: 13.76, lon: 100.5 },
          ] }} />
      <Composition id="LabTeal" component={Globe} durationInFrames={270} fps={30} width={1200} height={570}
        defaultProps={{ destination: "Bali", emoji: "🌺", lat: -8.41, lon: 115.19, palette: "teal", pace: 1,
          travellers: [
            { city: "Sydney", mode: "flight", lat: -33.87, lon: 151.21 },
            { city: "Singapore", mode: "flight", lat: 1.35, lon: 103.82 },
            { city: "Hong Kong", mode: "flight", lat: 22.32, lon: 114.17 },
            { city: "Bangkok", mode: "flight", lat: 13.76, lon: 100.5 },
          ] }} />
      <Composition id="LabFast" component={Globe} durationInFrames={216} fps={30} width={1200} height={570}
        defaultProps={{ destination: "Bali", emoji: "🌺", lat: -8.41, lon: 115.19, palette: "brand", pace: 0.8,
          travellers: [
            { city: "Sydney", mode: "flight", lat: -33.87, lon: 151.21 },
            { city: "Singapore", mode: "flight", lat: 1.35, lon: 103.82 },
            { city: "Hong Kong", mode: "flight", lat: 22.32, lon: 114.17 },
            { city: "Bangkok", mode: "flight", lat: 13.76, lon: 100.5 },
          ] }} />
      <Composition id="LabSlow" component={Globe} durationInFrames={351} fps={30} width={1200} height={570}
        defaultProps={{ destination: "Bali", emoji: "🌺", lat: -8.41, lon: 115.19, palette: "brand", pace: 1.3,
          travellers: [
            { city: "Sydney", mode: "flight", lat: -33.87, lon: 151.21 },
            { city: "Singapore", mode: "flight", lat: 1.35, lon: 103.82 },
            { city: "Hong Kong", mode: "flight", lat: 22.32, lon: 114.17 },
            { city: "Bangkok", mode: "flight", lat: 13.76, lon: 100.5 },
          ] }} />
    </Folder>
    <Folder name="Reunly-hero-globe">
      <Composition
        id="GlobeBali"
        component={Globe}
        durationInFrames={270}
        fps={30}
        width={1200}
        height={570}
        defaultProps={{
          destination: "Bali",
          emoji: "🌺",
          lat: -8.41,
          lon: 115.19,
          travellers: [
            { city: "Sydney", mode: "flight", lat: -33.87, lon: 151.21 },
            { city: "Singapore", mode: "flight", lat: 1.35, lon: 103.82 },
            { city: "Hong Kong", mode: "flight", lat: 22.32, lon: 114.17 },
            { city: "Bangkok", mode: "flight", lat: 13.76, lon: 100.5 },
          ],
        }}
      />
      <Composition
        id="GlobeGoa"
        component={Globe}
        durationInFrames={270}
        fps={30}
        width={1200}
        height={570}
        defaultProps={{
          destination: "Goa",
          emoji: "🏝️",
          lat: 15.3,
          lon: 74.0,
          travellers: [
            { city: "London", mode: "flight", lat: 51.51, lon: -0.13 },
            { city: "Dubai", mode: "flight", lat: 25.2, lon: 55.27 },
            { city: "Mumbai", mode: "flight", lat: 19.08, lon: 72.88 },
            { city: "Pune", mode: "drive", lat: 18.52, lon: 73.86 },
          ],
        }}
      />
      <Composition
        id="GlobeParis"
        component={Globe}
        durationInFrames={270}
        fps={30}
        width={1200}
        height={570}
        defaultProps={{
          destination: "Paris",
          emoji: "🗼",
          lat: 48.86,
          lon: 2.35,
          travellers: [
            { city: "London", mode: "flight", lat: 51.51, lon: -0.13 },
            { city: "New York", mode: "flight", lat: 40.71, lon: -74.01 },
            { city: "Dubai", mode: "flight", lat: 25.2, lon: 55.27 },
            { city: "Manchester", mode: "flight", lat: 53.48, lon: -2.24 },
          ],
        }}
      />
      <Composition
        id="GlobeNewYork"
        component={Globe}
        durationInFrames={270}
        fps={30}
        width={1200}
        height={570}
        defaultProps={{
          destination: "New York",
          emoji: "🗽",
          lat: 40.71,
          lon: -74.01,
          travellers: [
            { city: "Boston", mode: "drive", lat: 42.36, lon: -71.06 },
            { city: "Chicago", mode: "flight", lat: 41.88, lon: -87.63 },
            { city: "London", mode: "flight", lat: 51.51, lon: -0.13 },
            { city: "Washington", mode: "drive", lat: 38.9, lon: -77.04 },
          ],
        }}
      />
    </Folder>
    <Folder name="Reunly-hero">
      <Composition
        id="HeroBali"
        component={Convergence}
        durationInFrames={270}
        fps={30}
        width={1200}
        height={570}
        defaultProps={{
          destination: "Bali",
          emoji: "🌺",
          travellers: [
            { city: "Sydney", mode: "flight" },
            { city: "Singapore", mode: "flight" },
            { city: "Hong Kong", mode: "flight" },
            { city: "Bangkok", mode: "flight" },
          ],
        }}
      />
      <Composition
        id="HeroGoa"
        component={Convergence}
        durationInFrames={270}
        fps={30}
        width={1200}
        height={570}
        defaultProps={{
          destination: "Goa",
          emoji: "🏝️",
          travellers: [
            { city: "London", mode: "flight" },
            { city: "Dubai", mode: "flight" },
            { city: "Mumbai", mode: "flight" },
            { city: "Pune", mode: "drive" },
            { city: "Singapore", mode: "flight" },
          ],
        }}
      />
      <Composition
        id="HeroParis"
        component={Convergence}
        durationInFrames={270}
        fps={30}
        width={1200}
        height={570}
        defaultProps={{
          destination: "Paris",
          emoji: "🗼",
          travellers: [
            { city: "London", mode: "flight" },
            { city: "New York", mode: "flight" },
            { city: "Dubai", mode: "flight" },
            { city: "Manchester", mode: "flight" },
          ],
        }}
      />
      <Composition
        id="HeroNewYork"
        component={Convergence}
        durationInFrames={270}
        fps={30}
        width={1200}
        height={570}
        defaultProps={{
          destination: "New York",
          emoji: "🗽",
          travellers: [
            { city: "Boston", mode: "drive" },
            { city: "Chicago", mode: "flight" },
            { city: "London", mode: "flight" },
            { city: "Washington", mode: "drive" },
          ],
        }}
      />
    </Folder>
    </>
  );
};
