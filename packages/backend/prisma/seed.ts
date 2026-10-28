import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
import {
  SEED_PASSWORD,
  SEED_USER_EMAILS,
  SEED_WORKSPACE_SLUGS,
  countVerifiedSeedUsers,
  decideSeed,
  environmentRefusal,
} from "./seed-guard.js";

const prisma = new PrismaClient();

const SALT_ROUNDS = 12;

class SeedRefused extends Error {}

async function main() {
  // Refuse before any database connection is made.
  const refusal = environmentRefusal(process.env.NODE_ENV);
  if (refusal) throw new SeedRefused(refusal);

  const [users, seedAddressUsers, workspaces, seedWorkspaces] = await Promise.all([
    prisma.user.count(),
    prisma.user.findMany({
      where: { email: { in: [...SEED_USER_EMAILS] } },
      select: { passwordHash: true },
    }),
    prisma.workspace.count(),
    prisma.workspace.count({ where: { slug: { in: [...SEED_WORKSPACE_SLUGS] } } }),
  ]);
  const seedUsers = await countVerifiedSeedUsers(seedAddressUsers, bcrypt.compare);
  const decision = decideSeed(
    { users, seedUsers, workspaces, seedWorkspaces },
    process.env.SEED_FORCE === "true",
  );

  if (decision.action === "refuse") throw new SeedRefused(decision.reason);
  if (decision.action === "skip") {
    console.log(decision.reason);
    return;
  }

  if (decision.action === "reseed") {
    // decideSeed only allows this when every account is a seed address that
    // still has the published seed password and every workspace is a seed
    // workspace, so all remaining data belongs to the demo accounts.
    console.log("SEED_FORCE=true: Cleaning existing seed data...");
    // Delete in order respecting constraints
    // Wiki tables (best-effort — may not exist if migrations haven't been applied)
    await prisma.wikiPageShare.deleteMany().catch(() => {});
    await prisma.wikiPageComment.deleteMany().catch(() => {});
    await prisma.wikiPageVersion.deleteMany().catch(() => {});
    await prisma.wikiPageLock.deleteMany().catch(() => {});
    await prisma.wikiPage.deleteMany().catch(() => {});
    await prisma.wikiSpace.deleteMany().catch(() => {});
    await prisma.activityLog.deleteMany();
    await prisma.taskDependency.deleteMany();
    await prisma.taskLabel.deleteMany();
    await prisma.taskAssignee.deleteMany();
    await prisma.subtask.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.task.deleteMany();
    await prisma.label.deleteMany();
    await prisma.statusColumn.deleteMany();
    await prisma.projectMember.deleteMany();
    await prisma.project.deleteMany();
    await prisma.workspaceInvite.deleteMany();
    await prisma.workspaceMember.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.rotatedRefreshToken.deleteMany();
    await prisma.passwordResetToken.deleteMany();
    await prisma.emailVerificationToken.deleteMany();
    await prisma.loginAttempt.deleteMany();
    await prisma.user.deleteMany();
  }

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, SALT_ROUNDS);

  // ─── Users ───────────────────────────────────────────
  console.log("Creating users...");

  const [alice, bob, charlie, diana, eve] = await Promise.all([
    prisma.user.create({
      data: {
        email: "alice@test.com",
        passwordHash,
        displayName: "Alice Johnson",
        emailVerified: true,
        isInstanceAdmin: true,
      },
    }),
    prisma.user.create({
      data: {
        email: "bob@test.com",
        passwordHash,
        displayName: "Bob Smith",
        emailVerified: true,
      },
    }),
    prisma.user.create({
      data: {
        email: "charlie@test.com",
        passwordHash,
        displayName: "Charlie Brown",
        emailVerified: true,
      },
    }),
    prisma.user.create({
      data: {
        email: "diana@test.com",
        passwordHash,
        displayName: "Diana Prince",
        emailVerified: false, // Diana is unverified
      },
    }),
    prisma.user.create({
      data: {
        email: "eve@test.com",
        passwordHash,
        displayName: "Eve Wilson",
        emailVerified: true,
      },
    }),
  ]);

  // ─── Workspaces ──────────────────────────────────────
  console.log("Creating workspaces...");

  const acmeCorp = await prisma.workspace.create({
    data: { name: "Acme Corp", slug: "acme-corp" },
  });

  const sideProject = await prisma.workspace.create({
    data: { name: "Side Project", slug: "side-project" },
  });

  // ─── Workspace Members ───────────────────────────────
  console.log("Adding workspace members...");

  // Acme Corp: Alice(ADMIN), Bob(MEMBER), Charlie(MEMBER), Diana(VIEWER)
  await Promise.all([
    prisma.workspaceMember.create({
      data: { userId: alice.id, workspaceId: acmeCorp.id, role: "ADMIN" },
    }),
    prisma.workspaceMember.create({
      data: { userId: bob.id, workspaceId: acmeCorp.id, role: "MEMBER" },
    }),
    prisma.workspaceMember.create({
      data: { userId: charlie.id, workspaceId: acmeCorp.id, role: "MEMBER" },
    }),
    prisma.workspaceMember.create({
      data: { userId: diana.id, workspaceId: acmeCorp.id, role: "VIEWER" },
    }),
  ]);

  // Side Project: Alice(ADMIN), Eve(MEMBER)
  await Promise.all([
    prisma.workspaceMember.create({
      data: { userId: alice.id, workspaceId: sideProject.id, role: "ADMIN" },
    }),
    prisma.workspaceMember.create({
      data: { userId: eve.id, workspaceId: sideProject.id, role: "MEMBER" },
    }),
  ]);

  // ─── Projects ────────────────────────────────────────
  console.log("Creating projects...");

  const websiteRedesign = await prisma.project.create({
    data: {
      workspaceId: acmeCorp.id,
      name: "Website Redesign",
      description: "Complete overhaul of the company website",
      color: "#6366f1",
    },
  });

  const mobileApp = await prisma.project.create({
    data: {
      workspaceId: acmeCorp.id,
      name: "Mobile App",
      description: "Native mobile application for iOS and Android",
      color: "#f59e0b",
    },
  });

  const blog = await prisma.project.create({
    data: {
      workspaceId: sideProject.id,
      name: "Blog",
      description: "Personal blog with articles and tutorials",
      color: "#10b981",
    },
  });

  // ─── Project Members ─────────────────────────────────
  console.log("Adding project members...");

  // Website Redesign: Alice, Bob, Charlie
  await Promise.all([
    prisma.projectMember.create({
      data: { projectId: websiteRedesign.id, userId: alice.id },
    }),
    prisma.projectMember.create({
      data: { projectId: websiteRedesign.id, userId: bob.id },
    }),
    prisma.projectMember.create({
      data: { projectId: websiteRedesign.id, userId: charlie.id },
    }),
  ]);

  // Mobile App: Alice, Bob
  await Promise.all([
    prisma.projectMember.create({
      data: { projectId: mobileApp.id, userId: alice.id },
    }),
    prisma.projectMember.create({
      data: { projectId: mobileApp.id, userId: bob.id },
    }),
  ]);

  // Blog: Alice, Eve
  await Promise.all([
    prisma.projectMember.create({
      data: { projectId: blog.id, userId: alice.id },
    }),
    prisma.projectMember.create({
      data: { projectId: blog.id, userId: eve.id },
    }),
  ]);

  // ─── Status Columns ──────────────────────────────────
  console.log("Creating status columns...");

  const createStatuses = async (projectId: string) => {
    const todo = await prisma.statusColumn.create({
      data: { projectId, name: "To Do", color: "#94a3b8", position: 0 },
    });
    const inProgress = await prisma.statusColumn.create({
      data: { projectId, name: "In Progress", color: "#3b82f6", position: 1 },
    });
    const done = await prisma.statusColumn.create({
      data: {
        projectId,
        name: "Done",
        color: "#22c55e",
        position: 2,
        isCompletion: true,
      },
    });
    return { todo, inProgress, done };
  };

  const wrStatuses = await createStatuses(websiteRedesign.id);
  const maStatuses = await createStatuses(mobileApp.id);
  const blogStatuses = await createStatuses(blog.id);

  // ─── Labels ──────────────────────────────────────────
  console.log("Creating labels...");

  const [wrBug, wrFeature, wrDesign, wrUrgent] = await Promise.all([
    prisma.label.create({
      data: { projectId: websiteRedesign.id, name: "Bug", color: "#ef4444" },
    }),
    prisma.label.create({
      data: { projectId: websiteRedesign.id, name: "Feature", color: "#3b82f6" },
    }),
    prisma.label.create({
      data: { projectId: websiteRedesign.id, name: "Design", color: "#8b5cf6" },
    }),
    prisma.label.create({
      data: { projectId: websiteRedesign.id, name: "Urgent", color: "#f59e0b" },
    }),
  ]);

  const [maBug, maFeature, maIOS, maAndroid] = await Promise.all([
    prisma.label.create({
      data: { projectId: mobileApp.id, name: "Bug", color: "#ef4444" },
    }),
    prisma.label.create({
      data: { projectId: mobileApp.id, name: "Feature", color: "#3b82f6" },
    }),
    prisma.label.create({
      data: { projectId: mobileApp.id, name: "iOS", color: "#6366f1" },
    }),
    prisma.label.create({
      data: { projectId: mobileApp.id, name: "Android", color: "#22c55e" },
    }),
  ]);

  const [blogContent, blogTech, blogSEO] = await Promise.all([
    prisma.label.create({
      data: { projectId: blog.id, name: "Content", color: "#f59e0b" },
    }),
    prisma.label.create({
      data: { projectId: blog.id, name: "Technical", color: "#3b82f6" },
    }),
    prisma.label.create({
      data: { projectId: blog.id, name: "SEO", color: "#10b981" },
    }),
  ]);

  // ─── Tasks ───────────────────────────────────────────
  console.log("Creating tasks...");

  // Helper to create task with related data
  async function createTask(opts: {
    projectId: string;
    statusId: string;
    title: string;
    description?: string;
    priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    position: number;
    dueDate?: string;
    assigneeIds?: string[];
    labelIds?: string[];
  }) {
    const task = await prisma.task.create({
      data: {
        projectId: opts.projectId,
        statusId: opts.statusId,
        title: opts.title,
        description: opts.description,
        priority: opts.priority,
        position: opts.position,
        dueDate: opts.dueDate,
      },
    });

    if (opts.assigneeIds?.length) {
      await prisma.taskAssignee.createMany({
        data: opts.assigneeIds.map((userId) => ({
          taskId: task.id,
          userId,
        })),
      });
    }

    if (opts.labelIds?.length) {
      await prisma.taskLabel.createMany({
        data: opts.labelIds.map((labelId) => ({
          taskId: task.id,
          labelId,
        })),
      });
    }

    await prisma.activityLog.create({
      data: {
        taskId: task.id,
        actorId: alice.id,
        action: "created",
      },
    });

    return task;
  }

  // ── Website Redesign Tasks ───────────────────────────

  const wrTask1 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.todo.id,
    title: "Design new homepage layout",
    description: "Create wireframes and mockups for the new homepage",
    priority: "HIGH",
    position: 0,
    dueDate: "2026-03-01",
    assigneeIds: [alice.id, bob.id],
    labelIds: [wrDesign.id, wrFeature.id],
  });

  const wrTask2 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.todo.id,
    title: "Implement responsive navigation",
    description: "Build a mobile-friendly navigation menu with hamburger toggle",
    priority: "MEDIUM",
    position: 1,
    dueDate: "2026-03-10",
    assigneeIds: [bob.id],
    labelIds: [wrFeature.id],
  });

  const wrTask3 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.todo.id,
    title: "Set up analytics tracking",
    priority: "LOW",
    position: 2,
    assigneeIds: [charlie.id],
  });

  const wrTask4 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.inProgress.id,
    title: "Migrate content to new CMS",
    description: "Transfer all existing blog posts and pages to the new CMS",
    priority: "HIGH",
    position: 0,
    dueDate: "2026-02-20",
    assigneeIds: [alice.id],
    labelIds: [wrFeature.id],
  });

  const wrTask5 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.inProgress.id,
    title: "Fix broken image links",
    priority: "URGENT",
    position: 1,
    assigneeIds: [bob.id],
    labelIds: [wrBug.id, wrUrgent.id],
  });

  const wrTask6 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.inProgress.id,
    title: "Create contact form with validation",
    description: "Build a contact form with client and server-side validation",
    priority: "MEDIUM",
    position: 2,
    dueDate: "2026-02-28",
    assigneeIds: [charlie.id],
    labelIds: [wrFeature.id],
  });

  const wrTask7 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.done.id,
    title: "Set up project repository",
    priority: "HIGH",
    position: 0,
    assigneeIds: [alice.id],
  });

  const wrTask8 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.done.id,
    title: "Configure CI/CD pipeline",
    priority: "MEDIUM",
    position: 1,
    assigneeIds: [alice.id, bob.id],
  });

  const wrTask9 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.todo.id,
    title: "Optimize images for web",
    description: "Compress and convert images to WebP format",
    priority: "LOW",
    position: 3,
    dueDate: "2026-03-15",
    assigneeIds: [charlie.id],
    labelIds: [wrDesign.id],
  });

  const wrTask10 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.todo.id,
    title: "Write accessibility audit report",
    priority: "MEDIUM",
    position: 4,
    dueDate: "2026-03-20",
    assigneeIds: [bob.id],
  });

  // ── Mobile App Tasks ─────────────────────────────────

  const maTask1 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.todo.id,
    title: "Design onboarding flow",
    description: "Create screens for first-time user experience",
    priority: "HIGH",
    position: 0,
    dueDate: "2026-03-05",
    assigneeIds: [alice.id],
    labelIds: [maFeature.id, maIOS.id, maAndroid.id],
  });

  const maTask2 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.todo.id,
    title: "Implement push notifications",
    priority: "MEDIUM",
    position: 1,
    dueDate: "2026-03-15",
    assigneeIds: [bob.id],
    labelIds: [maFeature.id],
  });

  const maTask3 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.todo.id,
    title: "Fix login crash on Android 14",
    priority: "URGENT",
    position: 2,
    assigneeIds: [bob.id],
    labelIds: [maBug.id, maAndroid.id],
  });

  const maTask4 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.inProgress.id,
    title: "Build user profile screen",
    description: "User can view and edit their profile info",
    priority: "MEDIUM",
    position: 0,
    dueDate: "2026-02-25",
    assigneeIds: [alice.id, bob.id],
    labelIds: [maFeature.id],
  });

  const maTask5 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.inProgress.id,
    title: "Integrate payment SDK",
    priority: "HIGH",
    position: 1,
    dueDate: "2026-03-01",
    assigneeIds: [bob.id],
    labelIds: [maFeature.id, maIOS.id, maAndroid.id],
  });

  const maTask6 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.done.id,
    title: "Set up React Native project",
    priority: "HIGH",
    position: 0,
    assigneeIds: [alice.id],
  });

  const maTask7 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.done.id,
    title: "Configure app signing",
    priority: "MEDIUM",
    position: 1,
    assigneeIds: [alice.id],
    labelIds: [maIOS.id, maAndroid.id],
  });

  const maTask8 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.todo.id,
    title: "Add offline data sync",
    description: "Implement local SQLite storage with cloud sync",
    priority: "LOW",
    position: 3,
    dueDate: "2026-04-01",
    assigneeIds: [bob.id],
    labelIds: [maFeature.id],
  });

  // ── Blog Tasks ───────────────────────────────────────

  const blogTask1 = await createTask({
    projectId: blog.id,
    statusId: blogStatuses.todo.id,
    title: "Write intro post about the blog",
    description: "Welcome post explaining what the blog will cover",
    priority: "HIGH",
    position: 0,
    dueDate: "2026-02-15",
    assigneeIds: [alice.id],
    labelIds: [blogContent.id],
  });

  const blogTask2 = await createTask({
    projectId: blog.id,
    statusId: blogStatuses.todo.id,
    title: "Set up RSS feed",
    priority: "LOW",
    position: 1,
    assigneeIds: [eve.id],
    labelIds: [blogTech.id],
  });

  const blogTask3 = await createTask({
    projectId: blog.id,
    statusId: blogStatuses.todo.id,
    title: "Research SEO best practices",
    priority: "MEDIUM",
    position: 2,
    dueDate: "2026-02-28",
    assigneeIds: [eve.id],
    labelIds: [blogSEO.id],
  });

  const blogTask4 = await createTask({
    projectId: blog.id,
    statusId: blogStatuses.inProgress.id,
    title: "Design blog theme",
    description: "Create a clean, readable blog theme with dark mode support",
    priority: "HIGH",
    position: 0,
    dueDate: "2026-02-20",
    assigneeIds: [alice.id, eve.id],
    labelIds: [blogTech.id],
  });

  const blogTask5 = await createTask({
    projectId: blog.id,
    statusId: blogStatuses.done.id,
    title: "Set up blog repository",
    priority: "HIGH",
    position: 0,
    assigneeIds: [alice.id],
    labelIds: [blogTech.id],
  });

  const blogTask6 = await createTask({
    projectId: blog.id,
    statusId: blogStatuses.todo.id,
    title: "Write tutorial on TypeScript generics",
    priority: "MEDIUM",
    position: 3,
    dueDate: "2026-03-10",
    assigneeIds: [alice.id],
    labelIds: [blogContent.id, blogTech.id],
  });

  const blogTask7 = await createTask({
    projectId: blog.id,
    statusId: blogStatuses.todo.id,
    title: "Add comments system",
    priority: "LOW",
    position: 4,
    assigneeIds: [eve.id],
    labelIds: [blogTech.id],
  });

  const maTask9 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.todo.id,
    title: "Design settings screen",
    priority: "LOW",
    position: 4,
    dueDate: "2026-04-10",
    assigneeIds: [alice.id],
    labelIds: [maFeature.id, maIOS.id, maAndroid.id],
  });

  const maTask10 = await createTask({
    projectId: mobileApp.id,
    statusId: maStatuses.inProgress.id,
    title: "Fix memory leak in image cache",
    priority: "HIGH",
    position: 2,
    assigneeIds: [bob.id],
    labelIds: [maBug.id],
  });

  const blogTask8 = await createTask({
    projectId: blog.id,
    statusId: blogStatuses.inProgress.id,
    title: "Write article on React performance",
    description: "Deep dive into React rendering optimizations",
    priority: "MEDIUM",
    position: 1,
    dueDate: "2026-03-05",
    assigneeIds: [alice.id],
    labelIds: [blogContent.id, blogTech.id],
  });

  const wrTask11 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.inProgress.id,
    title: "Implement dark mode support",
    description: "Add CSS variables and theme toggle for dark mode",
    priority: "MEDIUM",
    position: 3,
    dueDate: "2026-03-05",
    assigneeIds: [bob.id, charlie.id],
    labelIds: [wrFeature.id, wrDesign.id],
  });

  const wrTask12 = await createTask({
    projectId: websiteRedesign.id,
    statusId: wrStatuses.done.id,
    title: "Design system documentation",
    priority: "LOW",
    position: 2,
    assigneeIds: [alice.id],
    labelIds: [wrDesign.id],
  });

  // ─── Subtasks ────────────────────────────────────────
  console.log("Creating subtasks...");

  await Promise.all([
    prisma.subtask.create({
      data: {
        taskId: wrTask1.id,
        title: "Create wireframes",
        position: 0,
        completed: true,
        assigneeId: alice.id,
      },
    }),
    prisma.subtask.create({
      data: {
        taskId: wrTask1.id,
        title: "Design mockups in Figma",
        position: 1,
        completed: false,
        assigneeId: bob.id,
      },
    }),
    prisma.subtask.create({
      data: {
        taskId: wrTask1.id,
        title: "Get stakeholder approval",
        position: 2,
        completed: false,
      },
    }),
    prisma.subtask.create({
      data: {
        taskId: maTask4.id,
        title: "Build UI components",
        position: 0,
        completed: true,
        assigneeId: alice.id,
      },
    }),
    prisma.subtask.create({
      data: {
        taskId: maTask4.id,
        title: "Connect to profile API",
        position: 1,
        completed: false,
        assigneeId: bob.id,
      },
    }),
    prisma.subtask.create({
      data: {
        taskId: blogTask4.id,
        title: "Choose color palette",
        position: 0,
        completed: true,
        assigneeId: alice.id,
      },
    }),
    prisma.subtask.create({
      data: {
        taskId: blogTask4.id,
        title: "Implement dark mode toggle",
        position: 1,
        completed: false,
        assigneeId: eve.id,
      },
    }),
  ]);

  // ─── Task Dependencies ───────────────────────────────
  console.log("Creating task dependencies...");

  await Promise.all([
    // "Implement responsive navigation" blocked by "Design new homepage layout"
    prisma.taskDependency.create({
      data: {
        blockedTaskId: wrTask2.id,
        blockingTaskId: wrTask1.id,
      },
    }),
    // "Push notifications" blocked by "Build user profile screen"
    prisma.taskDependency.create({
      data: {
        blockedTaskId: maTask2.id,
        blockingTaskId: maTask4.id,
      },
    }),
    // "Write intro post" blocked by "Design blog theme"
    prisma.taskDependency.create({
      data: {
        blockedTaskId: blogTask1.id,
        blockingTaskId: blogTask4.id,
      },
    }),
  ]);

  // ─── Wiki / Knowledge Base ──────────────────────────────
  // Wrapped in try/catch — wiki tables may not exist if migrations haven't been applied
  try {
  console.log("Creating wiki spaces and pages...");

  // Helper to create BlockNote blocks
  let blockCounter = 0;
  function bid() {
    return `seed-block-${++blockCounter}`;
  }
  function heading(text: string, level: number = 2) {
    return {
      id: bid(),
      type: "heading",
      props: {
        textColor: "default",
        backgroundColor: "default",
        textAlignment: "left",
        level,
      },
      content: [{ type: "text", text, styles: {} }],
      children: [],
    };
  }
  function paragraph(text: string) {
    return {
      id: bid(),
      type: "paragraph",
      props: {
        textColor: "default",
        backgroundColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text, styles: {} }],
      children: [],
    };
  }
  function richParagraph(
    parts: Array<{ text: string; bold?: boolean; italic?: boolean }>,
  ) {
    return {
      id: bid(),
      type: "paragraph",
      props: {
        textColor: "default",
        backgroundColor: "default",
        textAlignment: "left",
      },
      content: parts.map((p) => ({
        type: "text" as const,
        text: p.text,
        styles: {
          ...(p.bold ? { bold: true } : {}),
          ...(p.italic ? { italic: true } : {}),
        },
      })),
      children: [],
    };
  }
  function bullet(text: string) {
    return {
      id: bid(),
      type: "bulletListItem",
      props: {
        textColor: "default",
        backgroundColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text, styles: {} }],
      children: [],
    };
  }
  function numbered(text: string) {
    return {
      id: bid(),
      type: "numberedListItem",
      props: {
        textColor: "default",
        backgroundColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text, styles: {} }],
      children: [],
    };
  }

  // Create "Product Guide" space in Acme Corp workspace
  const guideSpace = await prisma.wikiSpace.create({
    data: {
      workspaceId: acmeCorp.id,
      name: "Product Guide",
      slug: "product-guide",
      description: "Complete guide to using the project management app",
      icon: "📖",
      position: 0,
    },
  });

  // Create "Engineering" space in Acme Corp workspace
  const engSpace = await prisma.wikiSpace.create({
    data: {
      workspaceId: acmeCorp.id,
      name: "Engineering",
      slug: "engineering",
      description: "Technical docs, architecture decisions, and dev guidelines",
      icon: "⚙️",
      position: 1,
    },
  });

  // ── Product Guide: Root pages ──────────────────────────

  const gettingStartedPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      title: "Getting Started",
      icon: "🚀",
      position: 0,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Welcome to Werkyn", 1),
        paragraph(
          "Werkyn is a project management and collaboration platform designed for modern teams. This guide will walk you through everything you need to know to get up and running.",
        ),
        heading("Quick Overview"),
        paragraph(
          "The app is organized around workspaces. Each workspace contains projects, a knowledge base (wiki), a file drive, and team management tools. Here's what you'll find:",
        ),
        bullet("Dashboard — Your personal overview with tasks, activity, and quick stats"),
        bullet("My Tasks — A focused view of all tasks assigned to you across every project"),
        bullet("Drive — Cloud file storage with folders, uploads, and team folders"),
        bullet("Projects — Kanban boards, task lists, calendars, and timelines for organizing work"),
        bullet("Knowledge Base — Collaborative wiki for documentation, notes, and shared knowledge"),
        heading("First Steps"),
        numbered("Create or join a workspace — Ask your team admin for an invite link, or create a new workspace from the home screen."),
        numbered("Explore the sidebar — The left sidebar is your primary navigation. It shows your projects, wiki spaces, and quick links."),
        numbered("Set up your profile — Click your avatar in the bottom-left corner to update your display name and avatar."),
        numbered("Create your first project — Head to a workspace and click the + button in the Projects section."),
        heading("Keyboard Shortcuts"),
        richParagraph([
          { text: "Cmd/Ctrl + K", bold: true },
          { text: " — Open the search palette to quickly find tasks and wiki pages" },
        ]),
        richParagraph([
          { text: "Cmd/Ctrl + B", bold: true },
          { text: " — Toggle the sidebar" },
        ]),
      ],
    },
  });

  const dashboardPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      title: "Dashboard",
      icon: "📊",
      position: 1,
      createdById: alice.id,
      lastEditedById: bob.id,
      content: [
        heading("Dashboard", 1),
        paragraph(
          "The dashboard is your personal home screen. It gives you a quick overview of your work across all projects in the current workspace.",
        ),
        heading("My Tasks Widget"),
        paragraph(
          "Shows tasks assigned to you, grouped by status. You can click any task to open it in a slide-over panel without leaving the dashboard. Tasks are sorted by due date so the most urgent items appear first.",
        ),
        heading("Recent Activity"),
        paragraph(
          "A live feed of recent activity across your projects — task updates, new comments, status changes, and more. This helps you stay in the loop without checking every project individually.",
        ),
        heading("Project Overview"),
        paragraph(
          "Quick stats for each project you're a member of, including task counts by status and recent progress. Click any project card to jump directly into it.",
        ),
      ],
    },
  });

  const projectsPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      title: "Projects & Tasks",
      icon: "📋",
      position: 2,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Projects & Tasks", 1),
        paragraph(
          "Projects are the core building blocks of your workspace. Each project contains tasks organized across status columns, with support for labels, priorities, due dates, assignees, and more.",
        ),
        heading("Creating a Project"),
        numbered("Click the + button next to 'Projects' in the sidebar."),
        numbered("Give your project a name, optional description, and pick a color."),
        numbered("The project is automatically created with three default status columns: To Do, In Progress, and Done."),
        paragraph(
          "You can customize status columns in Project Settings — rename them, reorder them, change colors, or add new ones.",
        ),
        heading("Task Properties"),
        paragraph("Every task supports a rich set of properties:"),
        bullet("Title — The main task name, visible on the board card"),
        bullet("Description — Rich text body with formatting support"),
        bullet("Status — Which column the task belongs to on the board"),
        bullet("Priority — Urgent, High, Medium, or Low"),
        bullet("Assignees — One or more team members responsible for the task"),
        bullet("Labels — Color-coded tags for categorization (e.g. Bug, Feature, Design)"),
        bullet("Due Date — When the task should be completed"),
        bullet("Start Date — When work should begin (visible on calendar/timeline)"),
        bullet("Subtasks — Checklist items within a task"),
        bullet("Dependencies — Mark tasks that block or are blocked by other tasks"),
        bullet("Comments — Discussion thread on each task with @mention support"),
        bullet("Attachments — Upload files directly to a task"),
        bullet("Custom Fields — Add your own fields (text, number, date, select) per project"),
      ],
    },
  });

  const viewsPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      title: "Views",
      icon: "👁️",
      position: 3,
      createdById: bob.id,
      lastEditedById: bob.id,
      content: [
        heading("Project Views", 1),
        paragraph(
          "Each project can be viewed in multiple ways. Switch between views using the tabs at the top of the project page.",
        ),
        heading("Board View"),
        paragraph(
          "The default Kanban board. Tasks are shown as cards organized into columns by status. Drag and drop cards between columns to change their status, or within a column to reorder them.",
        ),
        richParagraph([
          { text: "Tip: ", bold: true },
          { text: "Click the filter icon to narrow tasks by assignee, priority, or label. Filters persist across sessions." },
        ]),
        heading("List View"),
        paragraph(
          "A table-style view that shows all tasks in a flat list with sortable columns. Great for bulk operations — you can multi-select tasks and update their status, priority, or assignees in one action.",
        ),
        heading("Calendar View"),
        paragraph(
          "Tasks with due dates are displayed on a monthly or weekly calendar. Drag tasks to reschedule them. Tasks without due dates won't appear here, so make sure important work has dates set.",
        ),
        heading("Timeline View"),
        paragraph(
          "A Gantt-style timeline showing tasks as bars based on their start and due dates. Dependencies are drawn as arrows between tasks. This is the best view for understanding project scheduling and identifying bottlenecks.",
        ),
      ],
    },
  });

  const drivePage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      title: "Drive & Files",
      icon: "📁",
      position: 4,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Drive & Files", 1),
        paragraph(
          "The Drive is a shared file storage system for your workspace. Upload documents, images, spreadsheets, and any other files your team needs access to.",
        ),
        heading("File Management"),
        bullet("Upload — Drag and drop files or click the upload button. Multiple files can be uploaded simultaneously."),
        bullet("Folders — Organize files into folders. Create nested folder structures to keep things tidy."),
        bullet("Grid & List views — Toggle between visual grid (thumbnails) and compact list views."),
        bullet("Trash — Deleted files go to trash first. You can restore them or permanently delete."),
        heading("Team Folders"),
        paragraph(
          "Team folders are shared spaces with controlled access. Only workspace admins can create team folders, and they can add specific members. This is useful for department-specific documents or sensitive files.",
        ),
        heading("Task Attachments"),
        paragraph(
          "Files can also be attached directly to tasks. When you attach a file to a task, it's uploaded to the workspace drive and linked to that task. You can view all attachments in the task detail panel.",
        ),
      ],
    },
  });

  const teamPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      title: "Team Management",
      icon: "👥",
      position: 5,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Team Management", 1),
        paragraph(
          "Manage who has access to your workspace and what they can do with roles and permissions.",
        ),
        heading("Roles"),
        paragraph("There are three workspace roles:"),
        richParagraph([
          { text: "Admin", bold: true },
          { text: " — Full access. Can manage members, create/delete projects, configure workspace settings, and delete the workspace." },
        ]),
        richParagraph([
          { text: "Member", bold: true },
          { text: " — Can create and edit tasks, comment, upload files, and work on projects they're added to." },
        ]),
        richParagraph([
          { text: "Viewer", bold: true },
          { text: " — Read-only access. Can view projects and tasks but cannot make changes. Useful for stakeholders who need visibility." },
        ]),
        heading("Inviting Members"),
        numbered("Go to Workspace Settings from the sidebar."),
        numbered("Click 'Invite Members' and enter email addresses."),
        numbered("Choose the role for the new members."),
        numbered("They'll receive an invite link via email. Clicking the link lets them join the workspace."),
        heading("Project Access"),
        paragraph(
          "By default, new projects are visible to all workspace members. Admins see all projects. Members and viewers only see projects they've been explicitly added to.",
        ),
      ],
    },
  });

  const wikiGuidePage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      title: "Knowledge Base",
      icon: "📚",
      position: 6,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Knowledge Base", 1),
        paragraph(
          "The Knowledge Base (wiki) is where your team writes and shares documentation, guides, meeting notes, and any other long-form content. It's organized into spaces with hierarchical pages.",
        ),
        heading("Spaces"),
        paragraph(
          'Spaces are top-level containers for organizing your wiki. You might create spaces for different teams, products, or topics — for example "Product Guide", "Engineering", or "HR Policies".',
        ),
        bullet("Create a space from the wiki home page or the + button in the sidebar"),
        bullet("Each space has a name, optional description, and icon"),
        bullet("Spaces appear in the sidebar under Knowledge Base"),
        heading("Pages"),
        paragraph(
          "Pages are the core content units. Each page has a title, an optional icon, and rich content powered by a block-based editor.",
        ),
        bullet("Pages can be nested under other pages to create a hierarchy (e.g. a parent 'API Reference' with child pages for each endpoint)"),
        bullet("The sidebar shows a collapsible page tree — expand a page to see its children"),
        bullet("Click the three-dot menu on any page in the sidebar to rename, add a subpage, or delete it"),
        heading("The Editor"),
        paragraph(
          "The page editor is a block-based editor similar to Notion. Type / (slash) to insert different block types:",
        ),
        bullet("Headings (H1, H2, H3) for document structure"),
        bullet("Paragraphs for body text"),
        bullet("Bullet lists and numbered lists"),
        bullet("Drag blocks to reorder them"),
        paragraph(
          "Changes auto-save as you type. There's no save button — your edits are persisted automatically.",
        ),
      ],
    },
  });

  // ── Product Guide: Sub-pages ──────────────────────────

  const editingPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      parentId: wikiGuidePage.id,
      title: "Editing & Collaboration",
      icon: "✏️",
      position: 0,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Editing & Collaboration", 1),
        paragraph(
          "The wiki uses a lock-based editing model to prevent conflicts. Only one person can edit a page at a time.",
        ),
        heading("How It Works"),
        numbered('When you want to edit a page, click the "Start Editing" button in the toolbar.'),
        numbered("This acquires an edit lock — other users will see a banner saying the page is being edited by you."),
        numbered('When you\'re done, click "Done Editing" to release the lock. The lock also auto-releases after 2 minutes of inactivity.'),
        heading("Version History"),
        paragraph(
          "The wiki automatically saves version snapshots as you edit. You can also create named versions (like checkpoints) for important milestones.",
        ),
        bullet("Click the History button in the page toolbar to open the version panel"),
        bullet("Browse through auto-saved and named versions"),
        bullet("Preview any version and restore it with one click"),
        bullet("Restoring a version creates a snapshot of the current content first, so nothing is lost"),
      ],
    },
  });

  const commentsPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      parentId: wikiGuidePage.id,
      title: "Comments & Discussions",
      icon: "💬",
      position: 1,
      createdById: bob.id,
      lastEditedById: bob.id,
      content: [
        heading("Comments & Discussions", 1),
        paragraph(
          "You can add inline comments to any wiki page to discuss specific sections of content.",
        ),
        heading("Adding Comments"),
        numbered("Select the text you want to comment on."),
        numbered("Click the comment button that appears."),
        numbered("Type your comment and submit."),
        paragraph(
          "The commented text will be highlighted, and your comment appears in the comments panel on the right side.",
        ),
        heading("Resolving Comments"),
        paragraph(
          "Once a discussion is settled, anyone can resolve the comment. Resolved comments are hidden by default but can be viewed by switching to the 'Resolved' tab in the comments panel.",
        ),
        heading("Mentions"),
        paragraph(
          "Use @mentions in comments to notify specific team members. Type @ followed by their name to get an autocomplete list. Mentioned users will receive a notification.",
        ),
      ],
    },
  });

  const sharingPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      parentId: wikiGuidePage.id,
      title: "Sharing Pages",
      icon: "🔗",
      position: 2,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Sharing Pages", 1),
        paragraph(
          "Share wiki pages with people outside your workspace using public share links. Recipients don't need an account to view the page.",
        ),
        heading("Creating a Share Link"),
        numbered("Open a wiki page and click the Share button in the toolbar."),
        numbered("Click 'Create link' to generate a unique share URL."),
        numbered("Optionally set a password for extra security."),
        numbered("Copy the link and send it to anyone."),
        heading("Managing Shares"),
        bullet("Toggle sharing on/off without deleting the link"),
        bullet("Change or remove the password at any time"),
        bullet("Delete the share link entirely when it's no longer needed"),
        paragraph(
          "Shared pages are read-only. Recipients see the page content in a clean, minimal layout without any app chrome.",
        ),
      ],
    },
  });

  // ── Product Guide: Sub-pages under Projects & Tasks ────

  const boardGuidePage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      parentId: projectsPage.id,
      title: "Board View Guide",
      icon: "🗂️",
      position: 0,
      createdById: bob.id,
      lastEditedById: bob.id,
      content: [
        heading("Board View Guide", 1),
        paragraph(
          "The board view is a Kanban-style layout where tasks are displayed as cards organized into columns. Each column represents a status.",
        ),
        heading("Working with Cards"),
        bullet("Click a card to open the full task detail in a slide-over panel"),
        bullet("Drag and drop cards between columns to change their status"),
        bullet("Drag cards within a column to reorder them"),
        bullet("The card shows the task title, priority badge, assignee avatars, and due date"),
        heading("Customizing Columns"),
        paragraph(
          "Go to Project Settings to manage your status columns. You can:",
        ),
        bullet("Add new columns for additional workflow stages"),
        bullet("Rename or recolor existing columns"),
        bullet("Reorder columns by dragging them"),
        bullet("Mark one column as the 'completion' column — tasks moved here count as done"),
        heading("Filtering & Sorting"),
        paragraph(
          "Use the filter bar above the board to narrow down visible tasks. You can filter by assignee, priority, label, or due date range. Filters persist in the URL, so you can bookmark or share filtered views.",
        ),
      ],
    },
  });

  const notificationsPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      title: "Notifications",
      icon: "🔔",
      position: 7,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Notifications", 1),
        paragraph(
          "Stay informed about what's happening in your workspace with real-time notifications.",
        ),
        heading("What Triggers Notifications"),
        bullet("Task assigned — When someone assigns you to a task"),
        bullet("Status changed — When a task you're assigned to changes status"),
        bullet("Comment added — When someone comments on a task you're assigned to"),
        bullet("Mention — When someone @mentions you in a comment"),
        heading("The Notification Bell"),
        paragraph(
          "Click the bell icon in the top-right corner to see your notifications. Unread notifications are indicated by a badge. Click a notification to navigate directly to the relevant task or page.",
        ),
        heading("Notification Preferences"),
        paragraph(
          "Go to workspace Settings to customize which notifications you receive. You can toggle each notification type on or off independently.",
        ),
        heading("Real-Time Updates"),
        paragraph(
          "The app uses WebSocket connections to deliver notifications and updates instantly. When a teammate updates a task, changes status, or posts a comment, you'll see it reflected immediately without refreshing the page.",
        ),
      ],
    },
  });

  const searchPage = await prisma.wikiPage.create({
    data: {
      spaceId: guideSpace.id,
      title: "Search",
      icon: "🔍",
      position: 8,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Search", 1),
        paragraph(
          "Quickly find anything in your workspace using the search palette.",
        ),
        heading("Opening Search"),
        richParagraph([
          { text: "Press ", italic: false },
          { text: "Cmd+K", bold: true },
          { text: " (Mac) or " },
          { text: "Ctrl+K", bold: true },
          { text: " (Windows/Linux) to open the search palette. You can also click the search bar in the top navigation." },
        ]),
        heading("What You Can Find"),
        bullet("Tasks — Search across all task titles and descriptions in the workspace"),
        bullet("Wiki Pages — Search wiki page titles across all spaces"),
        paragraph(
          "Results appear as you type (minimum 2 characters). Tasks are grouped by project, and wiki pages show their parent space. Click any result to navigate directly to it.",
        ),
      ],
    },
  });

  // ── Engineering Space: Pages ───────────────────────────

  const archPage = await prisma.wikiPage.create({
    data: {
      spaceId: engSpace.id,
      title: "Architecture Overview",
      icon: "🏗️",
      position: 0,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Architecture Overview", 1),
        paragraph(
          "This document describes the high-level architecture of the Werkyn platform.",
        ),
        heading("Tech Stack"),
        bullet("Frontend: React 19, Vite, TanStack Router & Query, Zustand, Tailwind CSS v4"),
        bullet("Backend: Node.js, Fastify 5, Prisma ORM, PostgreSQL"),
        bullet("Shared: Zod schemas used across frontend and backend for type-safe validation"),
        bullet("Real-time: WebSocket via @fastify/websocket with subscription-based broadcasting"),
        heading("Monorepo Structure"),
        paragraph("The codebase is organized as a pnpm monorepo with three packages:"),
        richParagraph([
          { text: "packages/shared", bold: true },
          { text: " — Zod validation schemas, TypeScript types, and constants shared between frontend and backend." },
        ]),
        richParagraph([
          { text: "packages/backend", bold: true },
          { text: " — Fastify HTTP/WebSocket server with Prisma for database access. Organized into feature modules (auth, tasks, projects, wiki, etc.)." },
        ]),
        richParagraph([
          { text: "packages/frontend", bold: true },
          { text: " — React SPA built with Vite. Uses file-based routing (TanStack Router), React Query for server state, and Zustand for client state." },
        ]),
        heading("Key Patterns"),
        bullet("Backend modules follow routes → controller → service layering"),
        bullet("Authorization resolves workspace context from any route param (:wid, :pid, :tid, :sid, :pgid)"),
        bullet("Real-time events are broadcast via broadcastToWorkspace() and broadcastToUser()"),
        bullet("Frontend features are organized into feature folders with api.ts, components/, and hooks/"),
      ],
    },
  });

  const devSetupPage = await prisma.wikiPage.create({
    data: {
      spaceId: engSpace.id,
      title: "Development Setup",
      icon: "💻",
      position: 1,
      createdById: bob.id,
      lastEditedById: bob.id,
      content: [
        heading("Development Setup", 1),
        paragraph(
          "Follow these steps to get the development environment running locally.",
        ),
        heading("Prerequisites"),
        bullet("Node.js 20+"),
        bullet("pnpm 9+"),
        bullet("PostgreSQL 15+"),
        heading("Getting Started"),
        numbered("Clone the repository"),
        numbered("Run pnpm install from the root to install all dependencies"),
        numbered("Copy .env.example to .env in packages/backend and fill in your database URL"),
        numbered("Run npx prisma migrate dev to apply database migrations"),
        numbered("Run npx prisma db seed to populate demo data"),
        numbered("Run pnpm dev from the root to start both backend and frontend"),
        heading("Default Ports"),
        bullet("Backend API: http://localhost:3000"),
        bullet("Frontend dev server: http://localhost:5173"),
        paragraph(
          "The frontend Vite config proxies /api requests to the backend, so everything works through localhost:5173 during development.",
        ),
      ],
    },
  });

  const apiRefPage = await prisma.wikiPage.create({
    data: {
      spaceId: engSpace.id,
      title: "API Reference",
      icon: "📡",
      position: 2,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("API Reference", 1),
        paragraph(
          "All API endpoints are prefixed with /api. Authentication uses JWT Bearer tokens. Most endpoints require authentication and workspace membership.",
        ),
        heading("Authentication"),
        bullet("POST /api/auth/register — Create account"),
        bullet("POST /api/auth/login — Log in, returns access + refresh tokens"),
        bullet("POST /api/auth/refresh — Refresh access token using httpOnly cookie"),
        bullet("POST /api/auth/logout — Invalidate refresh token"),
        heading("Workspaces"),
        bullet("GET /api/workspaces — List user's workspaces"),
        bullet("POST /api/workspaces — Create workspace"),
        bullet("GET /api/workspaces/:wid/search?q= — Search tasks and wiki pages"),
        heading("Projects"),
        bullet("GET /api/workspaces/:wid/projects — List projects"),
        bullet("POST /api/workspaces/:wid/projects — Create project"),
        bullet("GET/PATCH/DELETE /api/projects/:pid — CRUD operations"),
        heading("Tasks"),
        bullet("GET /api/projects/:pid/tasks — List tasks (supports filtering and pagination)"),
        bullet("POST /api/projects/:pid/tasks — Create task"),
        bullet("GET/PATCH/DELETE /api/tasks/:tid — CRUD operations"),
        heading("Wiki"),
        bullet("GET/POST /api/workspaces/:wid/wiki/spaces — List/create spaces"),
        bullet("GET/PATCH/DELETE /api/wiki/spaces/:sid — Space operations"),
        bullet("POST /api/wiki/spaces/:sid/pages — Create page"),
        bullet("GET /api/wiki/spaces/:sid/pages/tree — Page tree (lazy)"),
        bullet("GET/PATCH/DELETE /api/wiki/pages/:pgid — Page operations"),
        bullet("POST/DELETE /api/wiki/pages/:pgid/lock — Edit lock"),
        bullet("GET/POST /api/wiki/pages/:pgid/versions — Version history"),
        bullet("GET/POST /api/wiki/pages/:pgid/comments — Page comments"),
        bullet("GET/POST /api/wiki/pages/:pgid/share — Public sharing"),
      ],
    },
  });

  // Sub-pages under API Reference
  await prisma.wikiPage.create({
    data: {
      spaceId: engSpace.id,
      parentId: apiRefPage.id,
      title: "Authentication Flow",
      icon: "🔐",
      position: 0,
      createdById: alice.id,
      lastEditedById: alice.id,
      content: [
        heading("Authentication Flow", 1),
        paragraph(
          "The app uses a JWT-based authentication system with short-lived access tokens and long-lived refresh tokens.",
        ),
        heading("Token Lifecycle"),
        richParagraph([
          { text: "Access Token", bold: true },
          { text: " — Valid for 15 minutes. Sent as a Bearer token in the Authorization header. Stored in memory (Zustand store), not localStorage." },
        ]),
        richParagraph([
          { text: "Refresh Token", bold: true },
          { text: " — Valid for 7 days. Stored as an httpOnly cookie. Used to obtain new access tokens silently." },
        ]),
        heading("Security Features"),
        bullet("Refresh token rotation — Each refresh issues a new token and invalidates the old one"),
        bullet("Reuse detection — If a rotated token is reused, all tokens for that user are revoked"),
        bullet("Progressive lockout — 5 failed logins → 30s lock, 10 → 5min, 15 → 30min"),
        bullet("Cross-tab sync — Auth state is synchronized across browser tabs via BroadcastChannel"),
      ],
    },
  });

  await prisma.wikiPage.create({
    data: {
      spaceId: engSpace.id,
      parentId: apiRefPage.id,
      title: "WebSocket Events",
      icon: "⚡",
      position: 1,
      createdById: bob.id,
      lastEditedById: bob.id,
      content: [
        heading("WebSocket Events", 1),
        paragraph(
          "The app uses WebSocket connections for real-time updates. Connect to /api/ws and authenticate with your access token.",
        ),
        heading("Connection Flow"),
        numbered("Open WebSocket connection to /api/ws"),
        numbered('Send auth message: { type: "auth", token: "<accessToken>" }'),
        numbered('Receive "authenticated" event on success'),
        numbered('Subscribe to workspaces/projects: { type: "subscribe_workspace", workspaceId }'),
        heading("Task Events"),
        bullet("task_created — New task added to a project"),
        bullet("task_updated — Task properties changed"),
        bullet("task_deleted — Task removed"),
        bullet("task_moved — Task reordered or moved between columns"),
        heading("Wiki Events"),
        bullet("wiki_space_created / wiki_space_updated / wiki_space_deleted"),
        bullet("wiki_page_created / wiki_page_updated / wiki_page_deleted / wiki_page_moved"),
        bullet("wiki_page_locked / wiki_page_unlocked — Edit lock changes"),
        bullet("wiki_comment_created / wiki_comment_resolved"),
        heading("Notification Events"),
        bullet("notification_new — Sent directly to a specific user via broadcastToUser()"),
      ],
    },
  });

  console.log(`  Wiki Spaces: 2`);
  console.log(`  Wiki Pages: ~15`);
  } catch (e) {
    console.log("  Skipping wiki seed (tables may not exist yet — run migrations first)");
  }

  console.log("Seed completed successfully!");
  console.log(`  Users: 5`);
  console.log(`  Workspaces: 2`);
  console.log(`  Projects: 3`);
  console.log(`  Tasks: ~30`);
}

main()
  .catch((e) => {
    if (e instanceof SeedRefused) console.error(`Seed refused: ${e.message}`);
    else console.error("Seed failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
