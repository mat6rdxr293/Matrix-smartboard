import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionApi } from "./api";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("sessionApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the school auth routes with same-origin credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ school: { id: "s1", name: "Школа №11", createdAt: 1 } }, 201))
      .mockResolvedValueOnce(jsonResponse({ school: { id: "s1", name: "Школа №11", createdAt: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await sessionApi.register("Школа №11", "password11");
    await sessionApi.login("Школа №11", "password11");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/register-school",
      expect.objectContaining({ credentials: "same-origin", method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/auth/login-school",
      expect.objectContaining({ credentials: "same-origin", method: "POST" }),
    );
  });

  it("loads the session and creates and lists rooms", async () => {
    const school = { id: "s1", name: "Школа №11", createdAt: 1 };
    const room = { id: "r1", schoolId: "s1", name: "20", createdAt: 2 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ school }))
      .mockResolvedValueOnce(jsonResponse({ items: [room] }))
      .mockResolvedValueOnce(jsonResponse({ room }, 201));
    vi.stubGlobal("fetch", fetchMock);

    expect(await sessionApi.currentSchool()).toEqual(school);
    expect(await sessionApi.listRooms()).toEqual([room]);
    expect(await sessionApi.createRoom("20")).toEqual(room);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/auth/session", expect.objectContaining({ credentials: "same-origin" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/rooms", expect.objectContaining({ credentials: "same-origin" }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/rooms",
      expect.objectContaining({ credentials: "same-origin", method: "POST" }),
    );
  });
});
