export const GRADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;

export type Grade = (typeof GRADES)[number];

export type CurriculumSubjectId =
  | "math"
  | "natural_science"
  | "algebra"
  | "geometry"
  | "physics"
  | "chemistry"
  | "biology"
  | "geography"
  | "kazakh"
  | "russian"
  | "english";

export type SubjectOption = {
  id: CurriculumSubjectId;
  nameRu: string;
  nameKk: string;
  nameEn: string;
  accent: string;
};

const SUBJECTS: Record<CurriculumSubjectId, SubjectOption> = {
  math: { id: "math", nameRu: "Математика", nameKk: "Математика", nameEn: "Mathematics", accent: "#5BE7C4" },
  natural_science: { id: "natural_science", nameRu: "Естествознание", nameKk: "Жаратылыстану", nameEn: "Natural Science", accent: "#7CFFB2" },
  algebra: { id: "algebra", nameRu: "Алгебра", nameKk: "Алгебра", nameEn: "Algebra", accent: "#5BE7C4" },
  geometry: { id: "geometry", nameRu: "Геометрия", nameKk: "Геометрия", nameEn: "Geometry", accent: "#9EEBFF" },
  physics: { id: "physics", nameRu: "Физика", nameKk: "Физика", nameEn: "Physics", accent: "#4DA3FF" },
  chemistry: { id: "chemistry", nameRu: "Химия", nameKk: "Химия", nameEn: "Chemistry", accent: "#FFB86B" },
  biology: { id: "biology", nameRu: "Биология", nameKk: "Биология", nameEn: "Biology", accent: "#7CFFB2" },
  geography: { id: "geography", nameRu: "География", nameKk: "География", nameEn: "Geography", accent: "#F6D365" },
  kazakh: { id: "kazakh", nameRu: "Казахский язык", nameKk: "Қазақ тілі", nameEn: "Kazakh Language", accent: "#5BE7C4" },
  russian: { id: "russian", nameRu: "Русский язык", nameKk: "Орыс тілі", nameEn: "Russian Language", accent: "#9EEBFF" },
  english: { id: "english", nameRu: "Английский язык", nameKk: "Ағылшын тілі", nameEn: "English Language", accent: "#FF8FA3" },
};

const PRIMARY: CurriculumSubjectId[] = ["math", "natural_science", "kazakh", "russian"];
const PRIMARY_WITH_ENGLISH: CurriculumSubjectId[] = [...PRIMARY, "english"];
const SECONDARY: CurriculumSubjectId[] = [
  "algebra",
  "geometry",
  "physics",
  "chemistry",
  "biology",
  "geography",
  "kazakh",
  "russian",
  "english",
];

export function getSubjectsForGrade(grade: number): SubjectOption[] {
  if (!Number.isInteger(grade) || grade < 1 || grade > 11) {
    throw new Error("grade must be between 1 and 11");
  }
  const ids = grade <= 2 ? PRIMARY : grade <= 6 ? PRIMARY_WITH_ENGLISH : SECONDARY;
  return ids.map((id) => SUBJECTS[id]);
}
