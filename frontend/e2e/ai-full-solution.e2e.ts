import { expect, test, type Page, type Route } from "@playwright/test";

const school = {
  id: "school-e2e",
  name: "Matrix E2E",
  createdAt: 1_790_000_000_000,
};

const room = {
  id: "room-e2e",
  schoolId: school.id,
  name: "11A",
  createdAt: 1_790_000_000_000,
};

const lesson = {
  id: "lesson-e2e",
  schoolId: school.id,
  roomId: room.id,
  roomName: room.name,
  grade: 11,
  subjectId: "algebra",
  status: "active",
  startedAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_000,
  endedAt: null,
};

const graph = {
  id: "graph-e2e",
  x: 720,
  y: 120,
  width: 420,
  height: 300,
  xLabel: "x",
  yLabel: "y",
  xMin: -10,
  xMax: 10,
  yMin: -10,
  yMax: 10,
  expressions: [
    { id: "expr-e2e", expression: "x^2", color: "#4DA3FF", visible: true },
  ],
};

type CapturedOp = {
  op?: string;
  strokes?: Array<{
    points: Array<{ x: number; y: number }>;
    color: string;
    width: number;
    mode: string;
  }>;
};

const json = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

async function seedLesson(page: Page, options?: { withGraph?: boolean; captureOps?: CapturedOp[] }) {
  await page.addInitScript(({ schoolId, roomId, lessonId }) => {
    localStorage.setItem("practice.room." + schoolId, roomId);
    localStorage.setItem("practice.lesson." + lessonId + ".boardProfile", "universal");
  }, { schoolId: school.id, roomId: room.id, lessonId: lesson.id });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/auth/session") return json(route, { school });
    if (path === "/api/rooms" && method === "GET") return json(route, { items: [room] });
    if (path === "/api/rooms/" + room.id + "/active-lesson") return json(route, { lesson });
    if (path === "/api/lessons/" + lesson.id + "/resume" && method === "POST") return json(route, { lesson });
    if (path === "/api/lessons/" + lesson.id + "/chat") return json(route, { items: [] });

    if (path === "/api/lessons/" + lesson.id + "/board" && method === "GET") {
      return json(route, {
        operations: options?.withGraph
          ? [{ sequence: 1, clientOperationId: "graph-op-e2e", op: "graph_add", graph, ts: 100 }]
          : [],
      });
    }

    if (path === "/api/lessons/" + lesson.id + "/board/operations" && method === "POST") {
      const body = request.postDataJSON() as { operations?: CapturedOp[] };
      options?.captureOps?.push(...(body.operations ?? []));
      return json(route, { ok: true, inserted: body.operations?.length ?? 0 });
    }

    if (path === "/api/status") return json(route, { ok: true, ai: true, ocr: true });
    if (path === "/api/storage" && method === "GET") return json(route, { tasks: [], slides: [] });
    if (path === "/api/storage" && method === "POST") return json(route, { ok: true });
    if (path === "/api/ocr" && method === "POST") return json(route, { text: "Решить: x^2 - 4 = 0" });

    if (path === "/api/ai" && method === "POST") {
      const payload = request.postDataJSON() as { mode?: string; board_output?: boolean; response_locale?: string };
      expect(payload.mode).toBe("solution");
      expect(payload.board_output).toBe(true);
      expect(payload.response_locale).toBe("ru");
      return json(route, {
        text: "Решение",
        steps: [
          { text: "$$x^2 - 4 = 0$$", kind: "math" },
          { text: "$$(x-2)(x+2)=0$$", kind: "math" },
          { text: "$$x=-2,\\;2$$", kind: "result" },
        ],
      });
    }

    return json(route, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Вернуться к уроку" }).click();
  await expect(page.getByTestId("board-canvas-root")).toBeVisible();
}

async function generateSolution(page: Page, operations: CapturedOp[]) {
  await page.getByTestId("open-ai-assistant").click();
  await page.getByTestId("ai-full-solution").click();
  await expect(page.getByTestId("ocr-confirm")).toBeVisible();
  await page.getByTestId("ocr-confirm").click();

  await expect.poll(() =>
    operations.find((operation) => operation.op === "stroke_batch_add")?.strokes?.length ?? 0,
    { timeout: 20_000 },
  ).toBeGreaterThan(8);
}

test("full solution is handwriting strokes placed away from an existing graph", async ({ page }) => {
  const operations: CapturedOp[] = [];
  await seedLesson(page, { withGraph: true, captureOps: operations });
  await generateSolution(page, operations);

  await expect(page.getByTestId("ai-solution-block")).toHaveCount(0);

  const batch = operations.find((operation) => operation.op === "stroke_batch_add");
  expect(batch?.strokes?.length).toBeGreaterThan(8);

  const points = batch?.strokes?.flatMap((stroke) => stroke.points) ?? [];
  expect(points.length).toBeGreaterThan(30);

  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));

  const overlapsGraph =
    left < graph.x + graph.width &&
    right > graph.x &&
    top < graph.y + graph.height &&
    bottom > graph.y;
  expect(overlapsGraph).toBe(false);
});

test("one undo removes the whole AI handwriting batch and redo restores it", async ({ page }) => {
  const operations: CapturedOp[] = [];
  await seedLesson(page, { captureOps: operations });
  await generateSolution(page, operations);

  await page.getByTestId("board-undo").evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => operations.some((operation) => operation.op === "undo")).toBe(true);

  await page.getByTestId("board-redo").evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => operations.some((operation) => operation.op === "redo")).toBe(true);

  expect(operations.filter((operation) => operation.op === "stroke_batch_add")).toHaveLength(1);
});
