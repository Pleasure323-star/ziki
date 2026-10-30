import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  hardCodedPlatformRewards,
  parsePlatformRewardConfig,
  type PlatformRewardConfig,
} from "./platform-reward-config";
import {
  parseProjectRewardConfig,
  type ProjectRewardConfig,
} from "./project-rewards";

export {
  hardCodedPlatformRewards,
  parsePlatformRewardConfig,
  parsePlatformRewardConfigFromFormData,
  platformRewardConfigSchema,
  type PlatformRewardConfig,
} from "./platform-reward-config";

type Db = PrismaClient | Prisma.TransactionClient;
const PLATFORM_SETTINGS_ID = "default";

/**
 * Site-wide reward defaults. Missing or unreadable rows fall back to the
 * hard-coded amounts in rules.ts so awards never stall on a config miss.
 */
export async function getPlatformRewardConfig(db: Db): Promise<PlatformRewardConfig> {
  if (!db || !("platformSettings" in db) || !db.platformSettings?.findUnique) {
    return hardCodedPlatformRewards();
  }
  try {
    const row = await db.platformSettings.findUnique({
      where: { id: PLATFORM_SETTINGS_ID },
      select: { rewardConfig: true },
    });
    return parsePlatformRewardConfig(row?.rewardConfig);
  } catch {
    return hardCodedPlatformRewards();
  }
}

export async function savePlatformRewardConfig(
  db: Db,
  config: PlatformRewardConfig,
  updatedById: string | null,
): Promise<PlatformRewardConfig> {
  const parsed = parsePlatformRewardConfig(config);
  await db.platformSettings.upsert({
    where: { id: PLATFORM_SETTINGS_ID },
    create: {
      id: PLATFORM_SETTINGS_ID,
      rewardConfig: parsed as Prisma.InputJsonValue,
      updatedById,
    },
    update: {
      rewardConfig: parsed as Prisma.InputJsonValue,
      updatedById,
    },
  });
  return parsed;
}

/** Project-shaped defaults derived from platform (or hard-coded) amounts. */
export function projectDefaultsFromPlatform(platform: PlatformRewardConfig): ProjectRewardConfig {
  return {
    solver: platform.solver,
    reporter: platform.reporter,
    reviewer: platform.reviewer,
    guidelines: platform.guidelines,
  };
}

/**
 * Effective rewards for a project:
 * project.rewardConfig → platform settings → hard-coded rules.ts.
 */
export async function getProjectRewardConfig(
  db: Db,
  projectId: string | null | undefined,
): Promise<ProjectRewardConfig> {
  const platform = await getPlatformRewardConfig(db);
  const base = projectDefaultsFromPlatform(platform);
  if (!projectId || !db?.project?.findUnique) return base;
  try {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { rewardConfig: true },
    });
    if (!project?.rewardConfig) return base;
    return parseProjectRewardConfig(project.rewardConfig, base);
  } catch {
    return base;
  }
}
