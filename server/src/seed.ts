import { listProjects, createProject, createCase, type Priority } from "./db.js";

// Seed a default project + starter cases on first run so the board isn't empty.
const SEED: Array<{
  title: string;
  priority: Priority;
  reason: string;
  status: "passed" | "failed" | "notRun";
  code?: string;
  steps: string[];
}> = [
  { title: "Guest checkout with credit card", priority: "P0", reason: "Touches payment, reachable in 2 clicks", status: "passed", code: "await agent.aiAction('click Buy now')\nawait agent.aiAssert('order placed')", steps: ["Open product page", 'Click "Buy now"', "Fill card details", "Confirm order"] },
  { title: "User login with valid credentials", priority: "P0", reason: "Auth gate, blocks all logged-in flows", status: "failed", code: "await agent.aiAction('sign in')\nawait agent.aiAssert('dashboard visible')", steps: ["Open login page", "Enter email and password", "Click sign in"] },
  { title: "Add item to cart from search", priority: "P0", reason: "Core discovery-to-cart path", status: "notRun", steps: ["Search a keyword", "Open first result", "Add to cart"] },
  { title: "Apply discount coupon at checkout", priority: "P1", reason: "Revenue-affecting, secondary path", status: "passed", code: "await agent.aiAction('apply coupon SAVE10')", steps: ["Go to checkout", "Enter coupon code", "Verify discount"] },
  { title: "Edit shipping address in profile", priority: "P1", reason: "Account settings, medium impact", status: "notRun", code: "await agent.aiAction('open addresses')", steps: ["Open profile > addresses"] },
  { title: "Filter products by category", priority: "P1", reason: "Browsing convenience", status: "notRun", steps: ["Select a category filter"] },
  { title: "Toggle newsletter subscription", priority: "P2", reason: "Low-traffic settings toggle", status: "notRun", steps: ["Open notification settings"] },
  { title: "Change UI language to Spanish", priority: "P2", reason: "Localization, non-critical", status: "notRun", code: "await agent.aiAction('switch language to Spanish')", steps: ["Open language menu"] },
];

export function seedIfEmpty(): void {
  // Demo seed is OPT-IN: the app starts as a genuinely empty workspace. Set
  // TESTPILOT_SEED_DEMO=1 to populate the sample "Acme Shop" + "Docs portal" projects.
  if (process.env.TESTPILOT_SEED_DEMO !== "1") return;
  if (listProjects().length > 0) return;
  const project = createProject("Acme Shop", "https://shop.acme.com");
  for (const s of SEED) {
    createCase({
      projectId: project.id,
      title: s.title,
      priority: s.priority,
      priorityReason: s.reason,
      runStatus: s.status,
      hasCode: !!s.code,
      code: s.code,
      steps: s.steps.map((t, i) => ({ order: i + 1, text: t })),
    });
  }
  createProject("Docs portal", "https://docs.acme.com");
}
