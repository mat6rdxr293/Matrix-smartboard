import { describe, expect, it } from "vitest";

import { getSubjectsForGrade } from "./curriculum";


const idsFor = (grade: number) => getSubjectsForGrade(grade).map((subject) => subject.id);

describe("Kazakhstan curriculum subject matrix", () => {
  it("changes language availability between grades 2 and 3", () => {
    expect(idsFor(2)).toEqual(["math", "natural_science", "kazakh", "russian"]);
    expect(idsFor(3)).toEqual(["math", "natural_science", "kazakh", "russian", "english"]);
  });

  it("replaces math and natural science with separate secondary subjects in grade 7", () => {
    expect(idsFor(6)).toContain("natural_science");
    expect(idsFor(7)).toEqual([
      "algebra",
      "geometry",
      "physics",
      "chemistry",
      "biology",
      "geography",
      "kazakh",
      "russian",
      "english",
    ]);
  });

  it("rejects grades outside 1 through 11", () => {
    expect(() => getSubjectsForGrade(0)).toThrow("between 1 and 11");
    expect(() => getSubjectsForGrade(12)).toThrow("between 1 and 11");
  });
});
