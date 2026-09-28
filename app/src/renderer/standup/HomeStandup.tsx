import { StandupCard } from "./StandupCard";
import { useStandup } from "./store";

const DAY_MS = 24 * 3_600_000;

/** Home (the New chat screen): today's Team standup card, when there is one. main.tsx loads it on connect. */
export function HomeStandup() {
  const card = useStandup((s) => s.view?.latest);
  if (!card || Date.now() - card.createdAt > DAY_MS) return null;
  return <div className="home-standup"><StandupCard card={card} /></div>;
}
