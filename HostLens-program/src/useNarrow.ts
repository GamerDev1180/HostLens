import { useEffect, useState } from "react";

const QUERY = "(max-width: 720px)";

/** True on phone-width screens (matches the CSS breakpoint in App.css). */
export function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}
