import { describe, expect, it } from "vitest";
import { getDefaultTasksForSubject } from "./subjectConfig";

describe("teacher-managed task cards", () => {
  it("does not ship hardcoded task cards for subjects", () => {
    expect(getDefaultTasksForSubject("algebra")).toEqual([]);
    expect(getDefaultTasksForSubject("physics")).toEqual([]);
    expect(getDefaultTasksForSubject("english")).toEqual([]);
  });
});

