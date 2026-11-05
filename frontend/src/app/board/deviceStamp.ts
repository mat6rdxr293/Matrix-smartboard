const DEVICE_KEY = "matrix.device.id";
const SEQ_KEY = "matrix.device.seq";

let deviceId: string | null = null;
let nextSeq: number | null = null;

/**
 * This board's id and running operation count. Servers of a cluster use them to keep one board's
 * operations in the order it made them, whichever server each one reached first.
 */
export function nextDeviceStamp(): { device_id: string; client_seq: number } {
  if (deviceId === null) {
    try {
      deviceId = window.localStorage.getItem(DEVICE_KEY);
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        window.localStorage.setItem(DEVICE_KEY, deviceId);
      }
      nextSeq = Number(window.localStorage.getItem(SEQ_KEY)) || 0;
    } catch {
      deviceId = deviceId || crypto.randomUUID();
      nextSeq = nextSeq ?? 0;
    }
  }
  const stamp = { device_id: deviceId, client_seq: nextSeq ?? 0 };
  nextSeq = (nextSeq ?? 0) + 1;
  try {
    window.localStorage.setItem(SEQ_KEY, String(nextSeq));
  } catch {
    // Without storage the count restarts with the app; ids stay unique per op regardless.
  }
  return stamp;
}
