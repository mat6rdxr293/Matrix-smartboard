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

const json = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

async function seedLesson(page: Page, options?: { withGraph?: boolean; captureOps?: unknown[] }) {
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
      const body = request.postDataJSON() as { operations?: unknown[] };
      options?.captureOps?.push(...(body.operations ?? []));
      return json(route, { ok: true, inserted: body.operations?.length ?? 0 });
    }

    if (path === "/api/status") return json(route, { ok: true, ai: true, ocr: true });
    if (path === "/api/storage" && method === "GET") return json(route, { tasks: [], slides: [] });
    if (path === "/api/storage" && method === "POST") return json(route, { ok: true });
    if (path === "/api/ocr" && method === "POST") return json(route, { text: "Решить: x^2 - 4 = 0" });

    if (path === "/api/ai" && method === "POST") {
      const payload = request.postDataJSON() as { mode?: string; board_output?: boolean };
      expect(payload.mode).toBe("solution");
      expect(payload.board_output).toBe(true);
      return json(route, {
        text: "1. Переносим 4.\n2. Разлагаем.\n3. Получаем корни.",
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

async function generateSolution(page: Page) {
  await page.getByTestId("open-ai-assistant").click();
  await page.getByTestId("ai-full-solution").click();
  await expect(page.getByTestId("ocr-confirm")).toBeVisible();
  await page.getByTestId("ocr-confirm").click();
  await expect(page.getByTestId("ai-solution-block")).toBeVisible();
}

test("full solution is written into free board space", async ({ page }) => {
  const appendedOperations: unknown[] = [];
  await seedLesson(page, { withGraph: true, captureOps: appendedOperations });
  await generateSolution(page);

  const solution = page.getByTestId("ai-solution-block");
  await expect(page.getByTestId("ai-solution-step")).toHaveCount(3);
  await expect(solution).toContainText("x=-2");

  const graphBox = await page.locator('[data-graph-interactive="true"]').first().boundingBox();
  const solutionBox = await solution.boundingBox();
  expect(graphBox).not.toBeNull();
  expect(solutionBox).not.toBeNull();

  if (graphBox && solutionBox) {
    const overlaps =
      solutionBox.x < graphBox.x + graphBox.width &&
      solutionBox.x + solutionBox.width > graphBox.x &&
      solutionBox.y < graphBox.y + graphBox.height &&
      solutionBox.y + solutionBox.height > graphBox.y;
    expect(overlaps).toBe(false);
  }

  await expect.poll(() =>
    appendedOperations.some((operation) =>
      (operation as { op?: string }).op === "solution_add"
    )
  ).toBe(true);
});

test("AI solution participates in undo and redo", async ({ page }) => {
  await seedLesson(page);
  await generateSolution(page);

  await page.getByTestId("board-undo").click();
  await expect(page.getByTestId("ai-solution-block")).toHaveCount(0);

  await page.getByTestId("board-redo").click();
  await expect(page.getByTestId("ai-solution-block")).toBeVisible();
});
