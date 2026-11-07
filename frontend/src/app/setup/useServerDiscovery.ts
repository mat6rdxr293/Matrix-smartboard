import { useCallback, useEffect, useRef, useState } from "react";
import { discoverServers, type DiscoveredServer } from "./androidSetup";

const key = (server: DiscoveredServer) => `${server.serverId}|${server.serverUrl}`;

/**
 * Searches the local network for Matrix servers, as the first-run setup does: about 15 seconds in
 * three windows, so a server that answers late still shows up while the search goes on.
 * Off the Android app there is no discovery and the list stays empty.
 */
export function useServerDiscovery() {
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current += 1;
    setDiscovering(false);
  }, []);

  const scan = useCallback(async () => {
    const runId = ++runRef.current;
    setDiscovering(true);
    const merge = (next: DiscoveredServer[]) => {
      if (runId !== runRef.current) return;
      setDiscovered((current) => {
        const merged = new Map(current.map((server) => [key(server), server]));
        next.forEach((server) => merged.set(key(server), server));
        return Array.from(merged.values());
      });
    };
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        if (runId !== runRef.current) return;
        try {
          merge(await discoverServers(5000));
        } catch {
          // Restricted Wi-Fi may block multicast; manual entry stays available.
        }
        if (pass < 2 && runId === runRef.current) {
          // Give Android NSD a moment to stop the previous browser before the next window.
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        }
      }
    } finally {
      if (runId === runRef.current) setDiscovering(false);
    }
  }, []);

  const reset = useCallback(() => setDiscovered([]), []);

  useEffect(() => () => { runRef.current += 1; }, []);

  return { discovered, discovering, scan, stop, reset };
}
