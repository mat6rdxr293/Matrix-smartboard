// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chooseMember, nodeIdMatchesPin, type ClusterMember } from "./cluster";

const pin = (id: string) => `sha256/${id}${"0".repeat(64 - id.length)}`;
const member = (id: string): ClusterMember => ({ nodeId: id, name: id, url: `https://${id}:8443`, pin: pin(id) });

describe("choosing a cluster member", () => {
  const a = member("aaaaaaaaaaaaaaaaaaaaaaaa");
  const b = member("bbbbbbbbbbbbbbbbbbbbbbbb");
  const c = member("cccccccccccccccccccccccc");
  const members = [a, b, c];
  const scores = (entries: [ClusterMember, number | null][]) => new Map(entries.map(([m, s]) => [m.nodeId, s]));

  it("stays on a server that answers and is not overloaded", () => {
    expect(chooseMember(members, scores([[a, 0.6], [b, 0.1], [c, 0.1]]), a.url)).toBeNull();
  });

  it("leaves a busy server for a free one", () => {
    expect(chooseMember(members, scores([[a, 0.95], [b, 0.45], [c, 0.1]]), a.url)).toBe(c);
  });

  it("spreads boards leaving one busy server over the equally free others", () => {
    const picks = new Set(
      Array.from({ length: 40 }, (_, i) => chooseMember(members, scores([[a, 0.95], [b, 0.1], [c, 0.12]]), a.url, `board-${i}`)?.nodeId),
    );
    expect(picks).toEqual(new Set([b.nodeId, c.nodeId]));
    // The same board always prefers the same server, so it does not bounce between them.
    const once = chooseMember(members, scores([[a, 0.95], [b, 0.1], [c, 0.12]]), a.url, "board-7");
    expect(chooseMember(members, scores([[a, 0.95], [b, 0.1], [c, 0.12]]), a.url, "board-7")).toBe(once);
  });

  it("does not move when every other server is busy too", () => {
    expect(chooseMember(members, scores([[a, 0.95], [b, 0.7], [c, 0.9]]), a.url)).toBeNull();
  });

  it("moves off a server that stopped answering, to the least loaded live one", () => {
    expect(chooseMember(members, scores([[a, null], [b, 0.9], [c, 0.3]]), a.url)).toBe(c);
  });

  it("has nowhere to go when nothing answers", () => {
    expect(chooseMember(members, scores([[a, null], [b, null], [c, null]]), a.url)).toBeNull();
  });
});

describe("member keys", () => {
  it("accepts a node id taken from its key pin, and nothing else", () => {
    const id = "0123456789abcdef01234567";
    expect(nodeIdMatchesPin(id, `sha256/${id}${"f".repeat(40)}`)).toBe(true);
    expect(nodeIdMatchesPin(id, `sha256/${"f".repeat(64)}`)).toBe(false);
    expect(nodeIdMatchesPin(id, "sha1/abc")).toBe(false);
  });
});
